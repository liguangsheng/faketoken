import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Descriptions } from 'antd'
import type { HookAPI as ModalHook } from 'antd/es/modal/useModal'
import type { MessageInstance } from 'antd/es/message/interface'

import { api, type Channel } from '../../../api/client'
import { STATUS } from '../../../utils/format'
import { TEST_PROTOCOLS, withConfigured, type TestProtocol } from './shared'
import type { ModelPickerState } from './ModelPickerModal'

interface Options {
  message: MessageInstance
  modal: ModalHook
  /** Reload the listing only. */
  load: () => Promise<void>
  /** Reload both sides of the archive fold. */
  reloadAll: () => Promise<void>
  /** Patch one row in place, without disturbing the order. */
  setRows: Dispatch<SetStateAction<Channel[]>>
  setSelectedIds: Dispatch<SetStateAction<number[]>>
  /** The current selection; bulk actions read it. */
  selectedIds: number[]
  openDrawer: (channel?: Channel, overrides?: Record<string, unknown>) => void
  /** Open the global log filtered to this channel. */
  viewLogs: (channel: Channel) => void
}

/**
 * Everything a channel row can do, plus the state of whatever it opened.
 *
 * The callbacks are kept here rather than in the page because each of them has
 * to know which list to refresh, which row to patch in place, or which
 * confirmation to raise — details that would otherwise be re-threaded through
 * the table and its columns.
 */
export type ChannelActions = ReturnType<typeof useChannelActions> & {
  openDrawer: Options['openDrawer']
}

export default function useChannelActions({
  message,
  modal,
  load,
  reloadAll,
  setRows,
  setSelectedIds,
  selectedIds,
  openDrawer,
  viewLogs,
}: Options) {
  const [busy, setBusy] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [archivingId, setArchivingId] = useState<number | null>(null)
  const [picker, setPicker] = useState<(ModelPickerState & { channel: Channel }) | null>(null)
  const [testTarget, setTestTarget] = useState<Channel | null>(null)
  // Only used when the clipboard is unavailable, which happens over plain HTTP.
  const [revealed, setRevealed] = useState<{ name: string; text: string } | null>(null)

  const fetchModels = async (channel: Channel) => {
    const hide = message.loading(`正在从「${channel.name}」拉取模型列表…`, 0)
    try {
      const result = await api.admin.fetchModels(channel.id, false)
      hide()
      if (!result.count) {
        message.warning('上游返回了空的模型列表')
        return
      }
      // Preselect exactly what the channel serves today — never everything
      // upstream offers. A blanket selection turns one stray click on 保存
      // into a hundred newly routed models.
      setPicker({
        channel,
        channelName: channel.name,
        models: withConfigured(result.models, channel.models),
        upstream: result.models,
        initial: channel.models,
      })
    } catch (error) {
      hide()
      message.error(error instanceof Error ? error.message : '拉取失败')
    }
  }

  const applyModels = async (models: string[]) => {
    if (!picker) return
    try {
      await api.admin.setChannelModels(picker.channel.id, models)
      message.success(`已为「${picker.channel.name}」配置 ${models.length} 个模型`)
      setPicker(null)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const setStatus = async (channel: Channel, status: number) => {
    setTogglingId(channel.id)
    try {
      await api.admin.setChannelStatus(channel.id, status)
      message.success(status === STATUS.ENABLED ? '渠道已启用' : '渠道已禁用')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingId(null)
    }
  }

  const clearUserAgent = async (channel: Channel, protocol: TestProtocol) => {
    try {
      const updated = await api.admin.clearChannelUserAgent(channel.id, protocol)
      setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
      message.success(
        `${channel.name} 的 ${TEST_PROTOCOLS.find((item) => item.value === protocol)?.label ?? protocol} UA 已清除`,
      )
    } catch (error) {
      message.error(error instanceof Error ? error.message : '清除 UA 失败')
    }
  }

  // saveRouting backs the two editable numbers in the table. It patches the one
  // row instead of reloading: the listing is ordered by priority, and a reload
  // would move the row out from under the cursor mid-edit, which turns tuning a
  // handful of channels into a hunt for where each one went.
  const saveRouting = async (channel: Channel, priority: number, weight: number) => {
    try {
      const updated = await api.admin.setChannelRouting(channel.id, priority, weight)
      setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
      message.success(`「${updated.name}」优先级 ${updated.priority}、权重 ${updated.weight}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  // archiveChannel retires a channel into the collapsed section below. The
  // server disables it in the same transaction, so the confirmation says so
  // outright: archiving a channel that is currently carrying traffic takes it
  // out of rotation, and that must not arrive as a surprise afterwards.
  const archiveChannel = (channel: Channel) => {
    const live = channel.status === STATUS.ENABLED
    modal.confirm({
      title: `归档渠道「${channel.name}」？`,
      content: live
        ? '该渠道当前已启用，归档会同时停用它，指向它的路由立即失效。配置与历史保留，可随时取消归档。'
        : '归档后从上方列表收起到「已归档」，配置与历史保留，可随时取消归档。',
      okText: '归档',
      cancelText: '取消',
      onOk: async () => {
        setArchivingId(channel.id)
        try {
          await api.admin.setChannelArchived(channel.id, true)
          message.success(`「${channel.name}」已归档`)
          await reloadAll()
        } catch (error) {
          message.error(error instanceof Error ? error.message : '归档失败')
        } finally {
          setArchivingId(null)
        }
      },
    })
  }

  // No confirmation: unarchiving restores a row to the listing and nothing
  // else. The channel comes back disabled, which the message states — otherwise
  // the next thing to happen is someone wondering why traffic never moved.
  const unarchiveChannel = async (channel: Channel) => {
    setArchivingId(channel.id)
    try {
      await api.admin.setChannelArchived(channel.id, false)
      message.success(`「${channel.name}」已取消归档，状态仍为禁用`)
      await reloadAll()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '取消归档失败')
    } finally {
      setArchivingId(null)
    }
  }

  const removeChannel = (channel: Channel) => {
    modal.confirm({
      title: `删除渠道「${channel.name}」？`,
      content: '删除后指向该渠道的路由会立即失效，历史日志保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        await api.admin.deleteChannel(channel.id)
        message.success('已删除')
        // Reachable from either table, so refresh both.
        await reloadAll()
      },
    })
  }

  const cloneChannel = async (channel: Channel) => {
    try {
      const clone = await api.admin.cloneChannel(channel.id)
      // The copy points at the same upstream credential, so it is created
      // disabled: enabling it silently would double that upstream's share.
      message.success(`已复制为「${clone.name}」，确认配置后再启用`)
      await load()
      openDrawer(clone)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复制失败')
    }
  }

  // copyCredential puts the upstream connection on the clipboard, in the shape
  // the quick-import box on this same page already understands: address first,
  // key second. Fetched on demand — the listing only ever holds a masked key.
  const copyCredential = async (channel: Channel) => {
    try {
      const cred = await api.admin.channelCredential(channel.id)
      const text = `${cred.base_url}\n${cred.api_key}`
      try {
        await navigator.clipboard.writeText(text)
        message.success(`已复制「${channel.name}」的地址与密钥`)
      } catch {
        // The clipboard API needs a secure context, so it fails over plain
        // HTTP. Show the text rather than leaving the operator with nothing.
        setRevealed({ name: channel.name, text })
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取渠道信息失败')
    }
  }

  const showBalance = async (channel: Channel, kind: 'new-api' | 'sub2api') => {
    const label = kind === 'new-api' ? 'new-api' : 'sub2api'
    const hide = message.loading(`正在通过 ${label} 查询「${channel.name}」的余额…`, 0)
    try {
      const balance =
        kind === 'new-api'
          ? await api.admin.channelBalance(channel.id)
          : await api.admin.channelSub2APIBalance(channel.id)
      hide()
      if (!balance.ok) {
        message.warning(balance.message || '该上游未提供余额接口')
        return
      }
      const money = (value: number | null) =>
        value === null ? '未提供' : `${balance.currency} ${value.toFixed(2)}`
      modal.info({
        title: `「${channel.name}」余额`,
        content: (
          <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
            <Descriptions.Item label="接口类型">{balance.provider}</Descriptions.Item>
            <Descriptions.Item label="剩余">{money(balance.remaining_usd)}</Descriptions.Item>
            <Descriptions.Item label="已用">{money(balance.used_usd)}</Descriptions.Item>
            <Descriptions.Item label="总额度">{money(balance.total_usd)}</Descriptions.Item>
            {balance.plan_name && (
              <Descriptions.Item label="套餐">{balance.plan_name}</Descriptions.Item>
            )}
          </Descriptions>
        ),
      })
    } catch (error) {
      hide()
      message.error(error instanceof Error ? error.message : '查询失败')
    }
  }

  // ------------------------------------------------------------ bulk actions

  const runBulk = async (label: string, action: () => Promise<string>) => {
    setBusy(true)
    try {
      message.success(await action())
      setSelectedIds([])
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : `${label}失败`)
    } finally {
      setBusy(false)
    }
  }

  const bulkStatus = (status: number) =>
    void runBulk(status === STATUS.ENABLED ? '批量启用' : '批量禁用', async () => {
      const result = await api.admin.batchChannelStatus(selectedIds, status)
      return `${status === STATUS.ENABLED ? '已启用' : '已禁用'} ${result.updated} 个渠道`
    })

  const bulkDelete = () => {
    modal.confirm({
      title: `删除选中的 ${selectedIds.length} 个渠道？`,
      content: '删除后指向这些渠道的路由会立即失效，历史日志保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: () =>
        runBulk('批量删除', async () => {
          const result = await api.admin.batchDeleteChannels(selectedIds)
          return `已删除 ${result.deleted} 个渠道`
        }),
    })
  }

  // Not routed through runBulk: testing is read-only, and keeping the
  // selection lets "test, then disable the failures" happen in one pass.
  const bulkTest = async () => {
    setBusy(true)
    const hide = message.loading(`正在测试 ${selectedIds.length} 个渠道…`, 0)
    try {
      const result = await api.admin.batchTestChannels(selectedIds)
      hide()
      const failed = result.data.filter((item) => !item.ok)
      if (failed.length) {
        modal.warning({
          title: `${result.passed}/${result.total} 个渠道通过`,
          width: 640,
          content: (
            <pre className="code-block" style={{ maxHeight: 360 }}>
              {failed
                .map(
                  (item) =>
                    `${item.name || item.channel_id}: ${item.message || `HTTP ${item.status}`}`,
                )
                .join('\n')}
            </pre>
          ),
        })
      }
      message.success(`${result.passed}/${result.total} 个渠道测试通过`)
      await load()
    } catch (error) {
      hide()
      message.error(error instanceof Error ? error.message : '批量测试失败')
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    togglingId,
    archivingId,
    picker,
    setPicker,
    testTarget,
    setTestTarget,
    revealed,
    setRevealed,
    fetchModels,
    applyModels,
    setStatus,
    clearUserAgent,
    saveRouting,
    archiveChannel,
    unarchiveChannel,
    removeChannel,
    cloneChannel,
    copyCredential,
    showBalance,
    bulkStatus,
    bulkDelete,
    bulkTest,
    openDrawer,
    viewLogs,
  }
}
