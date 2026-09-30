import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  App,
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
} from 'antd'
import {
  ClearOutlined,
  CopyOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { Link } from 'react-router-dom'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import EmptyState from '../components/EmptyState'
import ApiKeyField, { useSavedKeys } from '../components/playground/ApiKeyField'
import { callTarget, normalizeHost } from '../components/playground/target'
import PageHeader from '../components/PageHeader'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { copyTextToClipboard } from '../utils/clipboard'
import { formatDuration, formatNumber } from '../utils/format'

const HOST_STORAGE = 'faketoken-playground-host'
const PROTOCOL_STORAGE = 'faketoken-playground-protocol'
const PROXY_STORAGE = 'faketoken-playground-proxy'

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface Metrics {
  ttfbMs: number
  totalMs: number
  chars: number
  usage: Usage | null
  aborted: boolean
}

type ModelsState = 'loading' | 'ready' | 'error' | 'need-key'

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Walks a path of keys, giving up quietly on anything unexpected. */
const dig = (value: unknown, ...path: string[]): unknown => {
  let current = value
  for (const key of path) {
    if (!isDict(current)) return undefined
    current = current[key]
  }
  return current
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asText = (value: unknown): string => (typeof value === 'string' ? value : '')
const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const openAIUsage = (value: unknown): Usage | null => {
  if (!isDict(value)) return null
  const prompt = asCount(value.prompt_tokens)
  const completion = asCount(value.completion_tokens)
  if (prompt === undefined && completion === undefined) return null
  return {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(completion === undefined ? {} : { completion_tokens: completion }),
  }
}

/** Both native dialects count as input/output rather than prompt/completion. */
const nativeUsage = (value: unknown): Usage | null => {
  if (!isDict(value)) return null
  const prompt = asCount(value.input_tokens)
  const completion = asCount(value.output_tokens)
  if (prompt === undefined && completion === undefined) return null
  return {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(completion === undefined ? {} : { completion_tokens: completion }),
  }
}

/**
 * Folds in what a frame reported without letting it erase what it did not
 * mention: Anthropic sends the input count on the opening frame and the output
 * count on the closing one, so a plain overwrite would lose half the total.
 */
const mergeUsage = (base: Usage | null, next: Usage | null): Usage | null => {
  if (!next) return base
  const merged: Usage = { ...(base ?? {}) }
  if (next.prompt_tokens !== undefined) merged.prompt_tokens = next.prompt_tokens
  if (next.completion_tokens !== undefined) merged.completion_tokens = next.completion_tokens
  return merged
}

type Protocol = 'chat_completions' | 'messages' | 'responses'

interface RequestInput {
  model: string
  /** Already trimmed; empty means no system turn. */
  system: string
  prompt: string
  stream: boolean
}

interface StreamEvent {
  /** What this frame appends to the answer. */
  delta: string
  /** Counts this frame carried, merged over what came before. */
  usage: Usage | null
}

interface ProtocolSpec {
  label: string
  path: string
  headers?: Record<string, string>
  body: (input: RequestInput) => Dict
  /** Text of a whole reply; '' when the shape is not recognised. */
  text: (payload: unknown) => string
  usage: (payload: unknown) => Usage | null
  event: (chunk: unknown) => StreamEvent
}

/** Anthropic rejects a request without it; a smoke test never needs more. */
const MESSAGES_MAX_TOKENS = 4096

const PROTOCOLS: Record<Protocol, ProtocolSpec> = {
  chat_completions: {
    label: 'Chat Completions',
    path: '/v1/chat/completions',
    body: ({ model, system, prompt, stream }) => ({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    }),
    text: (payload) => asText(dig(asArray(dig(payload, 'choices'))[0], 'message', 'content')),
    usage: (payload) => openAIUsage(dig(payload, 'usage')),
    event: (chunk) => ({
      delta: asText(dig(asArray(dig(chunk, 'choices'))[0], 'delta', 'content')),
      usage: openAIUsage(dig(chunk, 'usage')),
    }),
  },
  messages: {
    label: 'Messages',
    path: '/v1/messages',
    // Upstream Anthropic refuses a request without it, and the relay only
    // forwards what the client sent.
    headers: { 'Anthropic-Version': '2023-06-01' },
    body: ({ model, system, prompt, stream }) => ({
      model,
      max_tokens: MESSAGES_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      stream,
    }),
    text: (payload) =>
      asArray(dig(payload, 'content'))
        .map((block) => asText(dig(block, 'text')))
        .join(''),
    usage: (payload) => nativeUsage(dig(payload, 'usage')),
    event: (chunk) => ({
      // Tool arguments and thinking arrive as deltas of their own; only the
      // text ones belong in the answer pane.
      delta:
        asText(dig(chunk, 'type')) === 'content_block_delta'
          ? asText(dig(chunk, 'delta', 'text'))
          : '',
      usage:
        nativeUsage(dig(chunk, 'usage')) ?? nativeUsage(dig(chunk, 'message', 'usage')),
    }),
  },
  responses: {
    label: 'Responses',
    path: '/v1/responses',
    body: ({ model, system, prompt, stream }) => ({
      model,
      ...(system ? { instructions: system } : {}),
      input: prompt,
      stream,
    }),
    // Reasoning items carry no `content`, so flattening skips them on its own.
    text: (payload) =>
      asArray(dig(payload, 'output'))
        .flatMap((item) => asArray(dig(item, 'content')))
        .map((part) => asText(dig(part, 'text')))
        .join(''),
    usage: (payload) => nativeUsage(dig(payload, 'usage')),
    event: (chunk) => ({
      delta:
        asText(dig(chunk, 'type')) === 'response.output_text.delta'
          ? asText(dig(chunk, 'delta'))
          : '',
      usage:
        nativeUsage(dig(chunk, 'usage')) ?? nativeUsage(dig(chunk, 'response', 'usage')),
    }),
  },
}

const PROTOCOL_ORDER: Protocol[] = ['chat_completions', 'messages', 'responses']

const readProtocol = (): Protocol => {
  const stored = localStorage.getItem(PROTOCOL_STORAGE)
  return stored && stored in PROTOCOLS ? (stored as Protocol) : 'chat_completions'
}

const IS_MAC = /mac/i.test(navigator.platform)

/** How close to the bottom (px) still counts as "following the stream". */
const FOLLOW_SLACK = 48

export default function Playground() {
  const { message } = App.useApp()
  const { isAdmin } = useAuth()
  const [models, setModels] = useState<string[]>([])
  const [modelsState, setModelsState] = useState<ModelsState>('loading')
  const [model, setModel] = useState<string>()
  const [host, setHost] = useState(() => localStorage.getItem(HOST_STORAGE) ?? '')
  const [protocol, setProtocol] = useState<Protocol>(readProtocol)
  const [viaServer, setViaServer] = useState(
    () => localStorage.getItem(PROXY_STORAGE) === '1',
  )
  const keys = useSavedKeys()
  const [system, setSystem] = useState('')
  const [prompt, setPrompt] = useState('用一句话介绍你自己。')
  const [stream, setStream] = useState(true)
  const [output, setOutput] = useState('')
  const [errorText, setErrorText] = useState('')
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const outputRef = useRef<HTMLDivElement | null>(null)
  const responseCardRef = useRef<HTMLDivElement | null>(null)
  const narrow = useMediaQuery('(max-width: 991px)')

  const spec = PROTOCOLS[protocol]
  // Only an administrator can ask the server to fetch, and only another host
  // needs it: this site is already the page's own origin.
  const proxyEnabled = viaServer && isAdmin
  // Where the request goes, recomputed as it is typed so the hint under the
  // field tracks the input.
  const hostBase = useMemo(() => normalizeHost(host), [host])
  // The model list trails the typing instead of firing a request per keystroke.
  const debouncedHost = useDebouncedValue(host)
  const debouncedKey = useDebouncedValue(keys.apiKey)
  const modelBase = useMemo(() => normalizeHost(debouncedHost), [debouncedHost])
  // The local list comes from the session, so a key being typed must not
  // reload it; only another host's list is read with the key.
  const modelKey = modelBase ? debouncedKey.trim() : ''
  const modelProxied = Boolean(modelBase) && proxyEnabled
  // A reply from the host that was in the field a moment ago must not land in
  // the list belonging to the current one.
  const modelsSeq = useRef(0)

  const loadModels = useCallback(() => {
    const seq = ++modelsSeq.current
    const apply = (list: string[], state: ModelsState) => {
      if (modelsSeq.current !== seq) return
      setModels(list)
      setModel((current) => current ?? list[0])
      setModelsState(state)
    }

    if (modelBase === null) {
      apply([], 'error')
      return
    }
    if (modelBase === '') {
      setModelsState('loading')
      api
        .myModels()
        .then((result) => apply(result.data ?? [], 'ready'))
        .catch(() => apply([], 'error'))
      return
    }
    // Another deployment has no session behind it: its model list only comes
    // back for a key it issued itself.
    if (!modelKey) {
      apply([], 'need-key')
      return
    }
    setModelsState('loading')
    callTarget(modelBase, '/v1/models', modelProxied, {
      method: 'GET',
      headers: { Authorization: `Bearer ${modelKey}` },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ data?: { id?: string }[] }>
      })
      .then((payload) =>
        apply(
          (payload.data ?? []).map((item) => item.id).filter((id): id is string => !!id),
          'ready',
        ),
      )
      .catch(() => apply([], 'error'))
  }, [modelBase, modelKey, modelProxied])

  useEffect(() => {
    loadModels()
  }, [loadModels])

  // Whether the viewport is glued to the bottom. Recorded on every scroll —
  // before new text lands — because measuring after the render would count
  // the fresh chunk itself as "the user scrolled away".
  const followRef = useRef(true)

  const onOutputScroll = () => {
    const el = outputRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK
  }

  // Follow the stream while glued; scrolling up to re-read must not be
  // fought by the incoming text.
  useEffect(() => {
    const el = outputRef.current
    if (!el || !running || !followRef.current) return
    el.scrollTop = el.scrollHeight
  }, [output, running])

  const modelOptions = useMemo(
    () => models.map((item) => ({ value: item, label: item })),
    [models],
  )

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  const send = async () => {
    if (hostBase === null) {
      message.warning('服务地址读不出来，填成 https://api.example.com 这样')
      document.getElementById('pg-host')?.focus()
      return
    }
    const proxied = Boolean(hostBase) && proxyEnabled
    const key = keys.apiKey.trim()
    if (!key) {
      message.warning('请先填入 API 密钥（在「API 密钥」页面创建时复制）')
      document.getElementById('pg-key')?.focus()
      return
    }
    if (!model) {
      message.warning('请选择模型')
      return
    }
    if (!prompt.trim()) {
      // An empty user turn still bills and still logs; stop it before it costs.
      message.warning('请输入用户提示词')
      document.getElementById('pg-prompt')?.focus()
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setRunning(true)
    setOutput('')
    setErrorText('')
    setMetrics(null)
    // A fresh request starts glued to the bottom, whatever the last one did.
    followRef.current = true

    // On a phone the response card is below the fold; bring it into view so
    // the stream is seen, not just produced.
    if (narrow) {
      responseCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    const startedAt = performance.now()
    let ttfb = 0
    let usage: Usage | null = null
    let text = ''
    let failed = false

    try {
      const response = await callTarget(hostBase, spec.path, proxied, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          ...spec.headers,
        },
        body: JSON.stringify(spec.body({ model, system: system.trim(), prompt, stream })),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const body = await response.text()
        setErrorText(`HTTP ${response.status}\n${body}`)
        failed = true
        return
      }

      keys.keep(key)

      if (!stream) {
        // No first-byte metric here: the whole body arrives at once, so the
        // number would just repeat the total.
        const payload: unknown = await response.json()
        usage = spec.usage(payload)
        // An unrecognised shape is still worth seeing: a gateway that answers
        // in its own envelope is exactly what a test page is for.
        text = spec.text(payload) || JSON.stringify(payload, null, 2)
        setOutput(text)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const event = spec.event(JSON.parse(payload))
            usage = mergeUsage(usage, event.usage)
            const delta = event.delta
            if (delta) {
              if (!ttfb) ttfb = performance.now() - startedAt
              text += delta
              setOutput(text)
            }
          } catch {
            // Ignore keep-alive comments and partial frames.
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        failed = true
        // "Failed to fetch" says nothing actionable; name the likely cause and
        // keep the raw error underneath as detail.
        const detail = String(error)
        if (!(error instanceof TypeError)) {
          setErrorText(detail)
        } else if (!hostBase) {
          setErrorText(`无法连接到服务，请检查网络或服务是否在运行。\n${detail}`)
        } else {
          // The browser reports a refused preflight as an ordinary network
          // failure, so the way past it has to be named here or it is never
          // found.
          const hint =
            isAdmin && !proxied
              ? '\n如果对方不响应 CORS 预检，打开上面的「通过本站服务端代发」再试。'
              : ''
          setErrorText(
            `无法连接到 ${hostBase}，请检查地址是否正确、服务是否在运行，以及它是否允许跨域调用。${hint}\n${detail}`,
          )
        }
      }
    } finally {
      const aborted = controller.signal.aborted
      // A failed request produced nothing to measure; a metric strip of zeros
      // would only suggest something arrived.
      if (!failed && (text || usage || aborted || ttfb)) {
        setMetrics({
          ttfbMs: Math.round(ttfb),
          totalMs: Math.round(performance.now() - startedAt),
          chars: text.length,
          usage,
          aborted,
        })
      }
      setRunning(false)
      abortRef.current = null
    }
  }

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!running) void send()
    }
  }

  // Generation speed: tokens over the time they streamed in, not over the
  // queueing wait before the first byte.
  const generationMs = metrics ? metrics.totalMs - metrics.ttfbMs : 0
  const tokensPerSecond =
    metrics?.usage?.completion_tokens && generationMs > 0
      ? (metrics.usage.completion_tokens / (generationMs / 1000)).toFixed(1)
      : null

  return (
    <>
      <PageHeader
        title="调用测试"
        description="这里发起的是真实请求，会经过完整的渠道路由，产生计费与调用日志。"
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={9}>
          <Card title="请求">
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <div>
                <label className="field-label" htmlFor="pg-host">
                  服务地址
                </label>
                <Input
                  id="pg-host"
                  allowClear
                  style={{ marginTop: 6 }}
                  status={hostBase === null ? 'error' : undefined}
                  placeholder={window.location.origin}
                  value={host}
                  onChange={(event) => {
                    setHost(event.target.value)
                    localStorage.setItem(HOST_STORAGE, event.target.value)
                  }}
                />
                <Typography.Text
                  type={hostBase === null ? 'danger' : 'secondary'}
                  style={{ display: 'block', fontSize: 12, marginTop: 6 }}
                >
                  {hostBase === null
                    ? '地址读不出来，填成 https://api.example.com 这样'
                    : hostBase
                      ? `请求发往 ${hostBase}${spec.path}${
                          proxyEnabled ? '（经本站服务端代发）' : ''
                        }，计费与日志都记在那边`
                      : `留空就是当前站点，请求发往 ${spec.path}`}
                </Typography.Text>
                {isAdmin && Boolean(hostBase) && (
                  <label
                    style={{
                      alignItems: 'center',
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    <Switch
                      size="small"
                      checked={viaServer}
                      aria-label="通过本站服务端代发"
                      onChange={(checked) => {
                        setViaServer(checked)
                        localStorage.setItem(PROXY_STORAGE, checked ? '1' : '0')
                      }}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      通过本站服务端代发（对方不响应 CORS 预检时用）
                    </Typography.Text>
                  </label>
                )}
              </div>

              <ApiKeyField
                keys={keys}
                id="pg-key"
                siteTokens={hostBase === ''}
                hint={
                  hostBase ? (
                    '请填那个服务签发的密钥，本站的密钥它不认。'
                  ) : (
                    <>
                      还没有密钥？<Link to="/tokens">去创建</Link>
                    </>
                  )
                }
              />

              <div>
                <label className="field-label" htmlFor="pg-protocol">
                  协议
                </label>
                <Select
                  id="pg-protocol"
                  style={{ marginTop: 6, width: '100%' }}
                  value={protocol}
                  onChange={(value: Protocol) => {
                    setProtocol(value)
                    localStorage.setItem(PROTOCOL_STORAGE, value)
                  }}
                  options={PROTOCOL_ORDER.map((value) => ({
                    value,
                    label: `${PROTOCOLS[value].label}  ·  ${PROTOCOLS[value].path}`,
                  }))}
                />
              </div>

              <div>
                <label className="field-label" htmlFor="pg-model">
                  模型
                </label>
                {/* AutoComplete rather than Select: a host that exposes no
                    /v1/models, or refuses the cross-origin read, still has to be
                    testable by typing the model name. */}
                <AutoComplete
                  id="pg-model"
                  allowClear
                  style={{ marginTop: 6, width: '100%' }}
                  placeholder="选择或输入模型"
                  value={model}
                  onChange={(value?: string) => setModel(value || undefined)}
                  filterOption={(input, option) =>
                    String(option?.value ?? '')
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                  options={modelOptions}
                  notFoundContent={
                    modelsState === 'loading' ? (
                      '加载中…'
                    ) : modelsState === 'error' ? (
                      <Space direction="vertical" size={4} style={{ padding: 4 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          模型列表加载失败，可直接输入模型名
                        </Typography.Text>
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={loadModels}>
                          重试
                        </Button>
                      </Space>
                    ) : modelsState === 'need-key' ? (
                      '填入该服务的密钥后自动拉取模型'
                    ) : models.length === 0 ? (
                      '暂无可用模型，可直接输入模型名'
                    ) : (
                      '没有匹配的模型'
                    )
                  }
                />
              </div>

              <div>
                <label className="field-label" htmlFor="pg-system">
                  System 提示词（可选）
                </label>
                <Input.TextArea
                  id="pg-system"
                  style={{ marginTop: 6 }}
                  rows={2}
                  value={system}
                  onChange={(event) => setSystem(event.target.value)}
                  onKeyDown={onPromptKeyDown}
                  placeholder="留空则不发送 system 消息"
                />
              </div>

              <div>
                <label className="field-label" htmlFor="pg-prompt">
                  用户提示词
                </label>
                <Input.TextArea
                  id="pg-prompt"
                  style={{ marginTop: 6 }}
                  rows={7}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={onPromptKeyDown}
                  placeholder={`输入提示词，${IS_MAC ? '⌘' : 'Ctrl'} + Enter 发送`}
                />
              </div>

              <label
                style={{ alignItems: 'center', cursor: 'pointer', display: 'flex', gap: 8 }}
              >
                <Switch checked={stream} onChange={setStream} size="small" aria-label="流式输出" />
                <Typography.Text style={{ fontSize: 13 }}>流式输出</Typography.Text>
              </label>

              <Space style={{ width: '100%' }}>
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={running}
                  onClick={() => void send()}
                >
                  发送
                </Button>
                <Tooltip title={running ? '中止本次请求' : '仅在请求进行中可用'}>
                  {/* The span keeps the tooltip working while the button is
                      disabled, and the constant footprint stops the row from
                      reflowing when a request starts. */}
                  <span style={{ display: 'inline-flex' }}>
                    <Button danger icon={<StopOutlined />} disabled={!running} onClick={stop}>
                      停止
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title={`快捷键 ${IS_MAC ? '⌘' : 'Ctrl'} + Enter`}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {IS_MAC ? '⌘↵' : 'Ctrl↵'}
                  </Typography.Text>
                </Tooltip>
              </Space>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <div ref={responseCardRef}>
          <Card
            title="响应"
            extra={
              <Space>
                <Tooltip title={output ? '复制输出' : '暂无可复制的输出'}>
                  <span style={{ display: 'inline-flex' }}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      disabled={!output}
                      aria-label="复制输出"
                      // Awaited: the clipboard API needs a secure context and
                      // rejects over plain HTTP, so reporting success without
                      // checking would be a lie exactly when it matters.
                      onClick={() => {
                        void copyTextToClipboard(output).then((copied) =>
                          copied
                            ? message.success('已复制')
                            : message.warning('浏览器拒绝了剪贴板访问，请手动选中复制'),
                        )
                      }}
                    />
                  </span>
                </Tooltip>
                <Tooltip title={output || errorText || metrics ? '清空' : '暂无可清空的内容'}>
                  <span style={{ display: 'inline-flex' }}>
                    <Button
                      size="small"
                      icon={<ClearOutlined />}
                      disabled={!output && !errorText && !metrics}
                      aria-label="清空输出"
                      onClick={() => {
                        setOutput('')
                        setErrorText('')
                        setMetrics(null)
                      }}
                    />
                  </span>
                </Tooltip>
              </Space>
            }
          >
            {errorText && (
              <Alert
                type="error"
                showIcon
                closable
                message="请求失败"
                description={<pre className="code-block">{errorText}</pre>}
                style={{ marginBottom: 12 }}
                onClose={() => setErrorText('')}
              />
            )}

            {metrics && (
              <div
                className="metric-strip"
                style={{
                  borderBottom: '1px solid var(--app-border)',
                  marginBottom: 12,
                  paddingBottom: 12,
                }}
              >
                <div className="metric-strip__item">
                  <span className="metric-strip__label">首字节</span>
                  <span className="metric-strip__value">
                    {metrics.ttfbMs ? formatDuration(metrics.ttfbMs) : '-'}
                  </span>
                </div>
                <div className="metric-strip__item">
                  <span className="metric-strip__label">总耗时</span>
                  <span className="metric-strip__value">{formatDuration(metrics.totalMs)}</span>
                </div>
                <div className="metric-strip__item">
                  <span className="metric-strip__label">输出字符</span>
                  <span className="metric-strip__value">{formatNumber(metrics.chars)}</span>
                </div>
                {metrics.usage && (
                  <>
                    <div className="metric-strip__item">
                      <span className="metric-strip__label">输入 / 输出 Token</span>
                      <span className="metric-strip__value">
                        {formatNumber(metrics.usage.prompt_tokens ?? 0)} /{' '}
                        {formatNumber(metrics.usage.completion_tokens ?? 0)}
                      </span>
                    </div>
                    {tokensPerSecond && (
                      <div className="metric-strip__item">
                        <Tooltip title="按首字节之后的生成时间计算">
                          <span className="metric-strip__label">输出速度</span>
                        </Tooltip>
                        <span className="metric-strip__value">{tokensPerSecond} tok/s</span>
                      </div>
                    )}
                  </>
                )}
                {metrics.aborted && (
                  <div className="metric-strip__item">
                    <span className="metric-strip__label">状态</span>
                    <span className="metric-strip__value" style={{ color: 'var(--app-warning)' }}>
                      已手动停止
                    </span>
                  </div>
                )}
              </div>
            )}

            {output || running ? (
              <div className="playground-output" ref={outputRef} onScroll={onOutputScroll}>
                {output}
                {running && <span className="playground-caret" />}
              </div>
            ) : (
              !errorText && (
                <EmptyState
                  title="还没有响应"
                  description="填好密钥、选择模型后点「发送」，这里会实时展示输出。"
                />
              )
            )}
          </Card>
          </div>
        </Col>
      </Row>
    </>
  )
}
