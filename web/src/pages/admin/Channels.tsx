import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Dropdown,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  BlockOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  ImportOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  WarningOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import { api, type Channel, type UserGroup } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useTableScrollX, type TableGeometry } from '../../hooks/useTableScrollX'
import { useSettings } from '../../settings/SettingsContext'
import {
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
  STATUS,
  stringifyEffortRules,
  stringifyMapping,
} from '../../utils/format'
import ChannelDrawer, { type ChannelDraft } from './channels/ChannelDrawer'
import InlineNumber from './channels/InlineNumber'
import ModelPickerModal, { type ModelPickerState } from './channels/ModelPickerModal'
import QuickImportModal from './channels/QuickImportModal'
import TestChannelModal from './channels/TestChannelModal'
import {
  AUTH_STYLES,
  keepaliveTag,
  MAX_PRIORITY,
  MAX_WEIGHT,
  MIN_PRIORITY,
  MIN_WEIGHT,
  statusHint,
  TEST_PROTOCOLS,
  withConfigured,
  type TestProtocol,
} from './channels/shared'

/**
 * Breakpoints here were already chosen; what was missing is a `scroll.x` that
 * follows them. Which channel it is and whether it is enabled stay at every
 * width — the status switch is how a bad upstream is taken out of rotation,
 * and that should not require widening the window first.
 *
 * `selection` and `expand` are antd's own columns: rendered on every row but
 * never declared in `columns`, so they are counted here or the sum is short
 * by their width. Both follow the theme's controlHeight of 34.
 */
const COLUMN_GEOMETRY = {
  selection: { width: 34 },
  expand: { width: 48 },
  id: { width: 72 },
  name: { width: 300 },
  status: { width: 104 },
  actions: { width: 72 },
  models: { width: 260, responsive: ['md'] },
  routing: { width: 80, responsive: ['md'] },
  usedQuota: { width: 90, responsive: ['lg'] },
  groups: { width: 100, responsive: ['xl'] },
  health: { width: 120, responsive: ['xl'] },
} satisfies TableGeometry

// The archive is a shelf, not a working list: ten rows at a time is enough to
// find something in it without the panel taking over the page once expanded.
const ARCHIVED_PAGE_SIZE = 10

export default function Channels() {
  const { message, modal } = App.useApp()
  const scrollX = useTableScrollX(COLUMN_GEOMETRY)
  const [rows, setRows] = useState<Channel[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const { defaultPageSize } = useSettings()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [keywordInput, setKeywordInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<number>()
  const [groupFilter, setGroupFilter] = useState<string>()
  const [modelFilterInput, setModelFilterInput] = useState('')
  const [groups, setGroups] = useState<UserGroup[]>([])
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [rebuilding, setRebuilding] = useState(false)

  // The archive has its own rows, count and paging. It is fetched separately
  // rather than sliced out of the listing because the count sits in a collapsed
  // header, which has to be right before anyone expands it.
  const [archivedRows, setArchivedRows] = useState<Channel[]>([])
  const [archivedTotal, setArchivedTotal] = useState(0)
  const [archivedPage, setArchivedPage] = useState(1)
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivingId, setArchivingId] = useState<number | null>(null)

  // What the edit drawer is open on; a fresh object per opening, null closes.
  const [draft, setDraft] = useState<ChannelDraft | null>(null)
  // The channel under test, for the probe dialog.
  const [testTarget, setTestTarget] = useState<Channel | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // The picker that saves straight to a channel; the drawer has its own.
  const [picker, setPicker] = useState<(ModelPickerState & { channel: Channel }) | null>(null)
  // Only used when the clipboard is unavailable, which happens over plain HTTP.
  const [revealed, setRevealed] = useState<{ name: string; text: string } | null>(null)

  const keyword = useDebouncedValue(keywordInput)
  const modelFilter = useDebouncedValue(modelFilterInput)

  useEffect(() => {
    setPage(1)
  }, [keyword, statusFilter, groupFilter, modelFilter])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.admin.listChannels({
        page,
        page_size: pageSize,
        keyword,
        status: statusFilter,
        group: groupFilter,
        model: modelFilter || undefined,
        // The listing is what serves traffic; the archive is folded away below
        // it. Asking for one side explicitly is also what makes the reported
        // total match the rows actually shown.
        archived: false,
      })
      setRows(result.data ?? [])
      setTotal(result.total)
      // Drop selections that scrolled out of the current result set, so a bulk
      // action can never touch a channel the operator can no longer see.
      const visible = new Set((result.data ?? []).map((row) => row.id))
      setSelectedIds((current) => current.filter((id) => visible.has(id)))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [groupFilter, keyword, message, modelFilter, page, pageSize, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  // Deliberately unfiltered: the boxes above narrow what currently serves
  // traffic, and an archived channel is by definition not that. Keeping the
  // archive out of them is what lets the collapsed header's count mean one
  // thing always. The listing's empty state points down here whenever the
  // archive is non-empty, so a keyword search that misses cannot read as
  // "somebody deleted it".
  const loadArchived = useCallback(async () => {
    setArchivedLoading(true)
    try {
      const result = await api.admin.listChannels({
        page: archivedPage,
        page_size: ARCHIVED_PAGE_SIZE,
        archived: true,
      })
      setArchivedRows(result.data ?? [])
      setArchivedTotal(result.total)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载已归档渠道失败')
    } finally {
      setArchivedLoading(false)
    }
  }, [archivedPage, message])

  useEffect(() => {
    void loadArchived()
  }, [loadArchived])

  // Taking the last row off a page would otherwise strand the panel on an empty
  // one, with no control visible to get back.
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(archivedTotal / ARCHIVED_PAGE_SIZE))
    if (archivedPage > pages) setArchivedPage(pages)
  }, [archivedPage, archivedTotal])

  // Anything that can move a channel across the fold has to refresh both sides,
  // or one of the two lists keeps showing a row that is no longer its own.
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), loadArchived()])
  }, [load, loadArchived])

  useEffect(() => {
    api.admin
      .listGroups()
      .then((result) => setGroups(result.data ?? []))
      .catch(() => setGroups([]))
  }, [])

  const groupOptions = useMemo(
    () => groups.map((group) => ({ value: group.name, label: `${group.name}（×${group.rate}）` })),
    [groups],
  )

  const openDrawer = (channel?: Channel, overrides?: Record<string, unknown>) =>
    setDraft({ channel, overrides })

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
      message.success(`${channel.name} 的 ${TEST_PROTOCOLS.find((item) => item.value === protocol)?.label ?? protocol} UA 已清除`)
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
                .map((item) => `${item.name || item.channel_id}: ${item.message || `HTTP ${item.status}`}`)
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

  const clearFilters = () => {
    setKeywordInput('')
    setStatusFilter(undefined)
    setGroupFilter(undefined)
    setModelFilterInput('')
  }

  const filtered = Boolean(keywordInput || statusFilter || groupFilter || modelFilterInput)

  // The listing no longer holds every channel, so an empty table has to say
  // which kind of empty it is. Without the archive pointer, a search that
  // misses an archived channel reads as the channel having been deleted.
  const emptyState = filtered
    ? {
        title: '没有匹配的渠道',
        description:
          archivedTotal > 0
            ? `换个筛选条件试试。另有 ${archivedTotal} 个已归档渠道不参与筛选，展开下方「已归档」查看。`
            : '换个筛选条件试试。',
      }
    : archivedTotal > 0
      ? {
          title: '没有在用的渠道',
          description: `${archivedTotal} 个渠道都已归档，展开下方「已归档」可恢复。`,
        }
      : {
          title: '还没有配置渠道',
          description: '至少需要一个启用的渠道，请求才能被转发出去。',
        }

  return (
    <>
      <PageHeader
        title="渠道管理"
        description="优先级高的渠道先被选中，同优先级内按权重随机；失败会自动切换到下一个渠道。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Tooltip title="按当前渠道配置重建 (分组 × 模型) 路由表">
              <Button
                loading={rebuilding}
                onClick={async () => {
                  setRebuilding(true)
                  try {
                    await api.admin.rebuild()
                    message.success('路由表已重建')
                  } catch (error) {
                    message.error(error instanceof Error ? error.message : '重建失败')
                  } finally {
                    setRebuilding(false)
                  }
                }}
              >
                重建路由
              </Button>
            </Tooltip>
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              快速导入
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
              新建渠道
            </Button>
          </>
        }
      />

      <Space wrap className="filter-bar" size={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder="搜索名称、地址、模型、映射、分组、备注"
          style={{ width: 300 }}
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: STATUS.ENABLED, label: '已启用' },
            { value: STATUS.DISABLED, label: '已禁用' },
          ]}
        />
        <Select
          allowClear
          showSearch
          placeholder="分组"
          style={{ width: 150 }}
          value={groupFilter}
          onChange={setGroupFilter}
          options={groupOptions}
        />
        <Input
          allowClear
          placeholder="按模型搜索，支持片段"
          style={{ width: 180 }}
          value={modelFilterInput}
          onChange={(event) => setModelFilterInput(event.target.value)}
        />
        {filtered && (
          <Button type="link" onClick={clearFilters}>
            重置
          </Button>
        )}
      </Space>

      {selectedIds.length > 0 && (
        <Space wrap size={8} style={{ marginBottom: 12 }}>
          {/* 翻页或改筛选会自动取消不可见行的选择，所以选择永远只覆盖当前页 */}
          <span className="text-muted">已选 {selectedIds.length} 个渠道（仅当前页）</span>
          <Button size="small" loading={busy} onClick={() => bulkStatus(STATUS.ENABLED)}>
            批量启用
          </Button>
          <Button size="small" loading={busy} onClick={() => bulkStatus(STATUS.DISABLED)}>
            批量禁用
          </Button>
          <Button
            size="small"
            loading={busy}
            icon={<ThunderboltOutlined />}
            onClick={() => void bulkTest()}
          >
            批量测试
          </Button>
          <Button size="small" danger loading={busy} onClick={bulkDelete}>
            批量删除
          </Button>
          <Button size="small" type="link" onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </Space>
      )}

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        tableLayout="fixed"
        scroll={{ x: scrollX }}
        rowClassName={(row) => (row.status !== STATUS.ENABLED ? 'row-disabled' : '')}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
        }}
        locale={{
          emptyText: (
            <EmptyState
              // Any active filter counts — a status/group filter with zero hits
              // must not claim there are no channels at all.
              title={emptyState.title}
              description={emptyState.description}
              action={
                filtered ? undefined : (
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
                    新建渠道
                  </Button>
                )
              }
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          // Only hide the bar when even the smallest page size would fit
          // everything: hiding it while the size changer is on would strand
          // anyone who picked a page size larger than the current result set.
          hideOnSinglePage: total <= 10,
          showTotal: (count) => `共 ${count} 个渠道`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            // The id is what the logs show, so it has to be findable here too.
            // No sorter: the list is server-paginated, and reordering one page
            // silently poses as a global ranking.
            ...COLUMN_GEOMETRY.id,
            title: 'ID',
            dataIndex: 'id',
            render: (id: number) => <Tag className="mono" style={{ marginInlineEnd: 0 }}>#{id}</Tag>,
          },
          {
             // Keep this column compact instead of letting it absorb all remaining
             // table width. Long names and addresses still use ellipsis + Tooltip.
            ...COLUMN_GEOMETRY.name,
            title: '渠道',
            dataIndex: 'name',

            render: (name: string, row) => (
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <Tooltip title={name}>
                    <strong
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {name}
                    </strong>
                  </Tooltip>
                </div>
                <div style={{ minWidth: 0 }}>
                  <Tooltip title={row.base_url}>
                    <span
                      className="mono text-muted"
                      style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.base_url}
                    </span>
                  </Tooltip>
                </div>
              </div>
            ),
          },
          {
            // Sits next to the channel it belongs to: what a channel serves is
            // read together with which channel it is, not with the counters.
            // Bounded so the leftover width goes to the channel name — this
            // column only ever shows two counts plus two sample chips.
            //
            // Both counts lead, then the samples: the numbers are what the
            // column is scanned for and they sit at a fixed spot on every row,
            // while the sample chips are ragged and variable.
            //
            // No "+N" tag behind the samples. Once the count leads, a row
            // reading "模型 12" next to two chips already says the list is cut
            // short; a third tag repeating it only crowds the row. The full
            // list it used to carry now hangs off the count itself, which is
            // also what the mapping tag does.
            //
            // Every tag reads "标签 数字": a bare "12 个" needed the header to
            // say what was being counted, which stops working as soon as a
            // second count sits beside it.
            ...COLUMN_GEOMETRY.models,
            title: '模型',
            dataIndex: 'models',
            render: (list: string[], row) => {
              const mapped = Object.keys(row.model_mapping ?? {}).length
              return (
                <div className="tag-list">
                  <Tooltip
                    title={
                      // A hundred-model tooltip is an unreadable wall; the
                      // full list lives in the expanded row.
                      list.length > 20
                        ? `${list.slice(0, 20).join('、')} …等 ${list.length} 个，展开行查看全部`
                        : list.join('、') || '未配置，仅按前缀匹配'
                    }
                  >
                    <Tag color="geekblue">模型 {list.length}</Tag>
                  </Tooltip>
                  {mapped > 0 && (
                    <Tooltip title={stringifyMapping(row.model_mapping)}>
                      <Tag color="purple">映射 {mapped}</Tag>
                    </Tooltip>
                  )}
                  {list.slice(0, 2).map((item) => (
                    <Tooltip key={item} title={item}>
                      <Tag
                        className="mono"
                        style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {item}
                      </Tag>
                    </Tooltip>
                  ))}
                </div>
              )
            },
          },
          {
            // Stacked rather than side by side: two labelled numbers read fine
            // one above the other, and it lets the column be sized for a
            // three-digit value instead of for a pair of tags on one line.
            //
            // The header is abbreviated because it was the only thing keeping
            // the column wide — "优先级" plus the sort arrow costs more than the
            // value it labels. What each line means is in the tag tooltips, and
            // the P/W prefixes carry it at a glance.
            title: (
              <span className="cell-stack">
                <span>优先</span>
                <span>权重</span>
              </span>
            ),
            ...COLUMN_GEOMETRY.routing,
            dataIndex: 'priority',
            render: (priority: number, row) => (
              <div className="cell-stack">
                <InlineNumber
                  value={priority}
                  prefix="P"
                  label="优先级"
                  hint="优先级：数值越大越先被选中。点击可直接修改"
                  color="blue"
                  min={MIN_PRIORITY}
                  max={MAX_PRIORITY}
                  onCommit={(next) => saveRouting(row, next, row.weight)}
                />
                <InlineNumber
                  value={row.weight}
                  prefix="W"
                  label="权重"
                  hint="权重：同优先级内按权重随机分配。点击可直接修改"
                  min={MIN_WEIGHT}
                  max={MAX_WEIGHT}
                  onCommit={(next) => saveRouting(row, row.priority, next)}
                />
              </div>
            ),
          },
          {
            ...COLUMN_GEOMETRY.groups,
            title: '分组',
            dataIndex: 'groups',
            render: (list: string[]) => (
              <div className="tag-list">
                {list?.map((group) => (
                  <Tooltip key={group} title={group}>
                    <Tag
                      style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {group}
                    </Tag>
                  </Tooltip>
                ))}
              </div>
            ),
          },
          {
            // xl, not xxl: channel health is what this table is scanned for,
            // and a 1440px laptop should not have to hide it.
            ...COLUMN_GEOMETRY.health,
            title: '调用 / 失败',
            align: 'right',
            render: (_, row) => {
              const rate = row.request_count ? row.error_count / row.request_count : 0
              return (
                <Tooltip
                  title={
                    row.last_error
                      ? `最近错误：${row.last_error}（${formatRelative(row.last_error_at)}）`
                      : '暂无错误记录'
                  }
                >
                  <Space size={4}>
                    {rate > 0.2 && row.request_count > 5 && (
                      <WarningOutlined
                        style={{ color: 'var(--app-danger)' }}
                        aria-label="高失败率"
                      />
                    )}
                    <span>{formatNumber(row.request_count)}</span>
                    <span className="text-muted">/</span>
                    <Typography.Text type={row.error_count ? 'danger' : 'secondary'}>
                      {formatNumber(row.error_count)}
                    </Typography.Text>
                  </Space>
                </Tooltip>
              )
            },
          },
          {
            ...COLUMN_GEOMETRY.usedQuota,
            title: '消费',
            dataIndex: 'used_quota',
            align: 'right',
            render: (value: number) => formatMoney(value),
          },
          {
            // Sits next to the actions it belongs with, and unlike the other
            // secondary columns it has no breakpoint: this is a control, and
            // taking a bad channel out of rotation should not require widening
            // the window first.
            ...COLUMN_GEOMETRY.status,
            title: '状态',
            dataIndex: 'status',
            render: (_: number, row) => {
              const keepalive = keepaliveTag(row)
              return (
                <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
                  <Tooltip title={statusHint(row)}>
                    {/* A plain span keeps the tooltip anchored while the switch
                        is loading and stops accepting pointer events. */}
                    <span style={{ display: 'inline-flex' }}>
                      <Switch
                        size="small"
                        checked={row.status === STATUS.ENABLED}
                        loading={togglingId === row.id}
                        aria-label={`启用或禁用渠道 ${row.name}`}
                        onChange={(next) =>
                          void setStatus(row, next ? STATUS.ENABLED : STATUS.DISABLED)
                        }
                      />
                    </span>
                  </Tooltip>
                  {/* Under the switch on purpose: this channel's status changes
                      on its own, and without a marker the next operator to look
                      assumes a colleague flipped it. */}
                  {keepalive && (
                    <Tooltip title={keepalive.hint}>
                      <Tag
                        color={keepalive.color}
                        style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}
                      >
                        {keepalive.text}
                      </Tag>
                    </Tooltip>
                  )}
                </div>
              )
            },
          },
          {
            ...COLUMN_GEOMETRY.actions,
            title: '操作',
            render: (_, row) => (
              <Space size={0}>
                <Dropdown
                  menu={{
                    // Editing first, then probes, copies, billing, with deletion
                    // isolated at the end.
                    items: [
                      { key: 'edit', icon: <EditOutlined />, label: '编辑渠道' },
                      { type: 'divider' as const },
                      { key: 'test', icon: <ThunderboltOutlined />, label: '模型测试' },
                      { key: 'models', icon: <CloudDownloadOutlined />, label: '拉取模型' },
                      { type: 'divider' as const },
                      { key: 'credential', icon: <CopyOutlined />, label: '复制地址与密钥' },
                      { key: 'clone', icon: <BlockOutlined />, label: '克隆渠道' },
                      { type: 'divider' as const },
                      { key: 'balance-new-api', icon: <WalletOutlined />, label: 'new-api 余额' },
                      { key: 'balance-sub2api', icon: <WalletOutlined />, label: 'sub2api 余额' },
                      { type: 'divider' as const },
                      // Its own group next to deletion: both retire a channel,
                      // but only one of them is irreversible.
                      { key: 'archive', icon: <InboxOutlined />, label: '归档渠道' },
                      { type: 'divider' as const },
                      { key: 'delete', icon: <DeleteOutlined />, label: '删除渠道', danger: true },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'edit') openDrawer(row)
                      else if (key === 'test') setTestTarget(row)
                      else if (key === 'models') void fetchModels(row)
                      else if (key === 'balance-new-api') void showBalance(row, 'new-api')
                      else if (key === 'balance-sub2api') void showBalance(row, 'sub2api')
                      else if (key === 'credential') void copyCredential(row)
                      else if (key === 'clone') void cloneChannel(row)
                      else if (key === 'archive') archiveChannel(row)
                      else if (key === 'delete') removeChannel(row)
                    },
                  }}
                  trigger={['click']}
                >
                  <Button
                    size="small"
                    type="text"
                    icon={<EllipsisOutlined />}
                    aria-label={`更多操作 ${row.name}`}
                  />
                </Dropdown>
              </Space>
            ),
          },
          Table.EXPAND_COLUMN,
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Row gutter={[12, 12]}>
              <Col xs={24} lg={6}>
                <Card size="small" title="连接">
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Text className="mono" copyable>
                      {row.base_url}
                    </Typography.Text>
                    <span className="mono text-muted">密钥 {row.api_key || '未设置'}</span>
                    {row.proxy_url && <span className="mono text-muted">代理 {row.proxy_url}</span>}
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      超时 {row.timeout_secs ? `${row.timeout_secs}s` : '全局默认'} · 计费倍率 ×
                      {row.price_ratio}
                    </span>
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      渠道重试 {row.retry_count ? `${row.retry_count} 次` : '关闭'} · 间隔{' '}
                      {row.retry_backoff_ms ? `${row.retry_backoff_ms}ms` : '全局默认'}
                    </span>
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      鉴权 {AUTH_STYLES.find((item) => item.value === row.auth_style)?.label ?? row.auth_style}
                    </span>
                    {row.supported_protocols && row.supported_protocols.length < 3 && (
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        协议 {row.supported_protocols
                          .map((p) => TEST_PROTOCOLS.find((t) => t.value === p)?.label ?? p)
                          .join(' / ')}
                      </span>
                    )}
                  </Space>
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card size="small" title={`模型（${row.models.length}）`}>
                  {/* The one place the full list is readable and copyable —
                      the column tooltip only carries a sample. */}
                  {row.models.length ? (
                    <Typography.Paragraph
                      copyable={{ text: row.models.join('\n'), tooltips: ['复制全部模型', '已复制'] }}
                      style={{ marginBottom: 0 }}
                    >
                      <span
                        className="mono"
                        style={{
                          display: 'block',
                          fontSize: 12,
                          lineHeight: 1.8,
                          maxHeight: 120,
                          overflow: 'auto',
                        }}
                      >
                        {row.models.join('\n')}
                      </span>
                    </Typography.Paragraph>
                  ) : (
                    <span className="text-muted">未配置，仅按前缀匹配</span>
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card size="small" title="模型映射">
                  <pre className="code-block" style={{ maxHeight: 120 }}>
                    {stringifyMapping(row.model_mapping) || '未配置'}
                  </pre>
                </Card>
                <Card size="small" title="思考强度映射" style={{ marginTop: 12 }}>
                  <pre className="code-block" style={{ maxHeight: 120 }}>
                    {stringifyEffortRules(row.reasoning_effort_mapping) || '未配置'}
                  </pre>
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card size="small" title="运行状态">
                  <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                    <span>最近测试：{row.tested_at ? formatTime(row.tested_at) : '从未测试'}</span>
                    <span>
                      模型同步：{row.models_synced_at ? formatTime(row.models_synced_at) : '从未同步'}
                    </span>
                    <span style={{ color: row.last_error ? 'var(--app-danger)' : undefined }}>
                      {row.last_error || '无错误记录'}
                    </span>
                    {row.note && <span className="text-muted">备注：{row.note}</span>}
                  </Space>
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card
                  size="small"
                  title="User-Agent 锁定"
                  extra={
                    <Space size={4}>
                      {row.lock_user_agent && <Tag color="green">自动锁定</Tag>}
                      {Object.values(row.locked_user_agents ?? {}).some(Boolean) ? (
                        <Tag color="blue">已有配置</Tag>
                      ) : (
                        <Tag>暂无配置</Tag>
                      )}
                    </Space>
                  }
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    {TEST_PROTOCOLS.map((protocol) => {
                      const value = row.locked_user_agents?.[protocol.value] ?? ''
                      return (
                        <div key={protocol.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <Typography.Text type="secondary" style={{ minWidth: 92 }}>
                            {protocol.label}
                          </Typography.Text>
                          <Typography.Text
                            className="mono"
                            type={value ? undefined : 'secondary'}
                            ellipsis={{ tooltip: value || '尚未锁定' }}
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            {value || '尚未锁定'}
                          </Typography.Text>
                          <Tooltip title={value ? '清除该协议的 UA 配置' : '当前没有可清除的 UA'}>
                            <Button
                              type="text"
                              size="small"
                              danger
                              disabled={!value}
                              icon={<DeleteOutlined />}
                              aria-label={`清除 ${protocol.label} User-Agent`}
                              onClick={() => void clearUserAgent(row, protocol.value)}
                            />
                          </Tooltip>
                        </div>
                      )
                    })}
                  </Space>
                </Card>
              </Col>
            </Row>
          ),
        }}
      />

      {/* Archived channels are configuration worth keeping, not part of what
          serves traffic, so they should not cost listing space. The panel is
          absent entirely until something is in it — an empty "已归档（0）" is
          noise for anyone who has never archived a channel. */}
      {archivedTotal > 0 && (
        <Collapse
          ghost
          style={{ marginTop: 8 }}
          activeKey={archivedOpen ? ['archived'] : []}
          onChange={(keys) => setArchivedOpen(keys.length > 0)}
          items={[
            {
              key: 'archived',
              label: (
                <Space size={8} wrap>
                  <Typography.Text strong>已归档</Typography.Text>
                  <Tag style={{ marginInlineEnd: 0 }}>{archivedTotal}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    均已停用、不参与路由；配置与历史保留
                  </Typography.Text>
                </Space>
              ),
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  loading={archivedLoading}
                  dataSource={archivedRows}
                  scroll={{ x: 620 }}
                  pagination={{
                    current: archivedPage,
                    pageSize: ARCHIVED_PAGE_SIZE,
                    total: archivedTotal,
                    hideOnSinglePage: true,
                    showSizeChanger: false,
                    showTotal: (count) => `共 ${count} 个已归档渠道`,
                    onChange: (next) => setArchivedPage(next),
                  }}
                  columns={[
                    {
                      title: 'ID',
                      dataIndex: 'id',
                      width: 72,
                      render: (id: number) => (
                        <Tag className="mono" style={{ marginInlineEnd: 0 }}>
                          #{id}
                        </Tag>
                      ),
                    },
                    {
                      title: '渠道',
                      dataIndex: 'name',
                      render: (name: string, row) => (
                        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                          <Tooltip title={name}>
                            <strong
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {name}
                            </strong>
                          </Tooltip>
                          <Tooltip title={row.base_url}>
                            <span
                              className="mono text-muted"
                              style={{
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {row.base_url}
                            </span>
                          </Tooltip>
                        </div>
                      ),
                    },
                    {
                      title: '模型',
                      dataIndex: 'models',
                      width: 84,
                      responsive: ['md'],
                      // Same tag wording as the main listing, so the archive
                      // shelf does not read as a different table.
                      render: (list: string[]) => <Tag color="geekblue">模型 {list.length}</Tag>,
                    },
                    {
                      title: '消费',
                      dataIndex: 'used_quota',
                      width: 90,
                      align: 'right',
                      responsive: ['lg'],
                      render: (value: number) => formatMoney(value),
                    },
                    {
                      // Plain buttons rather than the listing's ⋯ menu: three
                      // actions on a short list are better shown than hidden.
                      title: '操作',
                      width: 168,
                      render: (_, row) => (
                        <Space size={0}>
                          <Tooltip title="恢复到上方列表，状态仍为禁用">
                            <Button
                              size="small"
                              type="text"
                              icon={<RollbackOutlined />}
                              loading={archivingId === row.id}
                              onClick={() => void unarchiveChannel(row)}
                            >
                              取消归档
                            </Button>
                          </Tooltip>
                          <Tooltip title="编辑渠道">
                            <Button
                              size="small"
                              type="text"
                              icon={<EditOutlined />}
                              aria-label={`编辑渠道 ${row.name}`}
                              onClick={() => openDrawer(row)}
                            />
                          </Tooltip>
                          <Tooltip title="删除渠道">
                            <Button
                              size="small"
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label={`删除渠道 ${row.name}`}
                              onClick={() => removeChannel(row)}
                            />
                          </Tooltip>
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      )}

      <ChannelDrawer
        draft={draft}
        groupOptions={groupOptions}
        onClose={() => setDraft(null)}
        onSaved={async () => {
          setDraft(null)
          // Both sides: this form is also reachable from the archived panel.
          await reloadAll()
        }}
        onPatched={(updated) =>
          setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
        }
      />

      <TestChannelModal channel={testTarget} onClose={() => setTestTarget(null)} onTested={load} />

      <QuickImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onApply={(channel, overrides) => {
          setImportOpen(false)
          openDrawer(channel, overrides)
        }}
      />

      <ModelPickerModal
        state={picker}
        verb="保存"
        onCancel={() => setPicker(null)}
        onApply={applyModels}
      />

      {/* Shown only when the clipboard API is unavailable, which happens over
          plain HTTP; the operator can still select the text by hand. */}
      <Modal
        open={Boolean(revealed)}
        title={revealed ? `「${revealed.name}」的地址与密钥` : '渠道信息'}
        width={560}
        onCancel={() => setRevealed(null)}
        onOk={() => setRevealed(null)}
        okText="关闭"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Typography.Paragraph
          copyable={{ text: revealed?.text ?? '', tooltips: ['复制', '已复制'] }}
          className="mono"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginBottom: 0 }}
        >
          {revealed?.text}
        </Typography.Paragraph>
      </Modal>
    </>
  )
}
