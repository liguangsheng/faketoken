import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Dropdown,
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
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { Link } from 'react-router-dom'

import { api } from '../api/client'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { copyTextToClipboard } from '../utils/clipboard'
import { formatDuration, formatNumber } from '../utils/format'

const KEYS_STORAGE = 'faketoken-playground-keys'
const REMEMBER_STORAGE = 'faketoken-playground-remember'
const MAX_REMEMBERED = 5

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

const readKeys = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_STORAGE) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const maskKey = (key: string) =>
  key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key

const IS_MAC = /mac/i.test(navigator.platform)

/** How close to the bottom (px) still counts as "following the stream". */
const FOLLOW_SLACK = 48

export default function Playground() {
  const { message, modal } = App.useApp()
  const [models, setModels] = useState<string[]>([])
  const [modelsState, setModelsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [model, setModel] = useState<string>()
  const [savedKeys, setSavedKeys] = useState<string[]>(readKeys)
  const [remember, setRemember] = useState(
    () => localStorage.getItem(REMEMBER_STORAGE) !== '0',
  )
  // Restored eagerly so the page is usable the moment it opens.
  const [apiKey, setApiKey] = useState(() => {
    const keys = readKeys()
    return localStorage.getItem(REMEMBER_STORAGE) !== '0' ? (keys[0] ?? '') : ''
  })
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

  const loadModels = useCallback(() => {
    setModelsState('loading')
    api
      .myModels()
      .then((result) => {
        setModels(result.data ?? [])
        setModel((current) => current ?? result.data?.[0])
        setModelsState('ready')
      })
      .catch(() => {
        setModels([])
        setModelsState('error')
      })
  }, [])

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

  const rememberKey = useCallback((key: string) => {
    setSavedKeys((current) => {
      const next = [key, ...current.filter((item) => item !== key)].slice(0, MAX_REMEMBERED)
      localStorage.setItem(KEYS_STORAGE, JSON.stringify(next))
      return next
    })
  }, [])

  const forgetKeys = () => {
    localStorage.removeItem(KEYS_STORAGE)
    setSavedKeys([])
    message.success('已清除本机保存的密钥')
  }

  const forgetOneKey = (key: string) => {
    setSavedKeys((current) => {
      const next = current.filter((item) => item !== key)
      localStorage.setItem(KEYS_STORAGE, JSON.stringify(next))
      return next
    })
  }

  // Asked for explicitly: the saved keys cannot be recovered from here, and
  // the same confirmation guards the "remember" switch being turned off.
  const confirmForgetKeys = (onConfirmed?: () => void) => {
    if (savedKeys.length === 0) {
      onConfirmed?.()
      return
    }
    modal.confirm({
      title: `清除本机保存的 ${savedKeys.length} 个密钥？`,
      content: '只影响这台浏览器上的记忆，密钥本身不会被删除，但需要重新粘贴才能继续调试。',
      okText: '清除',
      okButtonProps: { danger: true },
      onOk: () => {
        forgetKeys()
        onConfirmed?.()
      },
    })
  }

  const modelOptions = useMemo(
    () => models.map((item) => ({ value: item, label: item })),
    [models],
  )

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  const send = async () => {
    const key = apiKey.trim()
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
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system.trim() ? [{ role: 'system', content: system.trim() }] : []),
            { role: 'user', content: prompt },
          ],
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const body = await response.text()
        setErrorText(`HTTP ${response.status}\n${body}`)
        failed = true
        return
      }

      if (remember) rememberKey(key)

      if (!stream) {
        // No first-byte metric here: the whole body arrives at once, so the
        // number would just repeat the total.
        const payload = await response.json()
        usage = payload.usage ?? null
        text = payload.choices?.[0]?.message?.content ?? JSON.stringify(payload, null, 2)
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
            const chunk = JSON.parse(payload)
            if (chunk.usage) usage = chunk.usage
            const delta = chunk.choices?.[0]?.delta?.content ?? ''
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
        setErrorText(
          error instanceof TypeError
            ? `无法连接到服务，请检查网络或服务是否在运行。\n${detail}`
            : detail,
        )
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

  const savedKeyItems = savedKeys.map((key) => ({
    key,
    label: (
      <Space size={8}>
        <span className="mono">{maskKey(key)}</span>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined style={{ fontSize: 10 }} />}
          aria-label={`删除已保存的密钥 ${maskKey(key)}`}
          onClick={(event) => {
            event.stopPropagation()
            forgetOneKey(key)
          }}
        />
      </Space>
    ),
  }))

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
                <label className="field-label" htmlFor="pg-key">
                  API 密钥
                </label>
                <Space.Compact style={{ marginTop: 6, width: '100%' }}>
                  <Input.Password
                    id="pg-key"
                    placeholder="sk-..."
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  {savedKeys.length > 0 && (
                    <Dropdown
                      menu={{
                        items: [
                          ...savedKeyItems,
                          { type: 'divider' as const },
                          { key: '__clear', label: '清除已保存的密钥', danger: true },
                        ],
                        onClick: ({ key }) =>
                          key === '__clear' ? confirmForgetKeys() : setApiKey(key),
                      }}
                    >
                      <Button icon={<DownOutlined />} aria-label="选择已保存的密钥" />
                    </Dropdown>
                  )}
                </Space.Compact>
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, marginTop: 6 }}
                >
                  还没有密钥？<Link to="/tokens">去创建</Link>
                </Typography.Text>
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
                    checked={remember}
                    aria-label="在本浏览器记住密钥"
                    onChange={(checked) => {
                      if (checked) {
                        setRemember(true)
                        localStorage.setItem(REMEMBER_STORAGE, '1')
                        return
                      }
                      // Turning remembering off also wipes what was remembered;
                      // that is destructive, so it gets the same confirmation
                      // as the explicit "clear" entry.
                      confirmForgetKeys(() => {
                        setRemember(false)
                        localStorage.setItem(REMEMBER_STORAGE, '0')
                      })
                    }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    在本浏览器记住密钥（明文存于 localStorage）
                  </Typography.Text>
                </label>
              </div>

              <div>
                <label className="field-label" htmlFor="pg-model">
                  模型
                </label>
                <Select
                  id="pg-model"
                  style={{ marginTop: 6, width: '100%' }}
                  placeholder="选择模型"
                  showSearch
                  loading={modelsState === 'loading'}
                  value={model}
                  onChange={setModel}
                  options={modelOptions}
                  notFoundContent={
                    modelsState === 'error' ? (
                      <Space direction="vertical" size={4} style={{ padding: 4 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          模型列表加载失败
                        </Typography.Text>
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={loadModels}>
                          重试
                        </Button>
                      </Space>
                    ) : models.length === 0 ? (
                      '当前分组暂无可用模型'
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
