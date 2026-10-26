import { useState } from 'react'
import { App, Segmented, Table, Tag, Tooltip, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'

import { api, type SessionSummary } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import LoadError from '../../components/LoadError'
import PageHeader from '../../components/PageHeader'
import usePagedList from '../../hooks/usePagedList'
import {
  formatCompact,
  formatNumber,
  formatRelative,
  formatTime,
  formatUSD,
  shortSession,
} from '../../utils/format'

const RANGES = [
  { value: 1, label: '24 小时' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

/**
 * Conversations, one row each. A coding agent's thousand calls are one piece
 * of work, and this is where it reads as one.
 */
export default function Sessions() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [days, setDays] = useState(7)

  const { rows, loading, error, reload, pagination } = usePagedList<SessionSummary>({
    fetcher: ({ page, pageSize }) => api.admin.sessions({ page, page_size: pageSize, days }),
    unit: '会话',
    deps: [days],
    onError: (text) => message.error(text),
  })

  const open = (row: SessionSummary) => navigate(`/admin/sessions/${encodeURIComponent(row.id)}`)

  return (
    <>
      <PageHeader
        title="会话"
        description="同一会话的调用串在一起看：Claude Code、pi 等客户端会标明会话，其余按密钥和对话内容自动串联。"
        extra={
          <Segmented value={days} onChange={(value) => setDays(Number(value))} options={RANGES} />
        }
      />
      <Table
        rowKey="id"
        size="small"
        className="table-clickable"
        loading={loading}
        dataSource={rows}
        pagination={pagination}
        scroll={{ x: 960 }}
        onRow={(row) => ({
          onClick: () => open(row),
          tabIndex: 0,
          'aria-label': `打开会话 ${row.id}`,
          onKeyDown: (event) => {
            if (event.key === 'Enter') open(row)
          },
        })}
        locale={{
          emptyText: error ? (
            <LoadError error={error} onRetry={() => void reload()} />
          ) : (
            <EmptyState
              title="这段时间没有会话"
              description="调用带上会话标识，或同一密钥的多轮对话被串联后，会出现在这里。"
            />
          ),
        }}
        columns={[
          {
            title: '会话',
            dataIndex: 'id',
            width: 200,
            render: (id: string, row) => (
              <div style={{ display: 'grid', gap: 2 }}>
                <Tooltip title={id}>
                  <span className="mono">{shortSession(id)}</span>
                </Tooltip>
                <span>
                  {row.client_type && row.client_type !== 'unknown' && <Tag>{row.client_type}</Tag>}
                  {id.startsWith('~') && (
                    <Tooltip title="客户端没有标明会话，按同一密钥的对话内容串联">
                      <Tag>自动串联</Tag>
                    </Tooltip>
                  )}
                </span>
              </div>
            ),
          },
          { title: '用户', dataIndex: 'username', width: 110 },
          {
            title: '模型',
            dataIndex: 'model',
            width: 200,
            render: (model: string) => (
              <Typography.Text className="mono" ellipsis={{ tooltip: model }} style={{ maxWidth: 190 }}>
                {model}
              </Typography.Text>
            ),
          },
          {
            title: '调用 / 失败',
            dataIndex: 'calls',
            width: 110,
            align: 'right',
            render: (calls: number, row) => (
              <span style={{ whiteSpace: 'nowrap' }}>
                {formatNumber(calls)}
                <span className="text-muted"> / </span>
                <Typography.Text type={row.failures ? 'danger' : 'secondary'}>
                  {formatNumber(row.failures)}
                </Typography.Text>
              </span>
            ),
          },
          {
            title: '线程',
            dataIndex: 'threads',
            width: 70,
            align: 'right',
            render: (threads: number) => (
              <Tooltip title="主线之外，子代理、旁路调用和改过的对话各算一条">
                <span>{formatNumber(threads)}</span>
              </Tooltip>
            ),
          },
          {
            title: 'Token',
            dataIndex: 'total_tokens',
            width: 90,
            align: 'right',
            render: (tokens: number) => formatCompact(tokens),
          },
          {
            title: '消费',
            dataIndex: 'cost',
            width: 100,
            align: 'right',
            render: (cost: number) => formatUSD(cost),
          },
          {
            title: '最近活动',
            dataIndex: 'last_at',
            width: 120,
            render: (last: string, row) => (
              <Tooltip title={`${formatTime(row.first_at)} 至 ${formatTime(last)}`}>
                <span>{formatRelative(last)}</span>
              </Tooltip>
            ),
          },
        ]}
      />
    </>
  )
}
