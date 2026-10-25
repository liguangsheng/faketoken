import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  App,
  AutoComplete,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { UploadFile } from 'antd'
import { ClearOutlined, PictureOutlined, UploadOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import ApiKeyField, { useSavedKeys } from '../components/playground/ApiKeyField'
import { callTarget } from '../components/playground/target'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useImageJobs } from '../imageJobs/ImageJobsContext'
import {
  buildImageCall,
  EDIT_PATH,
  GENERATE_PATH,
  isDict,
  type ImageOptions,
} from '../imageJobs/request'
import type { JobRequest } from '../imageJobs/types'
import JobList from './imagePlayground/JobList'
import RouteField, {
  AUTO_ROUTE,
  MANUAL_ROUTE,
  resolveRoute,
  useChannels,
  type ResolvedRoute,
} from './imagePlayground/RouteField'

const SETTINGS_STORAGE = 'faketoken-images-settings'

// The model list carries no type, so names that read as image models are
// offered first and picked by default.
const IMAGE_MODEL = /image|imagen|dall-?e|banana|flux|seedream|midjourney|kolors|stable-diffusion|sdxl/i

const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '1792x1024', '1024x1792']
const QUALITIES = ['auto', 'low', 'medium', 'high', 'standard', 'hd']
const BACKGROUNDS = ['auto', 'transparent', 'opaque']
const FORMATS = ['png', 'jpeg', 'webp']
const RESPONSE_FORMATS = ['b64_json', 'url']
const MAX_IMAGES = 10

const IS_MAC = /mac/i.test(navigator.platform)

const DEFAULT_PROMPT = '一只橘猫趴在窗台上晒太阳，水彩风格'

interface Settings {
  model?: string
  n: number
  options: ImageOptions
  route: string
  upstream: string
  /** Drafts, so leaving the page mid-edit loses nothing. */
  prompt: string
  extra: string
}

const DEFAULT_SETTINGS: Settings = {
  n: 1,
  options: {},
  route: AUTO_ROUTE,
  upstream: '',
  prompt: DEFAULT_PROMPT,
  extra: '',
}

/** The form as last left: route, model, parameters and drafts. */
const readSettings = (): Settings => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) ?? '{}')
    if (!isDict(parsed)) return DEFAULT_SETTINGS
    const options: ImageOptions = {}
    if (isDict(parsed.options)) {
      for (const [name, value] of Object.entries(parsed.options)) {
        if (typeof value === 'string') options[name as keyof ImageOptions] = value
      }
    }
    return {
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      n: typeof parsed.n === 'number' ? Math.min(Math.max(parsed.n, 1), MAX_IMAGES) : 1,
      options,
      route: typeof parsed.route === 'string' ? parsed.route : AUTO_ROUTE,
      upstream: typeof parsed.upstream === 'string' ? parsed.upstream : '',
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : DEFAULT_PROMPT,
      extra: typeof parsed.extra === 'string' ? parsed.extra : '',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const toOptions = (values: string[]) => values.map((value) => ({ value, label: value }))

type ModelsState = 'loading' | 'ready' | 'error'

export default function ImagePlayground() {
  const { message } = App.useApp()
  const { isAdmin } = useAuth()
  const { jobs, running, submit, stop, remove, clearFinished } = useImageJobs()
  const keys = useSavedKeys()
  const [saved] = useState(readSettings)
  const [route, setRoute] = useState(saved.route)
  const [upstream, setUpstream] = useState(saved.upstream)
  const { channels, loaded: channelsLoaded } = useChannels(isAdmin)
  const [models, setModels] = useState<string[]>([])
  const [modelsState, setModelsState] = useState<ModelsState>('loading')
  const [model, setModel] = useState(saved.model)
  const [prompt, setPrompt] = useState(saved.prompt)
  const [n, setN] = useState(saved.n)
  const [options, setOptions] = useState<ImageOptions>(saved.options)
  const [extraText, setExtraText] = useState(saved.extra)
  const [references, setReferences] = useState<UploadFile[]>([])
  const jobsCardRef = useRef<HTMLDivElement | null>(null)
  const narrow = useMediaQuery('(max-width: 991px)')

  // Only an administrator picks a route; everyone else is routed as usual.
  const { pinned, manual, upstreamBase }: ResolvedRoute = isAdmin
    ? resolveRoute(route, channels, upstream)
    : { manual: false, upstreamBase: '' }

  const loadModels = () => {
    setModelsState('loading')
    api
      .myModels()
      .then((response) => {
        const list = response.data ?? []
        setModels(list)
        setModel((current) => current ?? list.find((item) => IMAGE_MODEL.test(item)))
        setModelsState('ready')
      })
      .catch(() => setModelsState('error'))
  }

  useEffect(loadModels, [])

  // A remembered channel that has since been deleted or archived falls back to
  // automatic rather than showing a bare id.
  useEffect(() => {
    if (!channelsLoaded || !/^\d+$/.test(route)) return
    if (!channels.some((channel) => String(channel.id) === route)) setRoute(AUTO_ROUTE)
  }, [channelsLoaded, channels, route])

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE,
        JSON.stringify({ model, n, options, route, upstream, prompt, extra: extraText }),
      )
    } catch {
      // Storage refused (private mode, quota); the page works without it.
    }
  }, [model, n, options, route, upstream, prompt, extraText])

  const modelOptions = useMemo(() => {
    // A pinned channel's own names come first: it may serve models this
    // account's group never sees.
    const own = pinned
      ? [...new Set([...pinned.models, ...Object.keys(pinned.model_mapping ?? {})])].sort(
          (a, b) => Number(IMAGE_MODEL.test(b)) - Number(IMAGE_MODEL.test(a)),
        )
      : []
    const rest = models.filter((item) => !own.includes(item))
    const image = rest.filter((item) => IMAGE_MODEL.test(item))
    const other = rest.filter((item) => !IMAGE_MODEL.test(item))
    return [
      ...(pinned && own.length
        ? [{ label: `#${pinned.id} ${pinned.name} 的模型`, options: toOptions(own) }]
        : []),
      ...(image.length ? [{ label: '生图模型（按名称猜测）', options: toOptions(image) }] : []),
      ...(other.length ? [{ label: '其他模型', options: toOptions(other) }] : []),
    ]
  }, [models, pinned])

  const setOption = (name: keyof ImageOptions, value?: string) =>
    setOptions((current) => ({ ...current, [name]: value || undefined }))

  const path = references.length ? EDIT_PATH : GENERATE_PATH

  const send = () => {
    if (manual && !upstreamBase) {
      message.warning(
        upstreamBase === null ? '上游地址读不出来，填成 https://api.example.com 这样' : '请填写上游地址',
      )
      document.getElementById('img-upstream')?.focus()
      return
    }
    const key = keys.apiKey.trim()
    if (!key) {
      message.warning(
        manual ? '请填入上游的 API 密钥' : '请先填入 API 密钥（在「API 密钥」页面创建时复制）',
      )
      document.getElementById('img-key')?.focus()
      return
    }
    if (!model) {
      message.warning('请选择模型')
      return
    }
    if (!prompt.trim()) {
      message.warning('请输入提示词')
      document.getElementById('img-prompt')?.focus()
      return
    }
    let extra: Record<string, unknown> = {}
    if (extraText.trim()) {
      try {
        const parsed: unknown = JSON.parse(extraText)
        if (!isDict(parsed)) throw new Error('not an object')
        extra = parsed
      } catch {
        message.warning('额外参数要是一个 JSON 对象，比如 {"seed": 42}')
        document.getElementById('img-extra')?.focus()
        return
      }
    }
    if (manual && references.length) {
      message.warning('手填上游不支持参考图（服务端代发只转发 JSON），请先移除参考图')
      return
    }

    const files = references.flatMap((file) => (file.originFileObj ? [file.originFileObj] : []))
    const call = buildImageCall(
      { model, prompt, n, options, extra, references: files },
      key,
      pinned?.id,
    )
    const base = upstreamBase ?? ''
    submit({
      request: {
        model,
        prompt,
        n,
        options,
        extra,
        route: isAdmin ? route : AUTO_ROUTE,
        referenceNames: files.map((file) => file.name),
        endpoint: manual ? `${base}${call.path}` : call.path,
        target: manual
          ? { label: '上游', value: base }
          : pinned
            ? { label: '渠道', value: `#${pinned.id} ${pinned.name}` }
            : undefined,
      },
      // Manual goes through this server to the typed-in upstream. References
      // were refused above, so its body is always JSON text.
      send: (signal) =>
        manual
          ? callTarget(base, call.path, true, {
              method: 'POST',
              headers: call.headers,
              body: String(call.body),
              signal,
            })
          : fetch(call.path, { method: 'POST', headers: call.headers, body: call.body, signal }),
      onAccepted: () => keys.keep(key),
    })

    // On a phone the list is below the fold.
    if (narrow) jobsCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const reuse = useCallback(
    (request: JobRequest) => {
      setModel(request.model)
      setPrompt(request.prompt)
      setN(request.n)
      setOptions(request.options)
      setExtraText(Object.keys(request.extra).length ? JSON.stringify(request.extra) : '')
      if (isAdmin) {
        setRoute(request.route)
        if (request.route === MANUAL_ROUTE && request.target) setUpstream(request.target.value)
      }
      message.success('已填回左侧，改完再生成')
    },
    [isAdmin, message],
  )

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      send()
    }
  }

  const optionField = (
    name: keyof ImageOptions,
    label: string,
    values: string[],
    tooltip?: string,
  ) => (
    <Col span={12}>
      <label className="field-label" htmlFor={`img-${name}`}>
        {tooltip ? (
          <Tooltip title={tooltip}>
            <span style={{ borderBottom: '1px dashed var(--app-border-strong)' }}>{label}</span>
          </Tooltip>
        ) : (
          label
        )}
      </label>
      <Select
        id={`img-${name}`}
        allowClear
        placeholder="不传"
        style={{ marginTop: 6, width: '100%' }}
        value={options[name]}
        onChange={(value?: string) => setOption(name, value)}
        options={toOptions(values)}
      />
    </Col>
  )

  return (
    <>
      <PageHeader
        title="生图测试"
        description="这里发起的是真实请求，会经过完整的渠道路由，产生计费与调用日志。"
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={9}>
          <Card title="请求">
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              {isAdmin && (
                <RouteField
                  route={route}
                  onRouteChange={setRoute}
                  channels={channels}
                  model={model}
                  upstream={upstream}
                  onUpstreamChange={setUpstream}
                />
              )}

              <ApiKeyField
                keys={keys}
                id="img-key"
                siteTokens={!manual}
                hint={
                  manual
                    ? '填上游签发的密钥，本站的密钥它不认。'
                    : '从下拉里选一个我的密钥，或直接粘贴别的。'
                }
                emptyTokensHint={
                  <>
                    还没有密钥？<Link to="/tokens">去创建</Link>
                  </>
                }
              />

              <div>
                <label className="field-label" htmlFor="img-model">
                  模型
                </label>
                {/* AutoComplete rather than Select: a model the list does not
                    carry still has to be testable by typing its name. */}
                <AutoComplete
                  id="img-model"
                  allowClear
                  style={{ marginTop: 6, width: '100%' }}
                  placeholder="选择或输入模型"
                  value={model}
                  onChange={(value?: string) => setModel(value || undefined)}
                  // Options are grouped; a group has no value of its own.
                  filterOption={(input, option) =>
                    String(option && 'value' in option ? option.value : '')
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
                    ) : models.length === 0 ? (
                      '暂无可用模型，可直接输入模型名'
                    ) : (
                      '没有匹配的模型'
                    )
                  }
                />
              </div>

              <div>
                <label className="field-label" htmlFor="img-prompt">
                  提示词
                </label>
                <Input.TextArea
                  id="img-prompt"
                  style={{ marginTop: 6 }}
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={onPromptKeyDown}
                  placeholder={`描述要画的内容，${IS_MAC ? '⌘' : 'Ctrl'} + Enter 生成`}
                />
              </div>

              <div>
                <Row gutter={[12, 12]}>
                  <Col span={12}>
                    <label className="field-label" htmlFor="img-size">
                      尺寸
                    </label>
                    {/* Free text too: providers take sizes beyond this list,
                        and some take ratios such as 16:9. */}
                    <AutoComplete
                      id="img-size"
                      allowClear
                      placeholder="不传"
                      style={{ marginTop: 6, width: '100%' }}
                      value={options.size}
                      onChange={(value?: string) => setOption('size', value?.trim())}
                      options={toOptions(SIZES)}
                    />
                  </Col>
                  {optionField('quality', '质量', QUALITIES)}
                  {optionField('background', '背景', BACKGROUNDS)}
                  {optionField('output_format', '格式', FORMATS)}
                  <Col span={12}>
                    <label className="field-label" htmlFor="img-n">
                      张数
                    </label>
                    <InputNumber
                      id="img-n"
                      min={1}
                      max={MAX_IMAGES}
                      precision={0}
                      style={{ marginTop: 6, width: '100%' }}
                      value={n}
                      onChange={(value) => setN(value ?? 1)}
                    />
                  </Col>
                  {optionField(
                    'response_format',
                    '返回方式',
                    RESPONSE_FORMATS,
                    'gpt-image 系列固定返回 base64，传了反而可能报错',
                  )}
                </Row>
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, marginTop: 6 }}
                >
                  留空的参数不发送：上游不认的参数多半直接报 400。
                </Typography.Text>
              </div>

              <div>
                <label className="field-label" htmlFor="img-extra">
                  额外参数（JSON，可选）
                </label>
                <Input.TextArea
                  id="img-extra"
                  className="mono"
                  style={{ marginTop: 6 }}
                  rows={2}
                  value={extraText}
                  onChange={(event) => setExtraText(event.target.value)}
                  placeholder='{"seed": 42}'
                />
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, marginTop: 6 }}
                >
                  并入请求体，同名时覆盖上面的设置。
                </Typography.Text>
              </div>

              <div>
                <span className="field-label">参考图（可选）</span>
                <div style={{ marginTop: 6 }}>
                  <Upload
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    disabled={manual}
                    listType="picture"
                    fileList={references}
                    // Kept in the page and sent with the request, not uploaded
                    // on its own.
                    beforeUpload={() => false}
                    onChange={({ fileList }) => setReferences(fileList)}
                  >
                    <Button icon={<UploadOutlined />}>添加参考图</Button>
                  </Upload>
                </div>
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, marginTop: 6 }}
                >
                  {manual
                    ? '手填上游不支持参考图：服务端代发只转发 JSON。'
                    : `有参考图时改走 ${EDIT_PATH}（multipart 上传）。`}
                </Typography.Text>
              </div>

              <div>
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, marginTop: 8 }}
                >
                  请求发往{' '}
                  {manual
                    ? `${upstreamBase || '（上游地址）'}${path}，经本站服务端代发`
                    : pinned
                      ? `${path}，固定走渠道 #${pinned.id} ${pinned.name}`
                      : path}
                </Typography.Text>
              </div>
            </Space>

            {/* Outside the vertical Space: a flex item cannot leave its own
                wrapper, so the sticky row needs a block parent. */}
            <Space className="playground-actions" style={{ width: '100%' }}>
              <Button type="primary" icon={<PictureOutlined />} onClick={send}>
                生成
              </Button>
              <Tooltip title={`快捷键 ${IS_MAC ? '⌘' : 'Ctrl'} + Enter`}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {IS_MAC ? '⌘↵' : 'Ctrl↵'}
                </Typography.Text>
              </Tooltip>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <div ref={jobsCardRef}>
            <Card
              title="生成记录"
              extra={
                <Space size={8}>
                  {running > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {running} 个进行中
                    </Typography.Text>
                  )}
                  <Popconfirm
                    title="清空已结束的记录？"
                    description="进行中的不受影响；图片会一起从本机删除。"
                    okText="清空"
                    okButtonProps={{ danger: true }}
                    onConfirm={clearFinished}
                    disabled={jobs.length === running}
                  >
                    <Button
                      size="small"
                      icon={<ClearOutlined />}
                      disabled={jobs.length === running}
                      aria-label="清空记录"
                    />
                  </Popconfirm>
                </Space>
              }
            >
              {jobs.length ? (
                <JobList jobs={jobs} onStop={stop} onRemove={remove} onReuse={reuse} />
              ) : (
                <EmptyState
                  title="还没有记录"
                  description="填好密钥、选好模型后点「生成」。任务在后台跑，切到别的页面也不会中断，记录保存在本机浏览器里。"
                />
              )}
            </Card>
          </div>
        </Col>
      </Row>
    </>
  )
}
