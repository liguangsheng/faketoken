import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react'
import { Collapse, Space, Table, Tag, Typography } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'

import { api, type Channel } from '../../../api/client'
import { archivedColumns } from './channelColumns'
import type { ChannelActions } from './useChannelActions'

/** Ten rows at a time is enough to find something in a shelf. */
const PAGE_SIZE = 10

export interface ArchivedPanelHandle {
  reload(): Promise<void>
}

interface Props {
  actions: ChannelActions
  /** The row whose unarchive is still running. */
  archivingId: number | null
  message: MessageInstance
  /**
   * Reported upward: the listing's empty state points down here whenever the
   * archive is non-empty, and the panel is hidden while it is empty.
   */
  onTotalChange: (total: number) => void
}

/**
 * Archived channels are configuration worth keeping, not part of what serves
 * traffic, so they should not cost listing space. The panel is absent entirely
 * until something is in it — an empty "已归档（0）" is noise for anyone who has
 * never archived a channel.
 */
const ArchivedPanel = forwardRef<ArchivedPanelHandle, Props>(function ArchivedPanel(
  { actions, archivingId, message, onTotalChange },
  ref,
) {
  const [rows, setRows] = useState<Channel[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  // Rows are only drawn inside the panel, so they wait for its first opening;
  // until then the header's count is all that is fetched. Sticky: folding the
  // panel again keeps them, so reopening does not wait on the network.
  const [wanted, setWanted] = useState(false)

  // Deliberately unfiltered: the boxes above narrow what currently serves
  // traffic, and an archived channel is by definition not that. Keeping the
  // archive out of them is what lets the collapsed header's count mean one
  // thing always. The listing's empty state points down here whenever the
  // archive is non-empty, so a keyword search that misses cannot read as
  // "somebody deleted it".
  const load = useCallback(async () => {
    setLoading(true)
    try {
      // Count only: page_size cannot go below 1, so one row comes back unused.
      const result = await api.admin.listChannels({
        page: wanted ? page : 1,
        page_size: wanted ? PAGE_SIZE : 1,
        archived: true,
      })
      if (wanted) setRows(result.data ?? [])
      setTotal(result.total)
      onTotalChange(result.total)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载已归档渠道失败')
    } finally {
      setLoading(false)
    }
  }, [message, onTotalChange, page, wanted])

  useEffect(() => {
    void load()
  }, [load])

  // Taking the last row off a page would otherwise strand the panel on an empty
  // one, with no control visible to get back.
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (page > pages) setPage(pages)
  }, [page, total])

  const reload = useCallback(async () => {
    await load()
  }, [load])

  useImperativeHandle(ref, () => ({ reload }))

  // Nothing archived is the common case; the caller mounts this unconditionally
  // so the count has somewhere to land.
  if (total === 0) return null

  return (
    <Collapse
      ghost
      style={{ marginTop: 8 }}
      activeKey={open ? ['archived'] : []}
      onChange={(keys) => {
        const next = keys.length > 0
        setOpen(next)
        if (next) setWanted(true)
      }}
      items={[
        {
          key: 'archived',
          label: (
            <Space size={8} wrap>
              <Typography.Text strong>已归档</Typography.Text>
              <Tag style={{ marginInlineEnd: 0 }}>{total}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                均已停用、不参与路由；配置与历史保留
              </Typography.Text>
            </Space>
          ),
          children: (
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={rows}
              scroll={{ x: 620 }}
              pagination={{
                current: page,
                pageSize: PAGE_SIZE,
                total,
                hideOnSinglePage: true,
                showSizeChanger: false,
                showTotal: (count) => `共 ${count} 个已归档渠道`,
                onChange: (next) => setPage(next),
              }}
              columns={archivedColumns({ actions, archivingId })}
            />
          ),
        },
      ]}
    />
  )
})

export default ArchivedPanel
