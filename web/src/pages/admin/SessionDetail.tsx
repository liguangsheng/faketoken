import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, App, Collapse, Select, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import {
  api,
  ApiError,
  type RequestLog,
  type RequestLogDetail,
  type SessionDetail as Session,
  type ThreadSummary,
} from '../../api/client'
import LoadError from '../../components/LoadError'
import PageHeader from '../../components/PageHeader'
import { Conversation } from '../../components/log/Conversation'
import LogDetailDrawer, { type LogDetailHandle } from '../../components/log/LogDetailDrawer'
import StatusTag from '../../components/log/StatusTag'
import { cacheRate } from '../../components/log/tone'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import {
  parseRequestConversation,
  parseResponseConversation,
  type ConversationTurn,
} from '../../utils/conversation'
import {
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  formatTimeShort,
  formatUSD,
  shortSession,
} from '../../utils/format'

const CALLS_PER_PAGE = 50

const threadLabel = (thread: ThreadSummary, busiest: boolean) => {
  const calls = `${formatNumber(thread.calls)} 次调用`
  if (thread.id === 0) return `未串联 · ${calls}`
  if (thread.branch_of > 0) return `分支 · 自 #${thread.branch_of} 第 ${thread.branch_at} 条 · ${calls}`
  return `${busiest ? '主线' : `线程 #${thread.id}`} · ${thread.model} · ${calls}`
}

/**
 * The thread as a transcript: the latest request carries every earlier turn,
 * so it is read once, and each reply is labelled with the call that produced
 * it. Calls whose reply was not kept — a failed attempt, a resend, a side call
 * that copied the conversation — sit beside the reply they stood in for.
 */
interface Transcript {
  turns: ConversationTurn[]
  /** Where the latest call's own reply starts in `turns`. */
  replyAt: number
  /** Turn position → the message indexes whose calls are drawn there. */
  markers: Map<number, number[]>
  producedBy: Map<number, RequestLog>
  attempts: Map<number, RequestLog[]>
  latest: RequestLog
}

function buildTranscript(calls: RequestLog[], latestID: number, detail: RequestLogDetail): Transcript | null {
  const byId = new Map(calls.map((call) => [call.id, call]))
  const latest = byId.get(latestID)
  if (!latest) return null
  const request = parseRequestConversation(detail.request_body) ?? []
  const reply = parseResponseConversation(detail.response_body) ?? []

  // The calls on the way to the latest one: their replies are in its request.
  const main = new Set<number>()
  for (let call: RequestLog | undefined = latest; call && !main.has(call.id); call = byId.get(call.parent_id)) {
    main.add(call.id)
  }

  // A call's reply is the message right after its own request's last one.
  const total = latest.message_count
  const producedBy = new Map<number, RequestLog>()
  const attempts = new Map<number, RequestLog[]>()
  const attempt = (at: number, call: RequestLog) => attempts.set(at, [...(attempts.get(at) ?? []), call])
  for (const call of calls) {
    if (call.id === latest.id) continue
    const at = Math.min(call.message_count, total)
    if (main.has(call.id) && call.message_count < total) {
      const earlier = producedBy.get(at)
      if (earlier) attempt(at, earlier)
      producedBy.set(at, call)
    } else {
      attempt(at, call)
    }
  }

  // Each marker goes ahead of the first turn at or past its message: a
  // message with nothing to show has no turn of its own.
  const markers = new Map<number, number[]>()
  const indexes = [...new Set([...producedBy.keys(), ...attempts.keys()])].sort((a, b) => a - b)
  let position = 0
  for (const index of indexes) {
    while (
      position < request.length &&
      (request[position].index === undefined || request[position].index! < index)
    ) {
      position++
    }
    const at = index >= total ? request.length : position
    markers.set(at, [...(markers.get(at) ?? []), index])
  }

  return { turns: [...request, ...reply], replyAt: request.length, markers, producedBy, attempts, latest }
}

function CallMarker({
  call,
  muted,
  active,
  onOpen,
}: {
  call: RequestLog
  muted?: boolean
  active?: boolean
  onOpen: (call: RequestLog) => void
}) {
  return (
    <div
      id={`call-${call.id}`}
      className={`call-marker${muted ? ' call-marker--muted' : ''}${active ? ' call-marker--active' : ''}`}
    >
      <button type="button" className="call-marker__open mono" onClick={() => onOpen(call)}>
        #{call.id}
      </button>
      <span>{formatTimeShort(call.created_at)}</span>
      <StatusTag
        status={call.status_code}
        upstream={call.upstream_status}
        error={call.error}
        cancelled={call.cancelled}
        style={{ marginInlineEnd: 0 }}
      />
      <span className="mono">{call.model}</span>
      <span>
        输入 {formatCompact(call.prompt_tokens)}
        {call.prompt_tokens > 0 && `（缓存 ${formatPercent(cacheRate(call))}）`}
      </span>
      <span>输出 {formatCompact(call.completion_tokens)}</span>
      <span>{formatUSD(call.cost)}</span>
      <span>{formatDuration(call.duration_ms)}</span>
      {muted && <Tag style={{ marginInlineEnd: 0 }}>未采用</Tag>}
    </div>
  )
}

// On a phone the list sits above a long transcript, so it starts folded.
function CallList({ narrow, count, children }: { narrow: boolean; count: number; children: ReactNode }) {
  if (!narrow) return <div className="session-calls">{children}</div>
  return (
    <Collapse
      size="small"
      items={[{ key: 'calls', label: `调用列表（${formatNumber(count)}）`, children }]}
    />
  )
}

export default function SessionDetail() {
  const { message } = App.useApp()
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const narrow = useMediaQuery('(max-width: 768px)')
  const drawer = useRef<LogDetailHandle>(null)

  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<RequestLog[] | null>(null)
  const [detail, setDetail] = useState<RequestLogDetail | null>(null)
  const [bodyState, setBodyState] = useState<'loading' | 'ready' | 'expired' | 'none'>('loading')
  const [reloads, setReloads] = useState(0)
  const [callPage, setCallPage] = useState(1)

  const activeCall = Number(params.get('call')) || 0
  const threads = useMemo(() => session?.threads ?? [], [session])
  // Unless asked for, the busiest line that has links: the unlinked calls
  // have no transcript to show.
  const thread =
    threads.find((t) => t.id === Number(params.get('thread'))) ??
    threads.find((t) => t.id !== 0) ??
    threads[0]

  useEffect(() => {
    let stale = false
    setError(null)
    api.admin
      .session(id)
      .then((result) => !stale && setSession(result))
      .catch((caught: unknown) => !stale && setError(caught instanceof Error ? caught.message : '加载失败'))
    return () => {
      stale = true
    }
  }, [id, reloads])

  // The thread's calls, then the one body the transcript is read from.
  useEffect(() => {
    if (!thread) return
    let stale = false
    setCalls(null)
    setDetail(null)
    setBodyState(thread.latest_with_body > 0 ? 'loading' : 'none')
    api.admin
      .threadCalls(id, thread.id)
      .then((result) => !stale && setCalls(result.data ?? []))
      .catch((caught: unknown) => !stale && message.error(caught instanceof Error ? caught.message : '加载失败'))
    if (thread.latest_with_body > 0) {
      api.admin
        .logDetail(thread.latest_with_body)
        .then((result) => {
          if (stale) return
          setDetail(result)
          setBodyState('ready')
        })
        .catch((caught: unknown) => {
          if (stale) return
          setBodyState(caught instanceof ApiError && caught.status === 410 ? 'expired' : 'none')
        })
    }
    return () => {
      stale = true
    }
  }, [id, message, thread])

  const transcript = useMemo(
    () =>
      calls && detail && thread && thread.id !== 0
        ? buildTranscript(calls, thread.latest_with_body, detail)
        : null,
    [calls, detail, thread],
  )

  // Arriving from a call's drawer lands on that call, in the transcript and
  // on the page of the list that holds it.
  useEffect(() => {
    if (!calls || !activeCall) return
    const index = calls.findIndex((call) => call.id === activeCall)
    if (index >= 0) setCallPage(Math.floor(index / CALLS_PER_PAGE) + 1)
  }, [activeCall, calls])
  useEffect(() => {
    if (!transcript || !activeCall) return
    requestAnimationFrame(() => {
      document.getElementById(`call-${activeCall}`)?.scrollIntoView({ block: 'center' })
      // The list scrolls on its own; moving it by hand leaves the page alone.
      const list = document.querySelector('.session-calls')
      const row = list?.querySelector('.session-calls__active')
      if (list && row) {
        list.scrollTop +=
          row.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2
      }
    })
  }, [activeCall, callPage, transcript])

  const open = (call: RequestLog) => drawer.current?.open(call)
  // A call with a marker is scrolled to by the effect above; one without
  // (no transcript to place it in) opens in the drawer instead.
  const jump = (call: RequestLog) => {
    if (!document.getElementById(`call-${call.id}`)) open(call)
    setParams(
      (next) => {
        next.set('call', String(call.id))
        return next
      },
      { replace: true },
    )
  }

  const markersAt = (position: number): ReactNode => {
    if (!transcript) return null
    const indexes = transcript.markers.get(position) ?? []
    const nodes: ReactNode[] = []
    for (const index of indexes) {
      for (const call of transcript.attempts.get(index) ?? []) {
        nodes.push(<CallMarker key={call.id} call={call} muted active={call.id === activeCall} onOpen={open} />)
      }
      const call = transcript.producedBy.get(index)
      if (call) nodes.push(<CallMarker key={call.id} call={call} active={call.id === activeCall} onOpen={open} />)
    }
    if (position === transcript.replyAt) {
      const latest = transcript.latest
      nodes.push(<CallMarker key={latest.id} call={latest} active={latest.id === activeCall} onOpen={open} />)
    }
    return nodes.length ? <>{nodes}</> : null
  }

  if (error) return <LoadError error={error} onRetry={() => setReloads((n) => n + 1)} />
  if (!session) return <Skeleton active paragraph={{ rows: 8 }} />
  const summary = session.session

  return (
    <>
      <PageHeader
        title={
          <>
            会话 <span className="mono">{shortSession(summary.id)}</span>
          </>
        }
        description={
          <>
            {summary.username} · {summary.client_type || '未识别的客户端'} ·{' '}
            {formatTime(summary.first_at)} 至 {formatTime(summary.last_at)}（{formatRelative(summary.last_at)}）
          </>
        }
        extra={
          <Space size={12} wrap>
            <Link to="/admin/sessions">全部会话</Link>
            <Link to={`/admin/logs?session=${encodeURIComponent(summary.id)}`}>同会话日志</Link>
          </Space>
        }
      />

      <div className="session-stats">
        <span>{formatNumber(summary.calls)} 次调用</span>
        <Typography.Text type={summary.failures ? 'danger' : 'secondary'}>
          失败 {formatNumber(summary.failures)}
        </Typography.Text>
        <span>{formatCompact(summary.total_tokens)} Token</span>
        <span>{formatUSD(summary.cost)}</span>
        <span>{formatNumber(threads.length)} 条线程</span>
        {threads.length > 1 && thread && (
          <Select
            size="small"
            style={{ minWidth: 320, maxWidth: '100%' }}
            aria-label="选择线程"
            value={thread.id}
            onChange={(value) =>
              setParams(
                (next) => {
                  next.set('thread', String(value))
                  next.delete('call')
                  return next
                },
                { replace: true },
              )
            }
            options={threads.map((t, index) => ({ value: t.id, label: threadLabel(t, index === 0) }))}
          />
        )}
      </div>

      <div className={`session-layout${narrow ? ' session-layout--narrow' : ''}`}>
        <CallList narrow={narrow} count={calls?.length ?? 0}>
          <Table
            rowKey="id"
            size="small"
            className="table-clickable"
            loading={!calls}
            dataSource={calls ?? []}
            pagination={{
              current: callPage,
              onChange: setCallPage,
              pageSize: CALLS_PER_PAGE,
              size: 'small',
              showSizeChanger: false,
              hideOnSinglePage: true,
            }}
            rowClassName={(row) => (row.id === activeCall ? 'session-calls__active' : '')}
            onRow={(row) => ({ onClick: () => jump(row) })}
            columns={[
              {
                title: '调用',
                dataIndex: 'id',
                render: (callID: number, row) => (
                  <div style={{ display: 'grid', gap: 2 }}>
                    <span className="mono">#{callID}</span>
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      {formatTimeShort(row.created_at)}
                    </span>
                  </div>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status_code',
                render: (_: number, row) => (
                  <StatusTag
                    status={row.status_code}
                    upstream={row.upstream_status}
                    error={row.error}
                    cancelled={row.cancelled}
                  />
                ),
              },
              {
                title: '新增',
                dataIndex: 'message_count',
                align: 'right',
                render: (count: number, row) =>
                  row.thread_id === 0 ? (
                    <span className="text-muted">-</span>
                  ) : (
                    <Tooltip title={`共 ${count} 条消息，与 #${row.parent_id || '-'} 相同 ${row.shared_messages} 条`}>
                      <span>+{formatNumber(count - row.shared_messages)}</span>
                    </Tooltip>
                  ),
              },
              {
                title: '消费',
                dataIndex: 'cost',
                align: 'right',
                render: (cost: number) => formatUSD(cost),
              },
            ]}
          />
        </CallList>

        <div className="session-transcript">
          {thread?.id === 0 ? (
            <Alert
              type="info"
              showIcon
              message="这些调用没有串联"
              description="串联要比对请求正文：这些调用的正文已滚出保留范围，或者刚升级时后台还在补算。可以在左侧逐条打开。"
            />
          ) : bodyState === 'loading' || (bodyState === 'ready' && !transcript) ? (
            <Skeleton active paragraph={{ rows: 10 }} />
          ) : bodyState !== 'ready' ? (
            <Alert
              type="info"
              showIcon
              message="这条线程的正文都已滚出保留范围"
              description="调用记录还在左侧；会话内容需要正文才能还原。"
            />
          ) : (
            transcript && (
              <>
                <Conversation turns={transcript.turns} before={(_, position) => markersAt(position)} />
                {transcript.replyAt === transcript.turns.length && markersAt(transcript.replyAt)}
              </>
            )
          )}
        </div>
      </div>

      <LogDetailDrawer ref={drawer} admin narrow={narrow} siblings={calls ?? []} />
    </>
  )
}
