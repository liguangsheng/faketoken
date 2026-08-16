import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'

import { api, type Page, type RequestLog, type RequestLogDetail } from '../api/client'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useLogStream } from '../hooks/useLogStream'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useSettings } from '../settings/SettingsContext'
import EmptyState from './EmptyState'
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
  formatTimeShort,
  formatUSD,
} from '../utils/format'

type RangeValue = [Dayjs | null, Dayjs | null] | null

interface Props {
  admin?: boolean
  fetcher: (params: Record<string, unknown>) => Promise<Page<RequestLog>>
  extra?: ReactNode
}

const statusTone = (code: number) => (code < 400 ? 'green' : code < 500 ? 'orange' : 'red')

// Only the named levels get a colour; a token budget stays neutral because
// "16k tokens" carries no ordering against "high".
const REASONING_TONE: Record<string, string> = {
  minimal: 'default',
  low: 'blue',
  medium: 'gold',
  high: 'red',
}

/** Share of the input that came from cache. Zero input means zero rate. */
const cacheRate = (entry: RequestLog) =>
  entry.prompt_tokens > 0 ? entry.cached_tokens / entry.prompt_tokens : 0

export default function LogTable({ admin, fetcher, extra }: Props) {
  const { message } = App.useApp()
  // A Drawer is not clamped to the viewport the way a Modal is.
  const narrow = useMediaQuery('(max-width: 768px)')
  const [rows, setRows] = useState<RequestLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { defaultPageSize } = useSettings()
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [keywordInput, setKeywordInput] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [usernameInput, setUsernameInput] = useState('')
  const [channelInput, setChannelInput] = useState('')
  const [onlyError, setOnlyError] = useState(false)
  const [range, setRange] = useState<RangeValue>(null)
  const [live, setLive] = useState(true)
  const [detail, setDetail] = useState<RequestLog | null>(null)
  // The bodies live in a separate table with its own retention window, so they
  // are fetched when a row is opened and may legitimately be gone.
  const [bodies, setBodies] = useState<RequestLogDetail | null>(null)
  const [bodiesState, setBodiesState] = useState<'idle' | 'loading' | 'expired' | 'failed'>('idle')

  const openDetail = (row: RequestLog) => {
    setDetail(row)
    setBodies(null)
    // Only the administrator surface serves them; asking as a regular user
    // would just draw a 403.
    if (!admin) {
      setBodiesState('idle')
      return
    }
    setBodiesState('loading')
    api.admin
      .logDetail(row.id)
      .then((result) => {
        setBodies(result)
        setBodiesState('idle')
      })
      .catch((error: unknown) => {
        // 410 is the ordinary outcome for anything past the window, so it is
        // reported as a state rather than as an error.
        const gone = error instanceof Error && error.message.includes('保留范围')
        setBodiesState(gone ? 'expired' : 'failed')
      })
  }

  const keyword = useDebouncedValue(keywordInput)
  const model = useDebouncedValue(modelInput)
  const username = useDebouncedValue(usernameInput)
  const channelID = useDebouncedValue(channelInput)

  // Any filter change invalidates the current page number.
  useEffect(() => {
    setPage(1)
  }, [keyword, model, username, channelID, onlyError, range])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetcher({
        page,
        page_size: pageSize,
        keyword: keyword || undefined,
        model: model || undefined,
        username: admin && username ? username : undefined,
        // The backend has always supported this filter; now that the table
        // shows ids, it is finally useful.
        channel_id: Number(channelID) > 0 ? Number(channelID) : undefined,
        only_error: onlyError || undefined,
        start: range?.[0]?.toISOString(),
        end: range?.[1]?.toISOString(),
      })
      setRows(result.data ?? [])
      setTotal(result.total)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [
    admin,
    channelID,
    fetcher,
    keyword,
    message,
    model,
    onlyError,
    page,
    pageSize,
    range,
    username,
  ])

  useEffect(() => {
    void load()
  }, [load])

  // The stream carries the same filters as the list, so what arrives live is
  // what a reload would show. A time range is the exception: it bounds history,
  // while the feed is always "now".
  const streamURL = useMemo(() => {
    const params = new URLSearchParams()
    // Carried into the feed too, so a live row appears only when it matches
    // what is on screen.
    if (keyword) params.set('keyword', keyword)
    if (model) params.set('model', model)
    if (admin && username) params.set('username', username)
    if (Number(channelID) > 0) params.set('channel_id', channelID)
    if (onlyError) params.set('only_error', 'true')
    const query = params.toString()
    return `${admin ? '/api/admin/logs/stream' : '/api/logs/stream'}${query ? `?${query}` : ''}`
  }, [admin, channelID, keyword, model, onlyError, username])

  // Live only makes sense on the first page of a "newest first" list: on any
  // other page every arrival would shift the rows the user is reading. Nothing
  // is lost — the counter says how many piled up, and page 1 is one click away.
  const canStream = live && page === 1 && !range
  const [pending, setPending] = useState(0)

  const streamState = useLogStream({
    url: streamURL,
    enabled: live && !range,
    onEntry: (entry) => {
      if (page !== 1) {
        setPending((count) => count + 1)
        return
      }
      setRows((current) => {
        // The list request may already have returned this row; the stream and
        // the initial fetch race by design.
        if (current.some((row) => row.id === entry.id)) return current
        return [entry, ...current].slice(0, pageSize)
      })
      setTotal((count) => count + 1)
    },
  })

  // Returning to the first page adopts whatever accumulated while away.
  useEffect(() => {
    if (page === 1 && pending > 0) {
      setPending(0)
      void load()
    }
  }, [load, page, pending])

  const dirty = Boolean(
    keywordInput || modelInput || usernameInput || channelInput || onlyError || range,
  )

  const presets = useMemo(
    () => [
      { label: '最近 1 小时', value: [dayjs().subtract(1, 'hour'), dayjs()] as [Dayjs, Dayjs] },
      { label: '今天', value: [dayjs().startOf('day'), dayjs()] as [Dayjs, Dayjs] },
      { label: '最近 7 天', value: [dayjs().subtract(7, 'day'), dayjs()] as [Dayjs, Dayjs] },
      { label: '最近 30 天', value: [dayjs().subtract(30, 'day'), dayjs()] as [Dayjs, Dayjs] },
    ],
    [],
  )

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }} size={8}>
        <Input
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder="搜索 ID、用户、密钥、模型、渠道、接口、IP、错误"
          style={{ width: 300 }}
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <Input
          allowClear
          placeholder="按模型过滤"
          style={{ width: 180 }}
          value={modelInput}
          onChange={(event) => setModelInput(event.target.value)}
        />
        {admin && (
          <Input
            allowClear
            placeholder="按用户名过滤"
            style={{ width: 160 }}
            value={usernameInput}
            onChange={(event) => setUsernameInput(event.target.value)}
          />
        )}
        <Input
          allowClear
          placeholder="按渠道 ID"
          style={{ width: 120 }}
          value={channelInput}
          onChange={(event) => setChannelInput(event.target.value.replace(/\D/g, ''))}
        />
        <Select
          value={onlyError}
          style={{ width: 120 }}
          onChange={setOnlyError}
          options={[
            { value: false, label: '全部请求' },
            { value: true, label: '仅失败' },
          ]}
        />
        <DatePicker.RangePicker
          showTime={{ format: 'HH:mm' }}
          format="MM-DD HH:mm"
          value={range}
          presets={presets}
          onChange={(value) => setRange(value as RangeValue)}
          style={{ width: 300 }}
        />
        {dirty && (
          <Button
            type="link"
            onClick={() => {
              setKeywordInput('')
              setModelInput('')
              setUsernameInput('')
              setChannelInput('')
              setOnlyError(false)
              setRange(null)
            }}
          >
            重置
          </Button>
        )}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        <Tooltip
          title={
            range
              ? '选择了时间范围，实时推送已暂停'
              : '由服务端推送新记录，无需轮询'
          }
        >
          <Space size={6}>
            <Switch size="small" checked={live} disabled={Boolean(range)} onChange={setLive} />
            <Badge
              status={
                !live || range ? 'default' : streamState === 'live' ? 'processing' : 'warning'
              }
              text={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {!live || range
                    ? '实时推送'
                    : streamState === 'live'
                      ? canStream
                        ? '实时推送中'
                        : '已暂停（非首页）'
                      : '连接中…'}
                </Typography.Text>
              }
            />
          </Space>
        </Tooltip>
        {pending > 0 && (
          <Button type="link" size="small" onClick={() => setPage(1)}>
            有 {pending} 条新记录
          </Button>
        )}
        {extra}
      </Space>

      <Table
        rowKey="id"
        size="small"
        className="table-clickable"
        loading={loading}
        dataSource={rows}
        // Must cover the sum of the column widths below, taking the admin view
        // (which adds the 用户 column) as the widest case. A smaller value makes
        // the browser shrink every column to fit, and the crushed cells collide
        // instead of scrolling.
        scroll={{ x: 1530 }}
        onRow={(row) => ({ onClick: () => openDetail(row) })}
        locale={{
          emptyText: (
            <EmptyState
              title="没有匹配的调用记录"
              description={dirty ? '试试放宽筛选条件或时间范围。' : '发起一次请求后这里就会有记录。'}
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (count) => `共 ${formatNumber(count)} 条`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            // The id identifies the row and the timestamp places it; they are
            // read together and neither needs a column of its own.
            //
            // Absolute time, not relative: a log is read to line events up
            // against an incident, and "3 分钟前" cannot be compared with
            // anything.
            title: '时间 / ID',
            dataIndex: 'created_at',
            width: 150,
            render: (value: string, row: RequestLog) => (
              <Tooltip title={formatTime(value)}>
                <div className="cell-stack">
                  <span className="mono">{formatTimeShort(value)}</span>
                  <span className="mono text-muted cell-stack__sub">#{row.id}</span>
                </div>
              </Tooltip>
            ),
          },
          {
            // The id is what stays stable and short; the name is a label that
            // can be renamed out from under a log entry, so it goes in the
            // tooltip where it costs no width.
            title: '渠道',
            dataIndex: 'channel_id',
            width: 80,
            render: (id: number, row: RequestLog) =>
              id > 0 ? (
                <Tooltip title={row.channel_name || `渠道 #${id}`}>
                  <Tag className="mono">#{id}</Tag>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
          {
            // Who called, and with which of their keys. On the user's own page
            // the account is implied, so only the key is worth the space.
            title: admin ? '用户 / 密钥' : '密钥',
            dataIndex: 'token_name',
            width: 130,
            render: (tokenName: string, row: RequestLog) => (
              <div className="cell-stack">
                {admin && <span>{row.username || '-'}</span>}
                <span className={admin ? 'text-muted cell-stack__sub' : undefined}>
                  {tokenName || '-'}
                </span>
              </div>
            ),
          },
          {
            // A mapped model is shown as "asked → sent". Collapsing the two
            // into one name hides the rewrite, which is exactly the thing you
            // are looking for when a model behaves unlike its name.
            title: '模型 / 思考强度',
            dataIndex: 'model',
            width: 240,
            render: (value: string, row: RequestLog) => {
              const mapped = row.upstream_model && row.upstream_model !== value
              return (
                <Tooltip
                  title={mapped ? `客户端请求 ${value}，实际转发 ${row.upstream_model}` : value}
                >
                  {/* nowrap is deliberate: a model name broken across lines
                      cannot be compared against its neighbours at a glance. */}
                  <div className="cell-stack">
                    <span className="mono">
                      {value}
                      {mapped && <span className="text-muted"> → {row.upstream_model}</span>}
                    </span>
                    {row.reasoning_effort ? (
                      <span className="cell-stack__sub">
                        <Tag
                          color={REASONING_TONE[row.reasoning_effort] ?? 'default'}
                          style={{ marginInlineEnd: 0, lineHeight: '16px' }}
                        >
                          {row.reasoning_effort}
                        </Tag>
                      </span>
                    ) : (
                      <span className="text-muted cell-stack__sub">未指定思考强度</span>
                    )}
                  </div>
                </Tooltip>
              )
            },
          },
          {
            title: '客户端',
            dataIndex: 'client_type',
            width: 110,
            responsive: ['lg'],
            ellipsis: true,
            render: (type: string) =>
              type && type !== 'unknown' ? (
                <Tag>{type}</Tag>
              ) : (
                <span className="text-muted">未知</span>
              ),
          },
          {
            title: '来源 IP',
            dataIndex: 'client_ip',
            width: 130,
            responsive: ['xl'],
            ellipsis: true,
            render: (value: string) =>
              value ? (
                <Tooltip title={value}>
                  <span className="mono">{value}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
          {
            title: '状态',
            dataIndex: 'status_code',
            width: 120,
            render: (code: number, row: RequestLog) => (
              <Space size={4}>
                <Tag color={statusTone(code)}>{code}</Tag>
                {/* Streaming used to be its own column; it is one bit, so it
                    rides along with the status it qualifies. */}
                {row.stream && (
                  <Tooltip title="流式响应">
                    <Tag color="blue">流</Tag>
                  </Tooltip>
                )}
                {row.retries > 0 && (
                  <Tooltip title={`切换了 ${row.retries} 次渠道`}>
                    <Tag color="gold">×{row.retries + 1}</Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          {
            // Total and time-to-first-byte side by side: for a streamed reply
            // the wait before the first token is what the caller actually
            // feels, while the total is mostly a function of answer length.
            title: (
              <Tooltip title="总耗时 / 首字时间">
                <span>耗时 / 首字</span>
              </Tooltip>
            ),
            dataIndex: 'duration_ms',
            width: 150,
            align: 'right',
            render: (value: number, row: RequestLog) => (
              <Tooltip
                title={
                  row.ttfb_ms > 0
                    ? `总耗时 ${formatDuration(value)} · 首字 ${formatDuration(row.ttfb_ms)}`
                    : `总耗时 ${formatDuration(value)}`
                }
              >
                <span className="mono">
                  {formatDuration(value)}
                  {row.ttfb_ms > 0 && (
                    <span className="text-muted"> / {formatDuration(row.ttfb_ms)}</span>
                  )}
                </span>
              </Tooltip>
            ),
          },
          {
            // Input / output / total spelled out. The cache breakdown lives in
            // the detail drawer, where there is room to explain it.
            title: 'Tokens',
            width: 170,
            render: (_: unknown, row: RequestLog) => (
              <span className="mono">
                {formatNumber(row.prompt_tokens)} → {formatNumber(row.completion_tokens)}
                <span className="text-muted"> / {formatNumber(row.total_tokens)}</span>
              </span>
            ),
          },
          {
            title: '费用',
            dataIndex: 'cost',
            width: 100,
            align: 'right',
            render: (value: number) => formatUSD(value),
          },
          {
            title: '错误',
            dataIndex: 'error',
            ellipsis: true,
            render: (value: string) =>
              value ? (
                <Tooltip title={value}>
                  <span style={{ color: 'var(--app-danger)' }}>{value}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
        ]}
      />

      <Drawer
        className="detail-drawer"
        open={Boolean(detail)}
        // Wider than the metadata alone needs: request bodies are the reason
        // this drawer is opened, and they read badly in a narrow column.
        width={narrow ? '100%' : admin ? 860 : 560}
        title="调用详情"
        onClose={() => setDetail(null)}
      >
        {detail && admin && (
          <Tabs
            style={{ marginBottom: 16 }}
            items={[
              { key: 'meta', label: '概览' },
              { key: 'request', label: '请求正文' },
              { key: 'response', label: '响应正文' },
            ].map((tab) => ({
              ...tab,
              children:
                tab.key === 'meta' ? (
                  <LogMeta detail={detail} admin={admin} />
                ) : (
                  <LogBody
                    kind={tab.key === 'request' ? 'request' : 'response'}
                    state={bodiesState}
                    bodies={bodies}
                  />
                ),
            }))}
          />
        )}
        {detail && !admin && <LogMeta detail={detail} admin={admin} />}
      </Drawer>
    </>
  )
}

// LogBody shows one side of a call. The bodies are held for a limited number
// of recent calls, so "not here" is a normal outcome and is spelled out rather
// than shown as an empty panel.
function LogBody({
  kind,
  state,
  bodies,
}: {
  kind: 'request' | 'response'
  state: 'idle' | 'loading' | 'expired' | 'failed'
  bodies: RequestLogDetail | null
}) {
  const { settings } = useSettings()

  if (state === 'loading') return <Skeleton active paragraph={{ rows: 6 }} />
  if (state === 'expired') {
    return (
      <Alert
        type="info"
        showIcon
        message="这次调用的正文已不再保留"
        description={`只保留最近 ${formatNumber(settings.log_detail_keep)} 次调用的完整正文，这条已经滚出该范围。可在「全局设置 → 完整日志」调整条数。`}
      />
    )
  }
  if (state === 'failed') return <Alert type="error" showIcon message="加载正文失败" />
  if (!bodies) {
    return (
      <Alert
        type="info"
        showIcon
        message="未记录正文"
        description="完整日志当前处于关闭状态，可在「全局设置 → 完整日志」开启。"
      />
    )
  }

  const headers = kind === 'request' ? bodies.request_headers : bodies.response_headers
  const body = kind === 'request' ? bodies.request_body : bodies.response_body
  const truncated = kind === 'request' ? bodies.request_truncated : bodies.response_truncated

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          message={`正文超过 ${formatBytes(settings.log_body_limit)}，已截断或省略`}
          description="上限可在「全局设置 → 正文捕获」调整。"
        />
      )}
      <Typography.Text strong>
        {kind === 'request' ? '请求头' : '响应头'}
        <span className="text-muted">（敏感字段已脱敏）</span>
      </Typography.Text>
      <pre className="code-block">{JSON.stringify(headers ?? {}, null, 2)}</pre>
      <Space size={8}>
        <Typography.Text strong>{kind === 'request' ? '请求正文' : '响应正文'}</Typography.Text>
        {body && (
          <Typography.Text
            copyable={{ text: body, tooltips: ['复制正文', '已复制'] }}
            style={{ marginBottom: 0 }}
          />
        )}
      </Space>
      <pre className="code-block" style={{ maxHeight: '52vh' }}>
        {body || '（空）'}
      </pre>
    </Space>
  )
}

// LogMeta renders the metadata a log row already carries; no fetch needed.
function LogMeta({ detail, admin }: { detail: RequestLog; admin?: boolean }) {
  return (
    <Descriptions column={1} size="small" bordered>
      <Descriptions.Item label="ID">
        <span className="mono">{detail.id}</span>
      </Descriptions.Item>
      <Descriptions.Item label="时间">{formatTime(detail.created_at)}</Descriptions.Item>
      {admin && <Descriptions.Item label="用户">{detail.username}</Descriptions.Item>}
      <Descriptions.Item label="密钥">{detail.token_name || '-'}</Descriptions.Item>
      <Descriptions.Item label="接口">
        <span className="mono">{detail.endpoint}</span>
      </Descriptions.Item>
      <Descriptions.Item label="请求模型">
        <span className="mono">{detail.model}</span>
      </Descriptions.Item>
      <Descriptions.Item label="上游模型">
        <span className="mono">{detail.upstream_model || detail.model}</span>
      </Descriptions.Item>
      <Descriptions.Item label="渠道">
        {detail.channel_id > 0 ? (
          <>
            <Tag className="mono">#{detail.channel_id}</Tag>
            {detail.channel_name || '（已删除）'}
          </>
        ) : (
          '-'
        )}
        {detail.retries > 0 && (
          <Tag color="gold" style={{ marginInlineStart: 8 }}>
            重试 {detail.retries} 次
          </Tag>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="状态码">
        <Tag color={statusTone(detail.status_code)}>{detail.status_code}</Tag>
        {detail.stream ? <Tag color="blue">流式</Tag> : <Tag>非流式</Tag>}
      </Descriptions.Item>
      <Descriptions.Item label="思考强度">
        {detail.reasoning_effort ? (
          <Tag color={REASONING_TONE[detail.reasoning_effort] ?? 'default'}>
            {detail.reasoning_effort}
          </Tag>
        ) : (
          <span className="text-muted">未指定</span>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="客户端">
        {detail.client_type && detail.client_type !== 'unknown' ? (
          <Tag>{detail.client_type}</Tag>
        ) : (
          <span className="text-muted">未识别</span>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="来源 IP">
        {detail.client_ip ? (
          <Tooltip title="来自 X-Forwarded-For；直连本服务的调用方可以自行设置该头，仅供参考">
            <span className="mono">{detail.client_ip}</span>
          </Tooltip>
        ) : (
          <span className="text-muted">-</span>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Token 用量">
        输入 {formatNumber(detail.prompt_tokens)} · 输出{' '}
        {formatNumber(detail.completion_tokens)} · 合计 {formatNumber(detail.total_tokens)}
      </Descriptions.Item>
      <Descriptions.Item label="缓存命中">
        {formatNumber(detail.cached_tokens)}
        <span className="text-muted"> / {formatNumber(detail.prompt_tokens)} 输入</span>
      </Descriptions.Item>
      <Descriptions.Item label="缓存率">
        <Tooltip title="缓存命中的输入 token 占全部输入的比例；命中部分按缓存价计费">
          <span>{formatPercent(cacheRate(detail))}</span>
        </Tooltip>
      </Descriptions.Item>
      <Descriptions.Item label="缓存创建">
        <Tooltip title="写入缓存的输入 token，已计入输入总数；上游通常按高于普通输入的价格计费">
          <span>{formatNumber(detail.cache_creation_tokens)}</span>
        </Tooltip>
      </Descriptions.Item>
      <Descriptions.Item label="费用">{formatUSD(detail.cost, 6)}</Descriptions.Item>
      <Descriptions.Item label="耗时">
        总计 {formatDuration(detail.duration_ms)}
        {detail.ttfb_ms > 0 && ` · 首字节 ${formatDuration(detail.ttfb_ms)}`}
      </Descriptions.Item>
      <Descriptions.Item label="错误">
        {detail.error ? (
          <Typography.Paragraph
            copyable={{ text: detail.error }}
            style={{ color: 'var(--app-danger)', marginBottom: 0, whiteSpace: 'pre-wrap' }}
          >
            {detail.error}
          </Typography.Paragraph>
        ) : (
          <span className="text-muted">无</span>
        )}
      </Descriptions.Item>
    </Descriptions>
  )
}
