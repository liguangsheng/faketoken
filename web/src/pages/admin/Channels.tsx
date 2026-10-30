import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  App,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd'
import {
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'

import { api, type Channel, type ChannelHealthMap, type UserGroup } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import LoadError from '../../components/LoadError'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import usePagedList from '../../hooks/usePagedList'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useTableScrollX } from '../../hooks/useTableScrollX'
import { STATUS } from '../../utils/format'
import ArchivedPanel, { type ArchivedPanelHandle } from './channels/ArchivedPanel'
import ChannelDrawer, { type ChannelDraft } from './channels/ChannelDrawer'
import ChannelExpandedRow from './channels/ExpandedRow'
import ModelPickerModal from './channels/ModelPickerModal'
import QuickImportModal from './channels/QuickImportModal'
import TestChannelModal from './channels/TestChannelModal'
import { channelCardColumns } from './channels/channelCards'
import { COLUMN_GEOMETRY, channelColumns } from './channels/channelColumns'
import useChannelActions from './channels/useChannelActions'

export default function Channels() {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const scrollX = useTableScrollX(COLUMN_GEOMETRY)
  // On a phone the table becomes one card per channel: a table that is read
  // by swiping sideways puts the name, the switch and the menu off screen.
  const narrow = useMediaQuery('(max-width: 768px)')
  const [keywordInput, setKeywordInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<number>()
  const [groupFilter, setGroupFilter] = useState<string>()
  const [modelFilterInput, setModelFilterInput] = useState('')
  const [groups, setGroups] = useState<UserGroup[]>([])
  // Recent failures per channel. The lifetime counters on a row only grow, so
  // they cannot tell a channel that is failing now from one that failed last
  // month.
  const [health, setHealth] = useState<ChannelHealthMap>({})
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [rebuilding, setRebuilding] = useState(false)

  // Owned by the panel below, but the empty state above needs the count.
  const [archivedTotal, setArchivedTotal] = useState(0)
  const archivedRef = useRef<ArchivedPanelHandle>(null)

  // What the edit drawer is open on; a fresh object per opening, null closes.
  const [draft, setDraft] = useState<ChannelDraft | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const keyword = useDebouncedValue(keywordInput)
  const modelFilter = useDebouncedValue(modelFilterInput)

  const {
    rows,
    setRows,
    loading,
    error,
    reload: load,
    pagination,
  } = usePagedList<Channel>({
    fetcher: ({ page, pageSize }) =>
      api.admin.listChannels({
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
      }),
    unit: '渠道',
    deps: [keyword, statusFilter, groupFilter, modelFilter],
    onError: (text) => message.error(text),
  })

  // Drop selections that scrolled out of the current result set, so a bulk
  // action can never touch a channel the operator can no longer see.
  useEffect(() => {
    const visible = new Set(rows.map((row) => row.id))
    setSelectedIds((current) => current.filter((id) => visible.has(id)))
  }, [rows])

  // The health report is a separate aggregate over the log; it is fetched
  // alongside the listing so the table never waits for it.
  const loadHealth = useCallback(async () => {
    try {
      const result = await api.admin.channelHealth()
      setHealth(result.data ?? {})
    } catch {
      // A missing health report is not worth an error: the table still works,
      // it just cannot warn.
      setHealth({})
    }
  }, [])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  // Every reload of the listing brings the health report along: the warning
  // is about now, and a page left open goes stale under it.
  const reload = useCallback(async () => {
    await Promise.all([load(), loadHealth()])
  }, [load, loadHealth])

  // Anything that can move a channel across the fold has to refresh both sides,
  // or one of the two lists keeps showing a row that is no longer its own.
  const reloadAll = useCallback(async () => {
    await Promise.all([reload(), archivedRef.current?.reload()])
  }, [reload])

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

  const openDrawer = useCallback(
    (channel?: Channel, overrides?: Record<string, unknown>, unarchiveOnSave?: boolean) =>
      setDraft({ channel, overrides, unarchiveOnSave }),
    [],
  )

  // The log page reads its filters from the address (2.7.1), so this is a
  // plain link to a filtered list.
  const viewLogs = useCallback(
    (channel: Channel) => navigate(`/admin/logs?channel=${channel.id}`),
    [navigate],
  )

  const actions = useChannelActions({
    message,
    modal,
    load: reload,
    reloadAll,
    setRows,
    setSelectedIds,
    selectedIds,
    openDrawer,
    viewLogs,
  })
  const { busy, togglingId, archivingId, picker, setPicker, testTarget, setTestTarget, revealed } =
    actions

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
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
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
          <Button size="small" loading={busy} onClick={() => actions.bulkStatus(STATUS.ENABLED)}>
            批量启用
          </Button>
          <Button size="small" loading={busy} onClick={() => actions.bulkStatus(STATUS.DISABLED)}>
            批量禁用
          </Button>
          <Button
            size="small"
            loading={busy}
            icon={<ThunderboltOutlined />}
            onClick={() => void actions.bulkTest()}
          >
            批量测试
          </Button>
          <Button size="small" danger loading={busy} onClick={actions.bulkDelete}>
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
        scroll={narrow ? undefined : { x: scrollX }}
        className={narrow ? 'channels-table--phone' : undefined}
        rowClassName={(row) => (row.status !== STATUS.ENABLED ? 'row-disabled' : '')}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
        }}
        locale={{
          emptyText: error ? (
            <LoadError error={error} onRetry={() => void reload()} />
          ) : (
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
        pagination={pagination}
        columns={
          narrow
            ? channelCardColumns({ actions, togglingId, health })
            : [...channelColumns({ actions, togglingId, health }), Table.EXPAND_COLUMN]
        }
        expandable={
          narrow
            ? undefined
            : {
                // Placed after the pinned 操作 column, so it is pinned too: a
                // loose column behind a fixed one takes the fixed one's shadow away.
                fixed: 'right',
                expandedRowRender: (row) => (
                  <ChannelExpandedRow row={row} onClearUserAgent={actions.clearUserAgent} />
                ),
              }
        }
      />

      <ArchivedPanel
        ref={archivedRef}
        actions={actions}
        archivingId={archivingId}
        message={message}
        groupOptions={groupOptions}
        onTotalChange={setArchivedTotal}
      />

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

      <TestChannelModal channel={testTarget} onClose={() => setTestTarget(null)} onTested={reload} />

      <QuickImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onApply={(channel, overrides, unarchiveOnSave) => {
          setImportOpen(false)
          openDrawer(channel, overrides, unarchiveOnSave)
        }}
      />

      <ModelPickerModal
        state={picker}
        verb="保存"
        onCancel={() => setPicker(null)}
        onApply={actions.applyModels}
      />

      {/* Shown only when the clipboard API is unavailable, which happens over
          plain HTTP; the operator can still select the text by hand. */}
      <Modal
        open={Boolean(revealed)}
        title={revealed ? `「${revealed.name}」的地址与密钥` : '渠道信息'}
        width={560}
        onCancel={() => actions.setRevealed(null)}
        onOk={() => actions.setRevealed(null)}
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
