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
import dayjs from 'dayjs'
import {
  BlockOutlined,
  CloudDownloadOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons'

import {
  api,
  type BillingSettings,
  type ModelPrice,
  type PriceCatalog,
  type PriceChange,
  type PriceImportPlan,
  type UnpricedPolicy,
  type UnpricedReport,
} from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useTableScrollX, type TableGeometry } from '../../hooks/useTableScrollX'
import { useSettings } from '../../settings/SettingsContext'
import { formatPrice, formatRelative, formatTime } from '../../utils/format'

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

const money = (value: number) => (value ? formatPrice(value) : null)

/**
 * The model name and the two prices every request is billed on stay at every
 * width — a price table that cannot show its prices has nothing left to be.
 * Cache and per-request pricing are set on far fewer models, so they wait for
 * the room.
 */
const COLUMN_GEOMETRY = {
  model: { width: 330 },
  input: { width: 130 },
  output: { width: 130 },
  cached: { width: 150, responsive: ['lg'] },
  perRequest: { width: 120, responsive: ['xl'] },
  updatedAt: { width: 130, responsive: ['xl'] },
  actions: { width: 150 },
} satisfies TableGeometry

/**
 * The dry-run diff: exactly the rows a write would add or rewrite. Prices bill
 * every request, so the operator sees the movement before it is applied.
 */
function PricePlanPreview({ plan }: { plan: PriceImportPlan }) {
  const delta = (before: number, after: number) => {
    if (before === after) return <span className="text-muted">{money(before) ?? '免费'}</span>
    return (
      <Space size={4}>
        <span className="text-muted" style={{ textDecoration: 'line-through' }}>
          {money(before) ?? '免费'}
        </span>
        <span>{money(after) ?? '免费'}</span>
      </Space>
    )
  }

  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ marginTop: 8 }}>
        models.dev 共 {plan.total} 个模型：新增 {plan.added.length} 个
        {plan.changed.length ? `，覆盖 ${plan.changed.length} 个改价` : ''}
        {plan.kept ? `，保留 ${plan.kept} 个已有价格` : ''}。
      </p>

      {plan.changed.length > 0 && (
        <Table
          rowKey="model"
          size="small"
          pagination={false}
          scroll={{ y: 240 }}
          dataSource={plan.changed}
          columns={[
            {
              title: '模型',
              dataIndex: 'model',
              width: 220,
              render: (model: string) => (
                <Typography.Text
                  className="mono"
                  ellipsis={{ tooltip: model }}
                  style={{ maxWidth: 200 }}
                >
                  {model}
                </Typography.Text>
              ),
            },
            {
              title: '输入 / 1M',
              align: 'right',
              render: (_: unknown, row: PriceChange) =>
                delta(row.old.input_price, row.new.input_price),
            },
            {
              title: '输出 / 1M',
              align: 'right',
              render: (_: unknown, row: PriceChange) =>
                delta(row.old.output_price, row.new.output_price),
            },
            {
              title: '缓存 / 1M',
              align: 'right',
              render: (_: unknown, row: PriceChange) =>
                delta(row.old.cached_price, row.new.cached_price),
            },
          ]}
        />
      )}

      {plan.added.length > 0 && (
        <div className="tag-list" style={{ marginTop: 10 }}>
          {plan.added.slice(0, MAX_MISSING_TAGS).map((row) => (
            <Tag key={row.model} className="mono">
              {row.model}
            </Tag>
          ))}
          {plan.added.length > MAX_MISSING_TAGS && (
            <Tag>…还有 {plan.added.length - MAX_MISSING_TAGS} 个</Tag>
          )}
        </div>
      )}
    </div>
  )
}

export default function Prices() {
  const { message, modal } = App.useApp()
  const scrollX = useTableScrollX(COLUMN_GEOMETRY)
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
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [page, setPage] = useState(1)
  const [showAllMissing, setShowAllMissing] = useState(false)
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

  /**
   * asNew opens the form in "create" mode while keeping whatever model name
   * was passed in — editable, so a missing model can be shortened to a prefix
   * before saving. Editing an existing row still locks the name.
   */
  const openModal = (price?: ModelPrice, asNew = false) => {
    setEditing(asNew ? null : (price ?? null))
    form.setFieldsValue(price ?? EMPTY_PRICE)
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
    if (
      values.unpriced_policy === 'fallback' &&
      !values.fallback.input_price &&
      !values.fallback.output_price &&
      !values.fallback.per_request_price
    ) {
      // The Alert says the rule; the form has to actually hold it.
      message.warning('兜底价至少要有一项大于 0，否则等同于免费放行')
      return
    }
    setSavingPolicy(true)
    try {
      const saved = await api.admin.updateBillingSettings(values)
      setSettings(saved)
      message.success('计费策略已更新')
      setPolicyOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSavingPolicy(false)
    }
  }

  const applyImport = async (overwrite: boolean) => {
    try {
      const written = await api.admin.importPrices(overwrite)
      message.success(
        `已写入 ${written.added.length} 个模型` +
          (written.changed.length ? `，覆盖 ${written.changed.length} 个` : ''),
      )
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '写入失败')
    }
  }

  // The pull happens on the server, so this is only the confirmation step. It
  // asks for a dry run first: a price is what every request is billed on, and
  // the diff is what makes the write reviewable.
  const importCatalog = async (overwrite: boolean) => {
    setImporting(true)
    try {
      const plan = await api.admin.importPrices(overwrite, true)
      if (!plan.added.length && !plan.changed.length) {
        message.info(
          plan.kept > 0
            ? `没有新增模型，${plan.kept} 个已有价格保留`
            : '价格表已和 models.dev 一致',
        )
        return
      }
      modal.confirm({
        title: overwrite ? '用 models.dev 覆盖同名模型的价格？' : '从 models.dev 补充价格表？',
        width: 720,
        content: <PricePlanPreview plan={plan} />,
        okText: overwrite ? '确认覆盖' : '确认写入',
        okButtonProps: { danger: overwrite },
        onOk: () => applyImport(overwrite),
      })
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拉取 models.dev 失败')
    } finally {
      setImporting(false)
    }
  }

  const filtered = useMemo(
    () => rows.filter((row) => row.model.toLowerCase().includes(keyword.trim().toLowerCase())),
    [rows, keyword],
  )

  // An empty URL means MODELS_DEV_URL is unset and the server refuses the
  // import; disabling the button beats a 503 the operator cannot explain.
  const catalogDisabled = !catalog?.url

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
                价格表来自 {catalog.source}
                {catalog.synced_at
                  ? `（最近同步 ${formatTime(catalog.synced_at)}）`
                  : '（尚未同步过）'}
                。
                {!catalog.url && '未配置 MODELS_DEV_URL，拉取功能已禁用。'}
              </>
            )}
          </>
        }
        extra={
          <>
            <Input
              allowClear
              placeholder="搜索模型"
              aria-label="搜索模型"
              style={{ width: 180, maxWidth: '100%' }}
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value)
                // 前端过滤下翻页残留会让搜索结果看起来是空的
                setPage(1)
              }}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button icon={<SettingOutlined />} onClick={openPolicy}>
              计费策略
            </Button>
            {/* 主按钮直接执行安全的默认动作，危险的覆盖收进菜单 */}
            <Dropdown.Button
              icon={undefined}
              loading={importing}
              disabled={catalogDisabled}
              onClick={() => void importCatalog(false)}
              menu={{
                items: [{ key: 'overwrite', label: '覆盖同名模型的价格', danger: true }],
                onClick: ({ key }) => void importCatalog(key === 'overwrite'),
              }}
            >
              <CloudDownloadOutlined /> 拉取最新价格
            </Dropdown.Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              新增价格
            </Button>
          </>
        }
      />

      {settings && (
      <Alert
        style={{ marginBottom: 12 }}
        type={current === 'free' ? 'warning' : 'info'}
        showIcon
        action={
          <Button size="small" onClick={openPolicy}>
            修改
          </Button>
        }
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
      )}

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
                  ? '这些模型当前会被拒绝，用户无法调用。点标签可以直接补价格，或者一键从 models.dev 拉取价格。'
                  : current === 'free'
                    ? '这些模型正在被免费调用，成本由你承担。请立即补齐价格。'
                    : '这些模型正在按兜底价计费，价格可能与真实成本有偏差。'}
              </div>
              <div className="tag-list" style={{ marginBottom: 10 }}>
                {(showAllMissing ? missing : missing.slice(0, MAX_MISSING_TAGS)).map((name) => (
                  <Tooltip key={name} title="点击为该模型配置价格">
                    <Tag
                      color="red"
                      className="mono tag-editable"
                      role="button"
                      tabIndex={0}
                      aria-label={`为 ${name} 配置价格`}
                      onClick={() => openModal({ ...EMPTY_PRICE, model: name }, true)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          openModal({ ...EMPTY_PRICE, model: name }, true)
                        }
                      }}
                    >
                      {name}
                    </Tag>
                  </Tooltip>
                ))}
                {missing.length > MAX_MISSING_TAGS && (
                  <Tag
                    className="tag-editable"
                    role="button"
                    tabIndex={0}
                    onClick={() => setShowAllMissing((value) => !value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setShowAllMissing((value) => !value)
                      }
                    }}
                  >
                    {showAllMissing ? '收起' : `展开全部 ${missing.length} 个`}
                  </Tag>
                )}
              </div>
              <Button
                size="small"
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={importing}
                disabled={catalogDisabled}
                onClick={() => void importCatalog(false)}
              >
                拉取价格表补齐
              </Button>
            </>
          }
        />
      )}

      <Table
        rowKey="model"
        size="small"
        loading={loading}
        dataSource={filtered}
        scroll={{ x: scrollX }}
        locale={{
          emptyText: (
            <EmptyState
              title={keyword ? '没有匹配的模型' : '还没有配置任何价格'}
              description={
                keyword
                  ? '换个关键词试试。'
                  : '可以从 models.dev 拉取价格表，再按自己的成本微调。'
              }
              action={
                keyword ? (
                  <Button onClick={() => setKeyword('')}>清除搜索</Button>
                ) : (
                  <Button
                    type="primary"
                    icon={<CloudDownloadOutlined />}
                    disabled={catalogDisabled}
                    onClick={() => void importCatalog(false)}
                  >
                    拉取价格表
                  </Button>
                )
              }
            />
          ),
        }}
        pagination={{
          current: page,
          defaultPageSize,
          showSizeChanger: true,
          // Hiding the bar on a single page would also hide the size changer,
          // leaving no way back once a page size larger than the table is picked.
          hideOnSinglePage: false,
          showTotal: (count) => `共 ${count} 个模型`,
          onChange: (nextPage) => setPage(nextPage),
        }}
        columns={[
          {
            ...COLUMN_GEOMETRY.model,
            title: '模型',
            dataIndex: 'model',
            sorter: (a, b) => a.model.localeCompare(b.model),
            render: (model: string) => (
              <Typography.Text className="mono" ellipsis={{ tooltip: model }} style={{ maxWidth: 310 }}>
                {model}
              </Typography.Text>
            ),
          },
          {
            ...COLUMN_GEOMETRY.input,
            title: '输入 / 1M',
            dataIndex: 'input_price',
            align: 'right',
            sorter: (a, b) => a.input_price - b.input_price,
            render: (value: number) => money(value) ?? <span className="text-muted">免费</span>,
          },
          {
            ...COLUMN_GEOMETRY.output,
            title: '输出 / 1M',
            dataIndex: 'output_price',
            align: 'right',
            sorter: (a, b) => a.output_price - b.output_price,
            render: (value: number) => money(value) ?? <span className="text-muted">免费</span>,
          },
          {
            ...COLUMN_GEOMETRY.cached,
            title: '缓存输入 / 1M',
            dataIndex: 'cached_price',
            align: 'right',
            render: (value: number, row) =>
              money(value) ??
              (row.input_price ? (
                <span className="text-muted">{money(row.input_price)}（同输入）</span>
              ) : (
                <span className="text-muted">免费</span>
              )),
          },
          {
            ...COLUMN_GEOMETRY.perRequest,
            title: '每次请求',
            dataIndex: 'per_request_price',
            align: 'right',
            render: (value: number) =>
              money(value) ?? <span className="text-muted">-</span>,
          },
          {
            ...COLUMN_GEOMETRY.updatedAt,
            title: '更新时间',
            dataIndex: 'updated_at',
            sorter: (a, b) => dayjs(a.updated_at ?? 0).valueOf() - dayjs(b.updated_at ?? 0).valueOf(),
            render: (value: string) => (
              <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
            ),
          },
          {
            ...COLUMN_GEOMETRY.actions,
            title: '操作',
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
                    icon={<BlockOutlined />}
                    aria-label={`以 ${row.model} 的价格为模板新增`}
                    onClick={() => openModal({ ...row, model: '' }, true)}
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
                    try {
                      await api.admin.deletePrice(row.model)
                      message.success('已删除')
                      await load()
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
        title={editing ? `编辑价格：${editing.model}` : '新增价格'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText={editing ? '保存' : '创建'}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} onFinish={() => void submit()}>
          <Form.Item
            name="model"
            label="模型名"
            rules={[{ required: true, message: '请输入模型名' }]}
            tooltip="支持前缀匹配，填 gpt-4o 即可覆盖所有 gpt-4o-* 快照"
            extra={
              editing
                ? '模型名不可修改；要改名请用列表里的模板按钮以此新增，再删除旧条目。'
                : undefined
            }
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
          <button type="submit" hidden />
        </Form>
      </Modal>

      <Modal
        open={policyOpen}
        title="计费策略"
        onCancel={() => setPolicyOpen(false)}
        onOk={submitPolicy}
        okText="保存"
        confirmLoading={savingPolicy}
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
