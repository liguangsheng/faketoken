import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CloudDownloadOutlined,
  CopyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons'

import {
  api,
  type BillingSettings,
  type ModelPrice,
  type PriceCatalog,
  type UnpricedPolicy,
  type UnpricedReport,
} from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useSettings } from '../../settings/SettingsContext'
import { formatRelative, formatTime } from '../../utils/format'

const POLICY_LABEL: Record<UnpricedPolicy, string> = {
  reject: '拒绝请求',
  fallback: '按兜底价计费',
  free: '免费放行',
}

const EMPTY_PRICE: ModelPrice = {
  model: '',
  input_price: 0,
  output_price: 0,
  cached_price: 0,
  per_request_price: 0,
}

/** How many unpriced models to show before collapsing the rest into a count. */
const MAX_MISSING_TAGS = 24

const money = (value: number) => (value ? `$${value}` : null)

export default function Prices() {
  const { message, modal } = App.useApp()
  // Named apart from the billing `settings` below, which is a different thing.
  const { defaultPageSize } = useSettings()
  const [rows, setRows] = useState<ModelPrice[]>([])
  const [catalog, setCatalog] = useState<PriceCatalog | null>(null)
  const [settings, setSettings] = useState<BillingSettings | null>(null)
  const [unpriced, setUnpriced] = useState<UnpricedReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [editing, setEditing] = useState<ModelPrice | null>(null)
  const [form] = Form.useForm<ModelPrice>()
  const [policyForm] = Form.useForm<BillingSettings>()
  const policy = Form.useWatch('unpriced_policy', policyForm)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [prices, billing, missing] = await Promise.all([
        api.admin.listPrices(),
        api.admin.billingSettings(),
        api.admin.unpricedModels(),
      ])
      setRows(prices.data ?? [])
      setCatalog(prices.catalog ?? null)
      setSettings(billing)
      setUnpriced(missing)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const openModal = (price?: ModelPrice, duplicate = false) => {
    setEditing(duplicate ? null : (price ?? null))
    form.setFieldsValue(price ? { ...price, model: duplicate ? '' : price.model } : EMPTY_PRICE)
    setOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      await api.admin.upsertPrice(values)
      message.success('已保存')
      setOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const openPolicy = () => {
    policyForm.setFieldsValue(
      settings ?? {
        unpriced_policy: 'reject',
        fallback: { input_price: 0, output_price: 0, cached_price: 0, per_request_price: 0 },
      },
    )
    setPolicyOpen(true)
  }

  const submitPolicy = async () => {
    const values = await policyForm.validateFields()
    try {
      const saved = await api.admin.updateBillingSettings(values)
      setSettings(saved)
      message.success('计费策略已更新')
      setPolicyOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  // The built-in table is a models.dev snapshot compiled into the binary, so
  // importing needs no network access and is safe to repeat.
  const importCatalog = (overwrite: boolean) => {
    modal.confirm({
      title: overwrite ? '用内置价格表覆盖同名模型？' : '导入内置价格表？',
      width: 480,
      content: (
        <div style={{ fontSize: 13 }}>
          <p style={{ marginTop: 8 }}>
            内置价格表来自 <strong>{catalog?.source ?? 'models.dev'}</strong>
            {catalog ? `（${catalog.generated_at} 快照，${catalog.total} 个模型）` : ''}。
          </p>
          <p style={{ marginBottom: 0 }}>
            {overwrite
              ? '同名模型的价格会被快照覆盖，你手工调整过的单价将丢失；表里已有但快照没有的模型不受影响。'
              : '只会写入当前价格表里没有的模型，已有的价格一律保留。'}
          </p>
        </div>
      ),
      okText: '开始导入',
      okButtonProps: { danger: overwrite },
      onOk: async () => {
        setImporting(true)
        try {
          const result = await api.admin.importPrices(overwrite)
          message.success(
            `导入完成：写入 ${result.imported} 个模型，跳过 ${result.skipped} 个已有条目`,
          )
          await load()
        } catch (error) {
          message.error(error instanceof Error ? error.message : '导入失败')
        } finally {
          setImporting(false)
        }
      },
    })
  }

  const filtered = useMemo(
    () => rows.filter((row) => row.model.toLowerCase().includes(keyword.trim().toLowerCase())),
    [rows, keyword],
  )

  const current = settings?.unpriced_policy ?? 'reject'
  const missing = unpriced?.data ?? []
  const missingCount = unpriced?.total ?? 0

  return (
    <>
      <PageHeader
        title="模型价格"
        description={
          <>
            单位是「美元 / 100 万 Token」，查找支持最长前缀匹配：配置了 gpt-4o
            后，gpt-4o-2024-11-20 自动沿用该价格。
            {catalog && (
              <>
                {' '}
                内置价格表来自 {catalog.source}（{catalog.generated_at} 快照 · {catalog.total} 个模型）。
              </>
            )}
          </>
        }
        extra={
          <>
            <Input
              allowClear
              placeholder="搜索模型"
              style={{ width: 180 }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button icon={<SettingOutlined />} onClick={openPolicy}>
              计费策略
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'missing', label: '只补充缺失的模型' },
                  { key: 'overwrite', label: '覆盖同名模型的价格', danger: true },
                ],
                onClick: ({ key }) => importCatalog(key === 'overwrite'),
              }}
            >
              <Button icon={<CloudDownloadOutlined />} loading={importing}>
                导入内置价格
              </Button>
            </Dropdown>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              新增价格
            </Button>
          </>
        }
      />

      <Alert
        style={{ marginBottom: 12 }}
        type={current === 'free' ? 'warning' : 'info'}
        showIcon
        message={
          <Space wrap>
            <span>未配价模型的处理方式：</span>
            <Tag color={current === 'free' ? 'orange' : current === 'reject' ? 'blue' : 'gold'}>
              {POLICY_LABEL[current]}
            </Tag>
          </Space>
        }
        description={
          current === 'reject'
            ? '未配置价格的模型会被直接拒绝（HTTP 403），不会消耗上游额度。'
            : current === 'fallback'
              ? `未配置价格的模型按兜底价计费：输入 $${settings?.fallback.input_price ?? 0} / 输出 $${
                  settings?.fallback.output_price ?? 0
                }（每 100 万 Token）。`
              : '未配置价格的模型会被免费放行且不扣费，用量仍会记录。这是收入漏洞，仅在刻意运营免费网关时使用。'
        }
      />

      {missingCount > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type={current === 'reject' ? 'warning' : 'error'}
          showIcon
          message={`有 ${missingCount} 个模型正在被渠道提供，但没有配置价格`}
          description={
            <>
              <div style={{ marginBottom: 8 }}>
                {current === 'reject'
                  ? '这些模型当前会被拒绝，用户无法调用。点标签可以直接补价格，或者一键导入内置价格表。'
                  : current === 'free'
                    ? '这些模型正在被免费调用，成本由你承担。请立即补齐价格。'
                    : '这些模型正在按兜底价计费，价格可能与真实成本有偏差。'}
              </div>
              <div className="tag-list" style={{ marginBottom: 10 }}>
                {missing.slice(0, MAX_MISSING_TAGS).map((name) => (
                  <Tooltip key={name} title="点击为该模型配置价格">
                    <Tag
                      color="red"
                      className="mono"
                      style={{ cursor: 'pointer' }}
                      onClick={() => openModal({ ...EMPTY_PRICE, model: name })}
                    >
                      {name}
                    </Tag>
                  </Tooltip>
                ))}
                {missing.length > MAX_MISSING_TAGS && (
                  <Tooltip title={missing.slice(MAX_MISSING_TAGS).join('、')}>
                    <Tag>+{missing.length - MAX_MISSING_TAGS}</Tag>
                  </Tooltip>
                )}
              </div>
              <Button
                size="small"
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={importing}
                onClick={() => importCatalog(false)}
              >
                导入内置价格表补齐
              </Button>
            </>
          }
        />
      )}

      <Table
        rowKey="model"
        loading={loading}
        dataSource={filtered}
        scroll={{ x: 1140 }}
        locale={{
          emptyText: (
            <EmptyState
              title={keyword ? '没有匹配的模型' : '还没有配置任何价格'}
              description={
                keyword
                  ? '换个关键词试试。'
                  : '可以直接导入内置价格表，再按自己的成本微调。'
              }
              action={
                keyword ? undefined : (
                  <Button
                    type="primary"
                    icon={<CloudDownloadOutlined />}
                    onClick={() => importCatalog(false)}
                  >
                    导入内置价格表
                  </Button>
                )
              }
            />
          ),
        }}
        pagination={{
          defaultPageSize,
          showSizeChanger: true,
          // Hiding the bar on a single page would also hide the size changer,
          // leaving no way back once a page size larger than the table is picked.
          hideOnSinglePage: false,
          showTotal: (count) => `共 ${count} 个模型`,
        }}
        columns={[
          {
            title: '模型',
            dataIndex: 'model',
            // The other columns are all fixed, so this one takes what is left.
            // scroll.x above is sized to leave it room: it is the row's
            // identity, and a model name runs to ~190px in the mono face.
            width: 330,
            ellipsis: true,
            sorter: (a, b) => a.model.localeCompare(b.model),
            render: (model: string) => (
              <Tooltip title={model}>
                <span className="mono">{model}</span>
              </Tooltip>
            ),
          },
          {
            title: '输入 / 1M',
            dataIndex: 'input_price',
            width: 130,
            align: 'right',
            sorter: (a, b) => a.input_price - b.input_price,
            render: (value: number) => money(value) ?? <span className="text-muted">免费</span>,
          },
          {
            title: '输出 / 1M',
            dataIndex: 'output_price',
            width: 130,
            align: 'right',
            sorter: (a, b) => a.output_price - b.output_price,
            render: (value: number) => money(value) ?? <span className="text-muted">免费</span>,
          },
          {
            title: '缓存输入 / 1M',
            dataIndex: 'cached_price',
            width: 150,
            align: 'right',
            render: (value: number) =>
              money(value) ?? <span className="text-muted">与输入同价</span>,
          },
          {
            title: '每次请求',
            dataIndex: 'per_request_price',
            width: 120,
            align: 'right',
            render: (value: number) =>
              value ? <Tag color="purple">${value}</Tag> : <span className="text-muted">-</span>,
          },
          {
            title: '更新时间',
            dataIndex: 'updated_at',
            width: 130,
            render: (value: string) => (
              <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
            ),
          },
          {
            title: '操作',
            width: 150,
            fixed: 'right',
            render: (_, row) => (
              <Space size={2}>
                <Button size="small" type="link" onClick={() => openModal(row)}>
                  编辑
                </Button>
                <Tooltip title="以这份价格为模板新增">
                  <Button
                    size="small"
                    type="link"
                    icon={<CopyOutlined />}
                    onClick={() => openModal(row, true)}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除这个价格？"
                  description={
                    current === 'reject'
                      ? '删除后该模型会被拒绝调用。'
                      : current === 'free'
                        ? '删除后该模型将被免费调用且不扣费。'
                        : '删除后该模型将按兜底价计费。'
                  }
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={async () => {
                    await api.admin.deletePrice(row.model)
                    message.success('已删除')
                    await load()
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
        title={editing ? `编辑价格：${editing.model}` : '新增价格'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="model"
            label="模型名"
            rules={[{ required: true, message: '请输入模型名' }]}
            tooltip="支持前缀匹配，填 gpt-4o 即可覆盖所有 gpt-4o-* 快照"
          >
            <Input disabled={Boolean(editing)} placeholder="gpt-4o" className="mono" />
          </Form.Item>
          <Form.Item name="input_price" label="输入价格">
            <InputNumber
              min={0}
              step={0.01}
              style={{ width: '100%' }}
              addonBefore="$"
              addonAfter="/ 1M tokens"
            />
          </Form.Item>
          <Form.Item name="output_price" label="输出价格">
            <InputNumber
              min={0}
              step={0.01}
              style={{ width: '100%' }}
              addonBefore="$"
              addonAfter="/ 1M tokens"
            />
          </Form.Item>
          <Form.Item name="cached_price" label="缓存输入价格" tooltip="填 0 表示与输入价格相同">
            <InputNumber
              min={0}
              step={0.01}
              style={{ width: '100%' }}
              addonBefore="$"
              addonAfter="/ 1M tokens"
            />
          </Form.Item>
          <Form.Item
            name="per_request_price"
            label="按次计费"
            tooltip="与 token 计费叠加，填 0 表示不启用"
          >
            <InputNumber
              min={0}
              step={0.001}
              style={{ width: '100%' }}
              addonBefore="$"
              addonAfter="/ 次"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={policyOpen}
        title="计费策略"
        onCancel={() => setPolicyOpen(false)}
        onOk={submitPolicy}
        destroyOnClose
      >
        <Form form={policyForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="unpriced_policy"
            label="模型未配置价格时"
            tooltip="默认拒绝：未配价的模型一旦放行就是在免费送上游额度"
          >
            <Select
              options={[
                { value: 'reject', label: '拒绝请求（推荐）' },
                { value: 'fallback', label: '按兜底价计费' },
                { value: 'free', label: '免费放行，不扣费' },
              ]}
            />
          </Form.Item>

          {policy === 'fallback' && (
            <>
              <Alert
                style={{ marginBottom: 16 }}
                type="info"
                showIcon
                message="兜底价至少要有一项大于 0，否则等同于免费放行。"
              />
              <Form.Item name={['fallback', 'input_price']} label="兜底输入价格（美元 / 1M Token）">
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} addonBefore="$" />
              </Form.Item>
              <Form.Item name={['fallback', 'output_price']} label="兜底输出价格（美元 / 1M Token）">
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} addonBefore="$" />
              </Form.Item>
              <Form.Item
                name={['fallback', 'cached_price']}
                label="兜底缓存输入价格（美元 / 1M Token）"
                tooltip="填 0 表示与输入价格相同"
              >
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} addonBefore="$" />
              </Form.Item>
              <Form.Item name={['fallback', 'per_request_price']} label="兜底按次计费（美元 / 次）">
                <InputNumber min={0} step={0.001} style={{ width: '100%' }} addonBefore="$" />
              </Form.Item>
            </>
          )}

          {policy === 'free' && (
            <Alert
              type="warning"
              showIcon
              message="未配价的模型将被免费放行"
              description="用量会记录但不扣费，用户余额和请求计数都不会变化。仅在刻意运营免费网关时使用。"
            />
          )}
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          改完策略后建议回到列表检查「未配置价格」提示，确认没有模型被意外拒绝或免费放行。
        </Typography.Text>
      </Modal>
    </>
  )
}
