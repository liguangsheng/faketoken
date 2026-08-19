import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { CopyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'

import { api, type Token, type UserGroup } from '../api/client'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import { useSettings } from '../settings/SettingsContext'
import { copyTextToClipboard } from '../utils/clipboard'
import {
  formatDateMinute,
  formatMoney,
  formatRelative,
  formatTime,
  formatTimeShort,
  formatUSD,
  STATUS,
  toUSD,
} from '../utils/format'

interface FormValues {
  name: string
  status: number
  unlimited_quota: boolean
  quota_usd: number
  rpm_limit: number
  allowed_models: string[]
  group: string
  key: string
  expires_at: Dayjs | null
}

/**
 * Below this a key stops being something an attacker has to steal and becomes
 * something they can guess, so it takes an explicit confirmation. Mirrors
 * auth.MinRecommendedKeyLength, which is what actually enforces it.
 */
const MIN_KEY_LENGTH = 16

const ENDPOINTS = [
  {
    key: 'openai',
    label: 'OpenAI 兼容',
    suffix: '/v1',
    hint: '填入 Base URL，鉴权用 Authorization: Bearer',
    curl: (origin: string, key: string) =>
      `curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'`,
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    suffix: '',
    hint: '原生 /v1/messages，鉴权用 x-api-key',
    curl: (origin: string, key: string) =>
      `curl ${origin}/v1/messages \\\n  -H "x-api-key: ${key}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"claude-sonnet-4","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`,
  },
  {
    key: 'gemini',
    label: 'Gemini',
    suffix: '',
    hint: '原生 /v1beta，密钥也可放在 ?key= 上',
    curl: (origin: string, key: string) =>
      `curl "${origin}/v1beta/models/gemini-2.5-pro:generateContent" \\\n  -H "x-goog-api-key: ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`,
  },
]

export default function Tokens() {
  const { message, modal } = App.useApp()
  const [rows, setRows] = useState<Token[]>([])
  const [total, setTotal] = useState(0)
  const { defaultPageSize } = useSettings()
  // Offered by the server, which is also the thing that enforces the choice.
  const [groups, setGroups] = useState<UserGroup[]>([])
  const [ownGroup, setOwnGroup] = useState('default')
  const [copyingId, setCopyingId] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  // The endpoint examples are onboarding; regulars fold them away for good.
  const [endpointsCollapsed, setEndpointsCollapsed] = useState(
    () => localStorage.getItem('faketoken-endpoints-collapsed') === '1',
  )
  const [editing, setEditing] = useState<Token | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [newKey, setNewKey] = useState<string | null>(null)
  const [form] = Form.useForm<FormValues>()

  const origin = window.location.origin

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.listTokens({ page, page_size: pageSize })
      setRows(result.data ?? [])
      setTotal(result.total)
      setLoadError(null)
    } catch (error) {
      // Both surfaces on purpose: the empty-state branch is invisible while
      // stale rows are still on screen, and the toast alone evaporates.
      const text = error instanceof Error ? error.message : '加载失败'
      setLoadError(text)
      message.error(text)
    } finally {
      setLoading(false)
    }
  }, [message, page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api
      .myModels()
      .then((result) => setModels(result.data ?? []))
      .catch(() => setModels([]))
    api
      .myGroups()
      .then((result) => {
        setGroups(result.data ?? [])
        setOwnGroup(result.own || 'default')
      })
      .catch(() => setGroups([]))
  }, [])

  const modelOptions = useMemo(
    () => models.map((model) => ({ value: model, label: model })),
    [models],
  )

  const openModal = (token?: Token) => {
    setEditing(token ?? null)
    form.setFieldsValue(
      token
        ? {
            name: token.name,
            status: token.status,
            unlimited_quota: token.unlimited_quota,
            quota_usd: toUSD(token.quota),
            rpm_limit: token.rpm_limit ?? 0,
            allowed_models: token.allowed_models ?? [],
            // Empty means "follow my account" — a real choice in the dropdown,
            // so it round-trips instead of being silently pinned on save.
            group: token.group || '',
            // Deliberately blank: the current secret is not fetched just to
            // open the form, and blank already means "leave it alone".
            key: '',
            expires_at: token.expires_at ? dayjs(token.expires_at) : null,
          }
        : {
            name: '',
            status: STATUS.ENABLED,
            unlimited_quota: true,
            quota_usd: 0,
            rpm_limit: 0,
            allowed_models: [],
            group: '',
            key: '',
            expires_at: null,
          },
    )
    setOpen(true)
  }

  // Fetched on demand rather than carried in the list, so a key only travels
  // when someone actually asks for it.
  const copyKey = async (token: Token) => {
    setCopyingId(token.id)
    try {
      const { key } = await api.revealToken(token.id)
      // copyTextToClipboard falls back to execCommand where the clipboard API
      // refuses (plain-HTTP deployments), so a click just copies — no dialog.
      if (await copyTextToClipboard(key)) {
        message.success(`已复制「${token.name}」的密钥`)
      } else {
        message.error('复制失败：浏览器不允许访问剪贴板')
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '获取密钥失败')
    } finally {
      setCopyingId(null)
    }
  }

  const submit = async () => {
    const values = await form.validateFields()
    const key = (values.key ?? '').trim()

    // Ask before accepting a guessable key. The server refuses it without the
    // acknowledgement below, so this dialog is the explanation rather than the
    // control.
    let confirmWeakKey = false
    if (key && [...key].length < MIN_KEY_LENGTH) {
      confirmWeakKey = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: `密钥只有 ${[...key].length} 位`,
          content: `短密钥容易被猜到，任何猜中的人都能直接消耗这个密钥的额度。建议至少 ${MIN_KEY_LENGTH} 位。确定要继续吗？`,
          okText: '仍然使用',
          okButtonProps: { danger: true },
          cancelText: '返回修改',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      if (!confirmWeakKey) return
    }

    const payload = {
      name: values.name,
      status: values.status ?? STATUS.ENABLED,
      unlimited_quota: values.unlimited_quota,
      quota_usd: values.unlimited_quota ? 0 : Number(values.quota_usd ?? 0),
      rpm_limit: Number(values.rpm_limit ?? 0),
      allowed_models: values.allowed_models ?? [],
      group: values.group ?? '',
      key,
      confirm_weak_key: confirmWeakKey,
      expires_at: values.expires_at ? values.expires_at.toISOString() : null,
    }

    setSaving(true)
    try {
      if (editing) {
        await api.updateToken(editing.id, payload)
        message.success(key ? '已保存，密钥已更换' : '已保存')
      } else {
        const created = await api.createToken(payload)
        setNewKey(created.key)
      }
      setOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // The update endpoint replaces the whole row, so echo every field back —
  // dropping one (group, say) silently rewrites it to its zero value.
  const toggleStatus = async (row: Token, enabled: boolean) => {
    setTogglingId(row.id)
    try {
      await api.updateToken(row.id, {
        name: row.name,
        status: enabled ? STATUS.ENABLED : STATUS.DISABLED,
        unlimited_quota: row.unlimited_quota,
        quota_usd: toUSD(row.quota),
        rpm_limit: row.rpm_limit,
        allowed_models: row.allowed_models ?? [],
        group: row.group,
        expires_at: row.expires_at,
      })
      message.success(enabled ? '密钥已启用' : '密钥已禁用')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <>
      <PageHeader
        title="API 密钥"
        description="把密钥填进任意兼容客户端即可开始调用；列表中可随时复制完整密钥。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              新建密钥
            </Button>
          </>
        }
      />

      <Card
        size="small"
        title="接入地址"
        style={{ marginBottom: 12 }}
        extra={
          <Button
            type="text"
            size="small"
            onClick={() => {
              setEndpointsCollapsed((value) => {
                localStorage.setItem('faketoken-endpoints-collapsed', value ? '0' : '1')
                return !value
              })
            }}
          >
            {endpointsCollapsed ? '展开示例' : '收起'}
          </Button>
        }
        // Collapsed still answers the one daily question — the Base URL —
        // without a screen of curl examples between the title and the table.
        styles={endpointsCollapsed ? { body: { paddingBlock: 10 } } : undefined}
      >
        {endpointsCollapsed ? (
          <Space wrap size={[16, 4]}>
            {ENDPOINTS.map((endpoint) => (
              <Space key={endpoint.key} size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {endpoint.label}
                </Typography.Text>
                <Typography.Text className="mono" copyable code>
                  {origin + endpoint.suffix}
                </Typography.Text>
              </Space>
            ))}
          </Space>
        ) : (
          <Tabs
            size="small"
            items={ENDPOINTS.map((endpoint) => ({
              key: endpoint.key,
              label: endpoint.label,
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Base URL
                    </Typography.Text>
                    <Typography.Text className="mono" copyable code>
                      {origin + endpoint.suffix}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {endpoint.hint}
                    </Typography.Text>
                  </Space>
                  <div style={{ position: 'relative' }}>
                    {/* Right padding keeps the floating copy chip off the text. */}
                    <pre className="code-block" style={{ paddingInlineEnd: 36 }}>
                      {endpoint.curl(origin, 'sk-你的密钥')}
                    </pre>
                    <Typography.Text
                      copyable={{
                        text: endpoint.curl(origin, 'sk-你的密钥'),
                        tooltips: '复制示例',
                      }}
                      style={{
                        background: 'var(--app-surface-sunken)',
                        borderRadius: 6,
                        padding: '0 4px',
                        position: 'absolute',
                        insetInlineEnd: 8,
                        insetBlockStart: 8,
                      }}
                    />
                  </div>
                </Space>
              ),
            }))}
          />
        )}
      </Card>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        // Must cover the sum of the column widths below. If it is smaller the
        // browser shrinks every column to fit, and the crushed cells collide
        // instead of scrolling.
        scroll={{ x: 1460 }}
        locale={{
          emptyText: loadError ? (
            <EmptyState
              title="加载失败"
              description={loadError}
              action={
                <Button type="primary" icon={<ReloadOutlined />} onClick={() => void load()}>
                  重试
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="还没有 API 密钥"
              description="创建一个密钥，就能把上面的地址填进任意客户端了。"
              action={
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
                  新建密钥
                </Button>
              }
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          hideOnSinglePage: total <= 10,
          showTotal: (count) => `共 ${count} 个密钥`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            title: '名称 / 密钥',
            dataIndex: 'name',
            width: 250,
            render: (name: string, row) => (
              <div style={{ display: 'grid', gap: 2 }}>
                <Typography.Text strong ellipsis={{ tooltip: name }} style={{ maxWidth: 220 }}>
                  {name}
                </Typography.Text>
                <Space size={4}>
                  <span className="mono text-muted">{row.key_prefix}</span>
                  <Tooltip title="复制完整密钥">
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      loading={copyingId === row.id}
                      aria-label={`复制密钥 ${name}`}
                      onClick={() => void copyKey(row)}
                    />
                  </Tooltip>
                </Space>
              </div>
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 130,
            render: (status: number, row) => {
              const expired = row.expires_at ? dayjs(row.expires_at).isBefore(dayjs()) : false
              return (
                <Space size={6}>
                  <Switch
                    size="small"
                    checked={status === STATUS.ENABLED}
                    loading={togglingId === row.id}
                    aria-label={`启用或禁用密钥 ${row.name}`}
                    onChange={(checked) => void toggleStatus(row, checked)}
                  />
                  {expired && <Tag color="red">已过期</Tag>}
                </Space>
              )
            },
          },
          {
            title: '额度',
            width: 170,
            render: (_, row) => {
              if (row.unlimited_quota) {
                return (
                  <Tooltip title="不单独限额，只受账户余额约束">
                    <Tag color="blue">不限额度</Tag>
                  </Tooltip>
                )
              }
              const totalQuota = row.quota + row.used_quota
              // The bar shows what remains, matching the number beside it: a
              // full bar means plenty left, a red sliver means nearly spent.
              const remaining = totalQuota > 0 ? (row.quota / totalQuota) * 100 : 0
              // Sub-cent balances still bill; "$0.00" would look like a bug.
              const remainingText =
                row.quota > 0 && row.quota < 10_000 ? formatUSD(row.quota) : formatMoney(row.quota)
              return (
                <div style={{ display: 'grid', gap: 2, minWidth: 130 }}>
                  <span style={{ fontSize: 12 }}>
                    剩余 <strong>{remainingText}</strong>
                  </span>
                  <Progress
                    percent={remaining}
                    showInfo={false}
                    size="small"
                    status={remaining <= 5 ? 'exception' : 'normal'}
                  />
                </div>
              )
            },
          },
          {
            title: '分组',
            dataIndex: 'group',
            width: 120,
            ellipsis: true,
            render: (group: string) => {
              const effective = group || ownGroup
              const rate = groups.find((item) => item.name === effective)?.rate
              return (
                <Tooltip
                  title={
                    group
                      ? `该密钥固定使用「${group}」分组`
                      : `跟随账号分组（当前为「${ownGroup}」）`
                  }
                >
                  {/* Blue is the site-wide colour for group tags; a followed
                      (unpinned) group stays neutral. */}
                  <Tag color={group ? 'blue' : undefined}>
                    {effective}
                    {rate !== undefined && rate !== 1 && ` ×${rate}`}
                  </Tag>
                </Tooltip>
              )
            },
          },
          {
            title: '已用',
            dataIndex: 'used_quota',
            width: 110,
            align: 'right',
            render: (value: number) => formatMoney(value),
          },
          {
            title: 'RPM',
            dataIndex: 'rpm_limit',
            width: 90,
            align: 'right',
            render: (value: number) =>
              value > 0 ? (
                <Tooltip title={`每分钟最多 ${value} 次请求，超出返回 429`}>
                  <span className="mono">{value}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">不限</span>
              ),
          },
          {
            title: '可用模型',
            dataIndex: 'allowed_models',
            width: 160,
            render: (list: string[]) => {
              if (!list?.length) return <Tag color="blue">全部</Tag>
              return (
                <div className="tag-list">
                  {list.slice(0, 2).map((model) => (
                    <Tag key={model} className="mono">
                      {model}
                    </Tag>
                  ))}
                  {list.length > 2 && (
                    <Tooltip title={list.join('、')}>
                      <Tag>+{list.length - 2}</Tag>
                    </Tooltip>
                  )}
                </div>
              )
            },
          },
          {
            title: '过期时间',
            dataIndex: 'expires_at',
            width: 170,
            render: (value: string | null) => {
              if (!value) return <span className="text-muted">永不过期</span>
              const expired = dayjs(value).isBefore(dayjs())
              return (
                <Tooltip title={formatTime(value)}>
                  {/* The date answers "when", the line under it answers "how
                      soon" — the relative form alone forces a mental
                      calculation for something worth being exact about. */}
                  <div className="cell-stack">
                    <span style={{ color: expired ? 'var(--app-danger)' : undefined }}>
                      {formatDateMinute(value)}
                    </span>
                    <span className="text-muted cell-stack__sub">{formatRelative(value)}</span>
                  </div>
                </Tooltip>
              )
            },
          },
          {
            title: '最后使用',
            dataIndex: 'last_used_at',
            width: 140,
            render: (value: string | null) =>
              value ? (
                <Tooltip title={formatTime(value)}>
                  <div className="cell-stack">
                    <span>{formatTimeShort(value)}</span>
                    <span className="text-muted cell-stack__sub">{formatRelative(value)}</span>
                  </div>
                </Tooltip>
              ) : (
                <span className="text-muted">从未使用</span>
              ),
          },
          {
            title: '操作',
            width: 120,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => openModal(row)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除这个密钥？"
                  description="使用该密钥的客户端会立即失效，且无法恢复。"
                  okButtonProps={{ danger: true }}
                  okText="删除"
                  onConfirm={async () => {
                    try {
                      await api.deleteToken(row.id)
                      message.success('已删除')
                      // Deleting the page's last row must not strand the view
                      // on an empty page while the pager still shows a total.
                      if (rows.length === 1 && page > 1) {
                        setPage(page - 1)
                      } else {
                        await load()
                      }
                    } catch (error) {
                      message.error(error instanceof Error ? error.message : '删除失败')
                    }
                  }}
                >
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? `编辑密钥：${editing.name}` : '新建密钥'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        okText={editing ? '保存' : '创建'}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          style={{ marginTop: 16 }}
          onFinish={() => void submit()}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
            tooltip="只用于你自己辨认，例如「本地开发」「线上服务」"
          >
            <Input placeholder="例如：本地开发" maxLength={64} showCount />
          </Form.Item>

          <Form.Item
            name="key"
            label="自定义密钥"
            tooltip={
              editing
                ? '留空表示不修改。填写后旧密钥立即失效，正在使用它的客户端都要改配置。'
                : `留空则自动生成一个随机密钥。建议至少 ${MIN_KEY_LENGTH} 位。`
            }
            rules={[
              {
                validator: (_, value: string) => {
                  const raw = (value ?? '').trim()
                  if (!raw) return Promise.resolve()
                  if (/\s/.test(raw)) {
                    // It is sent in an HTTP header, where whitespace would be
                    // mangled or split the header outright.
                    return Promise.reject(new Error('密钥不能包含空格或换行'))
                  }
                  if (raw.length > 200) {
                    return Promise.reject(new Error('密钥不能超过 200 个字符'))
                  }
                  return Promise.resolve()
                },
              },
            ]}
          >
            {/* Masked by default: a key typed on a shared screen is a leak. */}
            <Input.Password
              placeholder={editing ? '留空表示不修改' : '留空自动生成'}
              autoComplete="new-password"
              maxLength={200}
              allowClear
            />
          </Form.Item>

          {editing && (
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: STATUS.ENABLED, label: '启用' },
                  { value: STATUS.DISABLED, label: '禁用' },
                ]}
              />
            </Form.Item>
          )}

          <Form.Item
            name="unlimited_quota"
            label="不限额度"
            valuePropName="checked"
            tooltip="关闭后该密钥单独拥有一份额度，用完即停，不影响账户其他密钥"
          >
            <Switch />
          </Form.Item>

          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue('unlimited_quota') ? null : (
                <Form.Item
                  name="quota_usd"
                  label="剩余额度（美元）"
                  tooltip={
                    editing
                      ? `设置的是剩余可用金额；该密钥已消费 ${formatMoney(editing.used_quota)}，不计入此数`
                      : '设置的是可用金额，用完即停'
                  }
                  extra="0 表示没有可用额度，密钥将无法调用。"
                >
                  <InputNumber min={0} step={1} style={{ width: '100%' }} addonBefore="$" />
                </Form.Item>
              )
            }
          </Form.Item>

          <Form.Item
            name="rpm_limit"
            label="RPM 限制"
            tooltip="这个密钥每分钟最多发起的请求数，超出的请求会收到 429；0 表示不限制"
          >
            <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="次 / 分钟" />
          </Form.Item>

          <Form.Item
            name="group"
            label="分组"
            tooltip="决定这个密钥能路由到哪些渠道，以及计费倍率；只列出管理员开放给你的分组"
          >
            <Select
              options={[
                {
                  value: '',
                  label: (
                    <Space size={6}>
                      <span>跟随账号分组</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        当前「{ownGroup}」
                      </Typography.Text>
                    </Space>
                  ),
                },
                ...groups.map((group) => ({
                  value: group.name,
                  label: (
                    <Space size={6}>
                      <span>{group.name}</span>
                      {group.rate !== 1 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          ×{group.rate}
                        </Typography.Text>
                      )}
                      {group.name === ownGroup && <Tag>默认</Tag>}
                    </Space>
                  ),
                })),
              ]}
            />
          </Form.Item>

          <Form.Item name="allowed_models" label="可用模型" tooltip="留空表示允许分组内的全部模型">
            <Select
              mode="multiple"
              allowClear
              showSearch
              maxTagCount="responsive"
              placeholder="留空 = 全部模型"
              options={modelOptions}
              notFoundContent="当前分组暂无可用模型"
            />
          </Form.Item>

          <Form.Item
            name="expires_at"
            label="过期时间"
            tooltip="留空表示永不过期"
            rules={[
              {
                // disabledDate only blocks past days; a past hour today would
                // create a key that is born expired.
                validator: (_, value: Dayjs | null) =>
                  !value || value.isAfter(dayjs())
                    ? Promise.resolve()
                    : Promise.reject(new Error('过期时间需晚于当前时刻')),
              },
            ]}
          >
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              style={{ width: '100%' }}
              placeholder="留空表示永不过期"
              disabledDate={(date) => date.isBefore(dayjs().startOf('day'))}
            />
          </Form.Item>
          {/* Lets Enter submit from any field. */}
          <button type="submit" hidden />
        </Form>
      </Modal>


      <Modal
        open={Boolean(newKey)}
        title="密钥创建成功"
        width={640}
        onCancel={() => setNewKey(null)}
        footer={[
          <Button key="close" onClick={() => setNewKey(null)}>
            关闭
          </Button>,
          // Copying is the whole point of this dialog, so it takes the
          // primary spot instead of hiding behind a small inline icon.
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => {
              void copyTextToClipboard(newKey ?? '').then((copied) =>
                copied
                  ? message.success('已复制密钥')
                  : message.warning('浏览器拒绝了剪贴板访问，请手动选中复制'),
              )
            }}
          >
            复制密钥
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          message="密钥已加密保存"
          description="现在复制填入客户端；之后也随时可以在列表中重新复制。"
          style={{ marginBottom: 12 }}
        />
        <Typography.Paragraph
          copyable={{ text: newKey ?? '', tooltips: ['复制密钥', '已复制'] }}
          className="mono"
          style={{
            background: 'var(--app-surface-sunken)',
            border: '1px solid var(--app-border)',
            borderRadius: 10,
            marginBottom: 12,
            padding: '10px 12px',
            wordBreak: 'break-all',
          }}
        >
          {newKey}
        </Typography.Paragraph>
        <Tabs
          size="small"
          items={ENDPOINTS.map((endpoint) => ({
            key: endpoint.key,
            label: endpoint.label,
            children: (
              <div style={{ position: 'relative' }}>
                <pre className="code-block" style={{ paddingInlineEnd: 36 }}>
                  {endpoint.curl(origin, newKey ?? '')}
                </pre>
                <Typography.Text
                  copyable={{
                    text: endpoint.curl(origin, newKey ?? ''),
                    tooltips: '复制命令',
                  }}
                  style={{
                    background: 'var(--app-surface-sunken)',
                    borderRadius: 6,
                    padding: '0 4px',
                    position: 'absolute',
                    insetInlineEnd: 8,
                    insetBlockStart: 8,
                  }}
                />
              </div>
            ),
          }))}
        />
      </Modal>
    </>
  )
}
