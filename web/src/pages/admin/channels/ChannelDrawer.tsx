import { useLayoutEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  TimePicker,
  Typography,
} from 'antd'
import { CloudDownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

import { api, type Channel } from '../../../api/client'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import {
  parseList,
  parseEffortRules,
  parseHeaders,
  parseMapping,
  STATUS,
  stringifyEffortRules,
  stringifyHeaders,
  stringifyMapping,
} from '../../../utils/format'
import ModelPickerModal, { type ModelPickerState } from './ModelPickerModal'
import {
  AUTH_STYLES,
  MAX_PRIORITY,
  MAX_WEIGHT,
  MIN_PRIORITY,
  MIN_WEIGHT,
  TEST_PROTOCOLS,
  withConfigured,
} from './shared'

/**
 * "HH:MM" into a dayjs the TimePicker can hold, and null for anything it cannot
 * read. Done by hand rather than with dayjs' format parsing so the file does not
 * have to register the customParseFormat plugin for one field; the date part is
 * irrelevant, only the clock is stored.
 */
function parseClock(value: string | null | undefined) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return dayjs().hour(hour).minute(minute).second(0).millisecond(0)
}

/**
 * What the drawer opens on. channel is the row being edited, or undefined for
 * a new one; overrides let the quick import seed the form in one write instead
 * of opening the drawer and then racing a second setFieldsValue against it.
 */
export interface ChannelDraft {
  channel?: Channel
  overrides?: Record<string, unknown>
}

interface Props {
  /** A fresh object per opening; null closes. */
  draft: ChannelDraft | null
  groupOptions: { value: string; label: string }[]
  onClose: () => void
  /** The row landed; the listing reloads. */
  onSaved: () => void | Promise<void>
  /** A row was changed in place (a UA lock cleared); the listing patches it. */
  onPatched: (channel: Channel) => void
}

export default function ChannelDrawer({ draft, groupOptions, onClose, onSaved, onPatched }: Props) {
  const { message, modal } = App.useApp()
  // antd clamps a Modal to the viewport but not a Drawer, so a fixed width
  // hangs the left edge of this 17-field form off screen on a phone.
  const narrow = useMediaQuery('(max-width: 768px)')
  const [form] = Form.useForm()
  const [editing, setEditing] = useState<Channel | null>(null)
  // The advanced fields fold away: a new channel needs three fields, not
  // seventeen.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingCredential, setLoadingCredential] = useState(false)
  const [credentialFailed, setCredentialFailed] = useState(false)
  const credentialRequest = useRef(0)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [picker, setPicker] = useState<ModelPickerState | null>(null)
  // The schedule fields are meaningless until keepalive is on, and their
  // validators must not fire while it is off.
  const keepaliveOn = Boolean(Form.useWatch('keepalive_enabled', form))

  // Seeded before paint: the drawer keeps its previous content mounted, and a
  // frame of the last channel's fields under the new title is a real flash.
  useLayoutEffect(() => {
    if (!draft) return
    const { channel, overrides } = draft
    const requestID = ++credentialRequest.current
    const overrideKey = typeof overrides?.api_key === 'string' ? overrides.api_key : ''
    const shouldRevealCredential = Boolean(channel && !overrideKey)

    setEditing(channel ?? null)
    setAdvancedOpen(Boolean(channel))
    setLoadingCredential(shouldRevealCredential)
    setCredentialFailed(false)
    // Clears stale validation errors from the previous visit along with values.
    form.resetFields()
    form.setFieldsValue({
      ...(channel
        ? {
            ...channel,
            api_key: '',
            models: channel.models,
            model_prefixes: (channel.model_prefixes ?? []).join('\n'),
            model_mapping: stringifyMapping(channel.model_mapping),
            reasoning_effort_mapping: stringifyEffortRules(channel.reasoning_effort_mapping),
            headers: stringifyHeaders(channel.headers),
            keepalive_at: parseClock(channel.keepalive_at),
          }
        : {
            name: '',
            base_url: '',
            auth_style: 'auto',
            api_key: '',
            status: STATUS.ENABLED,
            priority: 0,
            weight: 1,
            groups: ['default'],
            models: [],
            model_prefixes: '',
            model_mapping: '',
            reasoning_effort_mapping: '',
            headers: '',
            timeout_secs: 0,
            proxy_url: '',
            price_ratio: 1,
            rpm_limit: 0,
            retry_count: 0,
            retry_backoff_ms: 0,
            test_model: '',
            supported_protocols: ['chat_completions', 'responses', 'messages'],
            allow_attachments: true,
            lock_user_agent: false,
            locked_user_agents: {},
            note: '',
            keepalive_enabled: false,
            keepalive_at: null,
            keepalive_target: 0,
          }),
      ...overrides,
    })

    if (channel && shouldRevealCredential) {
      void api.admin
        .channelCredential(channel.id)
        .then((credential) => {
          if (credentialRequest.current === requestID) {
            form.setFieldValue('api_key', credential.api_key)
          }
        })
        .catch((error) => {
          if (credentialRequest.current === requestID) {
            setCredentialFailed(true)
            message.error(error instanceof Error ? error.message : '读取上游密钥失败')
          }
        })
        .finally(() => {
          if (credentialRequest.current === requestID) {
            setLoadingCredential(false)
          }
        })
    }
  }, [draft, form, message])

  const discard = () => {
    credentialRequest.current++
    setLoadingCredential(false)
    onClose()
  }

  // Seventeen fields is too much typing to lose to a stray Esc or mask click.
  const close = () => {
    if (form.isFieldsTouched()) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '关闭后已填写的内容不会保留。',
        okText: '放弃',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk: discard,
      })
      return
    }
    discard()
  }

  const submit = async () => {
    const values = await form.validateFields()
    const payload = {
      name: values.name,
      base_url: values.base_url ?? '',
      auth_style: values.auth_style ?? 'auto',
      api_key: values.api_key ?? '',
      status: values.status ?? STATUS.ENABLED,
      priority: Number(values.priority ?? 0),
      weight: Number(values.weight ?? 1),
      groups: values.groups ?? ['default'],
      models: values.models ?? [],
      model_prefixes: parseList(values.model_prefixes ?? ''),
      model_mapping: parseMapping(values.model_mapping ?? ''),
      reasoning_effort_mapping: parseEffortRules(values.reasoning_effort_mapping ?? ''),
      headers: parseHeaders(values.headers ?? ''),
      timeout_secs: Number(values.timeout_secs ?? 0),
      proxy_url: values.proxy_url ?? '',
      price_ratio: Number(values.price_ratio ?? 1),
      rpm_limit: Number(values.rpm_limit ?? 0),
      retry_count: Number(values.retry_count ?? 0),
      retry_backoff_ms: Number(values.retry_backoff_ms ?? 0),
      test_model: values.test_model ?? '',
      supported_protocols: values.supported_protocols ?? ['chat_completions', 'responses', 'messages'],
      allow_attachments: values.allow_attachments !== false,
      lock_user_agent: Boolean(values.lock_user_agent),
      locked_user_agents: Object.fromEntries(
        TEST_PROTOCOLS.flatMap((protocol) => {
          const value = String(values.locked_user_agents?.[protocol.value] ?? '').trim()
          return value ? [[protocol.value, value]] : []
        }),
      ),
      note: values.note ?? '',
      keepalive_enabled: Boolean(values.keepalive_enabled),
      // The picker holds a dayjs; the server stores and validates "HH:MM".
      keepalive_at: values.keepalive_at ? dayjs(values.keepalive_at).format('HH:mm') : '',
      keepalive_target: Number(values.keepalive_target ?? 0),
    }

    setSaving(true)
    try {
      if (editing) {
        await api.admin.updateChannel(editing.id, payload)
        message.success('已保存')
      } else {
        await api.admin.createChannel(payload)
        message.success('渠道已创建')
      }
      await onSaved()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // fetchModels probes whatever is currently typed in the drawer, so a channel
  // can be filled in before it exists and a corrected address can be re-probed
  // without saving first. An empty key field still means "keep the stored
  // one", which the server resolves from channel_id.
  const fetchModels = async () => {
    const values = form.getFieldsValue()
    const baseURL = (values.base_url ?? '').trim()
    if (!baseURL) {
      message.warning('请先填写接口地址')
      return
    }

    setFetchingModels(true)
    try {
      const result = await api.admin.importChannel({
        channel_id: editing?.id,
        base_url: baseURL,
        api_key: (values.api_key ?? '').trim() || undefined,
        auth_style: values.auth_style ?? 'auto',
      })
      if (result.model_error) {
        message.error(`拉取失败：${result.model_error}`)
        return
      }
      if (!result.models.length) {
        message.warning('上游返回了空的模型列表')
        return
      }

      const current: string[] = values.models ?? []
      setPicker({
        models: withConfigured(result.models, current),
        upstream: result.models,
        initial: current,
      })
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拉取失败')
    } finally {
      setFetchingModels(false)
    }
  }

  return (
    <>
      <Drawer
        open={Boolean(draft)}
        width={narrow ? '100%' : 760}
        title={editing ? `编辑渠道：${editing.name}` : '新建渠道'}
        onClose={close}
        // Sticky at the bottom: after a 17-field form, save is where the eye
        // already is, not back at the top.
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={close}>取消</Button>
            <Button type="primary" loading={saving} disabled={loadingCredential} onClick={() => void submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={() => void submit()}>
          <Divider orientation="left" orientationMargin={0} style={{ marginTop: 0 }}>
            基本信息
          </Divider>

          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="例如：主渠道" />
          </Form.Item>

          <Form.Item
            name="base_url"
            label="接口地址"
            tooltip="填到域名即可，例如 https://api.openai.com；末尾带 /v1 也能正确识别"
            rules={[{ required: true, whitespace: true, message: '请输入接口地址' }]}
          >
            <Input placeholder="https://api.openai.com" />
          </Form.Item>

          <Form.Item
            name="api_key"
            label="上游密钥"
            tooltip={editing ? '当前显示已存储的明文密钥，修改后会覆盖原密钥' : '会以 AES-256-GCM 加密后落库'}
            rules={editing ? [] : [{ required: true, message: '请输入上游密钥' }]}
          >
            {/* Masked by default: the stored plaintext should not sit on a
                shared screen. The eye toggle reveals it on purpose. */}
            <Input.Password
              className="mono"
              autoComplete="new-password"
              disabled={loadingCredential}
              placeholder={
                loadingCredential
                  ? '正在读取密钥…'
                  : credentialFailed
                    ? '读取失败；留空保存则保持原密钥'
                    : editing
                      ? '未设置'
                      : 'sk-...'
              }
            />
          </Form.Item>

          <Divider orientation="left" orientationMargin={0}>
            路由与计费
          </Divider>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="priority" label="优先级" tooltip="数值越大越优先">
                <InputNumber
                  min={MIN_PRIORITY}
                  max={MAX_PRIORITY}
                  precision={0}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="weight" label="权重" tooltip="同优先级内按权重随机分配">
                <InputNumber
                  min={MIN_WEIGHT}
                  max={MAX_WEIGHT}
                  precision={0}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="price_ratio"
                label="计费倍率"
                // 0 is refused here rather than accepted and quietly turned
                // into 1 by the server. Unlike a user group, a channel has no
                // "free" setting: the server clamps a non-positive ratio to 1
                // so that an API caller omitting the field cannot make a
                // channel free by accident.
                tooltip="该渠道的费用乘数，1 为原价。这里不支持 0（与分组倍率不同）；要让某个分组免费请到「用户分组」设置"
              >
                <InputNumber min={0.01} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="groups"
            label="可用分组"
            tooltip="只有列在这里的分组，其用户才能路由到该渠道"
          >
            <Select mode="tags" options={groupOptions} placeholder="default" />
          </Form.Item>

          <Form.Item
            name="models"
            label={
              <Space size={8}>
                <span>支持的模型</span>
                <Button
                  size="small"
                  type="link"
                  icon={<CloudDownloadOutlined />}
                  loading={fetchingModels}
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => void fetchModels()}
                >
                  从上游拉取
                </Button>
              </Space>
            }
            tooltip="每个模型是一个标签，点 × 可移除；粘贴用逗号、空格或换行分隔的列表会自动拆分"
          >
            <Select
              mode="tags"
              placeholder="输入模型名后回车，或从上游拉取"
              // Pasting a list is how these usually arrive, so the separators
              // matter as much as the chips do.
              tokenSeparators={[',', '\n', ' ', '\t']}
              // The dropdown is left working on purpose: in tags mode the
              // typed value is committed by selecting it there, so forcing it
              // shut would stop new names being added by hand. There is
              // nothing to suggest, so its empty state is suppressed instead.
              notFoundContent={null}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item
            name="model_mapping"
            label="模型映射"
            tooltip="每行 客户端模型=上游模型，转发时只改写 model 字段"
          >
            <Input.TextArea rows={3} placeholder={'gpt-4o=gpt-4o-2024-11-20'} />
          </Form.Item>

          <Collapse
            ghost
            className="drawer-collapse"
            activeKey={advancedOpen ? ['advanced'] : []}
            onChange={(keys) => setAdvancedOpen(keys.length > 0)}
            style={{ marginBottom: 8 }}
            items={[
              {
                key: 'advanced',
                label: (
                  <Typography.Text strong>
                    高级设置
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>
                      前缀 / 超时 / 鉴权 / 协议 / 代理
                    </Typography.Text>
                  </Typography.Text>
                ),
                // forceRender is load-bearing: a never-opened panel would keep
                // its fields out of validateFields, and submit would silently
                // reset them to defaults on an existing channel.
                forceRender: true,
                children: (
                  <>
                    <Row gutter={16}>
                      <Col xs={24} md={8}>
                        <Form.Item name="timeout_secs" label="超时（秒）" tooltip="0 表示使用全局默认">
                          <InputNumber min={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="rpm_limit"
                          label="RPM 限制"
                          tooltip="每分钟最大请求数，0 表示不限制"
                        >
                          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="retry_count"
                          label="重试次数"
                          tooltip="失败后在这个渠道上再试的次数，用完才换下一个渠道。0 表示不重试"
                        >
                          <InputNumber min={0} max={20} precision={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="retry_backoff_ms"
                          label="重试间隔（毫秒）"
                          tooltip="同渠道重试前的等待基数，按重试次数递增，上限 30 秒。0 表示使用全局间隔"
                        >
                          <InputNumber
                            min={0}
                            max={60000}
                            step={50}
                            precision={0}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item name="status" label="状态">
                          <Select
                            options={[
                              { value: STATUS.ENABLED, label: '启用' },
                              { value: STATUS.DISABLED, label: '禁用' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="auth_style"
                          label="鉴权方式"
                          tooltip="自动会根据客户端请求端点选择；仅在兼容网关要求特殊鉴权头时覆盖"
                        >
                          <Select options={AUTH_STYLES} />
                        </Form.Item>
                      </Col>
                    </Row>

                    {/* Sits next to 测试模型 because the two are coupled: a
                        channel that only lists prefixes has no model list for
                        the tester to draw a default from. */}
                    <Form.Item
                      name="model_prefixes"
                      label="模型前缀"
                      tooltip="每行一个前缀，例如 gpt-4 可覆盖 gpt-4o、gpt-4.1；只有当没有渠道精确匹配该模型时才生效"
                    >
                      <Input.TextArea rows={3} placeholder={'gpt-4\nclaude-'} />
                    </Form.Item>

                    <Form.Item
                      name="test_model"
                      label="测试模型"
                      tooltip="执行「模型测试」时的默认模型；留空则取第一个支持的模型，只配了前缀的渠道必须填"
                    >
                      <Input placeholder="留空则取第一个支持的模型" />
                    </Form.Item>

                    <Form.Item
                      name="supported_protocols"
                      label="支持的协议"
                      tooltip="勾选上游实际支持的请求协议，路由时只会把对应协议的请求转发到此渠道"
                    >
                      <Checkbox.Group>
                        {TEST_PROTOCOLS.map((item) => (
                          <Checkbox key={item.value} value={item.value}>
                            {item.label}
                          </Checkbox>
                        ))}
                      </Checkbox.Group>
                    </Form.Item>

                    <Form.Item
                      name="allow_attachments"
                      label="允许附件"
                      valuePropName="checked"
                      tooltip="关闭后，包含图片、文档、文件或音频等附件的会话请求会绕过该渠道，交给其他允许附件的渠道；都不允许才拒绝。"
                    >
                      <Switch checkedChildren="允许" unCheckedChildren="拒绝" />
                    </Form.Item>

                    {/* Sits with the other upstream-compatibility settings: it
                        exists because upstreams disagree about what the
                        thinking levels are called, not because anyone wants to
                        change how hard the model thinks. */}
                    <Form.Item
                      name="reasoning_effort_mapping"
                      label="思考强度映射"
                      tooltip="每行 模型:客户端强度=上游强度。* 对该渠道所有模型生效，gpt-5* 匹配前缀；越具体的越优先，它没写的强度仍然沉降到 *。只写 max=xhigh 而不写模型时等同 *。模型名自带冒号（如 gpt-oss:120b）不影响解析。按客户端请求的模型名匹配；只改写 reasoning_effort / reasoning.effort / output_config.effort，没有规则的强度原样透传"
                    >
                      <Input.TextArea
                        className="mono"
                        autoSize={{ minRows: 3, maxRows: 12 }}
                        placeholder={'*:max=xhigh\ngpt-5.1:max=high'}
                      />
                    </Form.Item>

                    <Card size="small" title="User-Agent 锁定配置" style={{ marginBottom: 12 }}>
                      <Form.Item
                        name="lock_user_agent"
                        label="自动锁定 User-Agent"
                        valuePropName="checked"
                        tooltip="仅控制留空配置时是否在请求成功后自动记录请求 UA；手动填写的 UA 不受此开关影响。"
                      >
                        <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                      </Form.Item>
                      <Space direction="vertical" size={14} style={{ width: '100%' }}>
                        {TEST_PROTOCOLS.map((protocol) => {
                          const value = editing?.locked_user_agents?.[protocol.value] ?? ''
                          return (
                            <div key={protocol.value} style={{ width: '100%' }}>
                              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                                <Typography.Text strong>{protocol.label}</Typography.Text>
                                {editing && (
                                  <Button
                                    size="small"
                                    danger
                                    disabled={!value}
                                    onClick={async () => {
                                      try {
                                        const updated = await api.admin.clearChannelUserAgent(editing.id, protocol.value)
                                        setEditing(updated)
                                        form.setFieldsValue({
                                          lock_user_agent: updated.lock_user_agent,
                                          locked_user_agents: updated.locked_user_agents,
                                        })
                                        onPatched(updated)
                                        message.success('已清除该协议 UA 配置')
                                      } catch (error) {
                                        message.error(error instanceof Error ? error.message : '清除 UA 失败')
                                      }
                                    }}
                                  >
                                    清除
                                  </Button>
                                )}
                              </Space>
                              <Form.Item
                                name={['locked_user_agents', protocol.value]}
                                style={{ marginBottom: 0, marginTop: 6 }}
                              >
                                <Input.TextArea
                                  className="mono"
                                  autoSize={{ minRows: 2, maxRows: 5 }}
                                  placeholder={`${protocol.label} 的上游 UA（可留空）`}
                                />
                              </Form.Item>
                            </div>
                          )
                        })}
                      </Space>
                    </Card>

                    {/* The UA note lives here rather than above the fields it
                        describes: this is the one place an operator can write a
                        User-Agent that silently loses to the locked one. */}
                    <Form.Item
                      name="headers"
                      label="附加请求头"
                      tooltip="每行一个头，写成 Header-Name: value，可从 curl 或浏览器直接粘贴。其中的 User-Agent 会被上方锁定的 UA 覆盖"
                    >
                      <Input.TextArea
                        className="mono"
                        autoSize={{ minRows: 2, maxRows: 6 }}
                        placeholder={'X-Custom: value\nAuthorization: Bearer abc123=='}
                      />
                    </Form.Item>

                    <Form.Item name="proxy_url" label="HTTP 代理" tooltip="例如 http://127.0.0.1:7890">
                      <Input placeholder="留空表示直连" />
                    </Form.Item>

                    <Divider style={{ margin: '4px 0 12px' }} />

                    {/* Keepalive owns the channel's status while it runs, which
                        is why it sits with the other things that change how the
                        channel behaves rather than in the main form. */}
                    <Row gutter={16}>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="keepalive_enabled"
                          label="保活"
                          valuePropName="checked"
                          tooltip="为会回收闲置账号的上游准备：每天定时把禁用中的渠道自动启用，攒够成功请求后自动禁用。到点时渠道本来就是启用状态，则不开窗、不接管"
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="keepalive_at"
                          label="每天启用时间"
                          tooltip="按服务器时区。服务端在该时刻停机时，启动后当天会补开一次。过了这个时刻，渠道一旦被禁用就会立刻开窗"
                          rules={[
                            {
                              // Only required once keepalive is on: a channel
                              // that claims to be kept alive and never opens is
                              // worse than a rejected form.
                              validator: (_, value) =>
                                !keepaliveOn || value
                                  ? Promise.resolve()
                                  : Promise.reject(new Error('开启保活需要填写时间')),
                            },
                          ]}
                        >
                          <TimePicker
                            format="HH:mm"
                            minuteStep={5}
                            disabled={!keepaliveOn}
                            placeholder="03:00"
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="keepalive_target"
                          label="目标成功次数"
                          tooltip="窗口内累计这么多次成功请求后自动禁用该渠道。次数由真实流量产生，攒不满就一直开着"
                          rules={[
                            {
                              validator: (_, value) =>
                                !keepaliveOn || Number(value) >= 1
                                  ? Promise.resolve()
                                  : Promise.reject(new Error('至少 1 次')),
                            },
                          ]}
                        >
                          <InputNumber
                            min={0}
                            precision={0}
                            disabled={!keepaliveOn}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    {keepaliveOn && editing?.keepalive_open && (
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={`保活窗口进行中：已成功 ${editing.keepalive_success}/${editing.keepalive_target} 次`}
                        description="保存表单不会重置进度；把状态改为禁用会放弃本轮窗口，次日到点再开。"
                      />
                    )}
                  </>
                ),
              },
            ]}
          />

          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="仅管理员可见" />
          </Form.Item>
        </Form>
      </Drawer>

      {/* The selection is just another unsaved edit: it lands in the form and
          is committed with everything else. */}
      <ModelPickerModal
        state={picker}
        verb="填入"
        onCancel={() => setPicker(null)}
        onApply={(models) => {
          form.setFieldValue('models', models)
          setPicker(null)
          message.success(`已填入 ${models.length} 个模型，保存后生效`)
        }}
      />
    </>
  )
}
