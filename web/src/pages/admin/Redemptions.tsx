import { useCallback, useEffect, useState } from 'react'
import {
  App,
  Button,
  DatePicker,
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
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'

import { api, type Redemption } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useTableScrollX, type TableGeometry } from '../../hooks/useTableScrollX'
import { useSettings } from '../../settings/SettingsContext'
import { copyTextToClipboard } from '../../utils/clipboard'
import { formatDateMinute, formatMoney, formatRelative, formatTime } from '../../utils/format'

const STATUS = { UNUSED: 1, USED: 2, DISABLED: 3 }

// 红色留给「已过期」这类永久失效；停用是可逆的暂存态，用橙色。
const statusTag = (status: number, expiresAt?: string | null) => {
  if (status === STATUS.USED) return <Tag>已使用</Tag>
  if (status === STATUS.DISABLED) return <Tag color="orange">已停用</Tag>
  if (expiresAt && dayjs(expiresAt).isBefore(dayjs())) return <Tag color="red">已过期</Tag>
  return <Tag color="green">未使用</Tag>
}

/**
 * Breakpoints here were already chosen; what was missing is a `scroll.x` that
 * follows them, so the columns that survive a narrow window are no longer
 * stretched across the full desktop width. `selection` is antd's own checkbox
 * column — rendered but never declared in `columns`, so it is counted here.
 */
const COLUMN_GEOMETRY = {
  selection: { width: 34 },
  code: { width: 240 },
  note: { width: 130, responsive: ['lg'] },
  group: { width: 120, responsive: ['lg'] },
  amount: { width: 100 },
  status: { width: 90 },
  usedBy: { width: 120, responsive: ['md'] },
  expiresAt: { width: 150, responsive: ['xl'] },
  createdAt: { width: 110, responsive: ['xl'] },
  actions: { width: 120 },
} satisfies TableGeometry

export default function Redemptions() {
  const { message, modal } = App.useApp()
  const scrollX = useTableScrollX(COLUMN_GEOMETRY)
  const { defaultPageSize } = useSettings()
  const [rows, setRows] = useState<Redemption[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [keywordInput, setKeywordInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<number>()
  const [selectedIds, setSelectedIds] = useState<number[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm()
  const [generated, setGenerated] = useState<string[]>([])
  /** The face value of the batch just generated, for the result caption. */
  const [generatedAmount, setGeneratedAmount] = useState(0)

  const keyword = useDebouncedValue(keywordInput)

  useEffect(() => {
    setPage(1)
  }, [keyword, statusFilter])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.admin.listRedemptions({
        page,
        page_size: pageSize,
        keyword,
        status: statusFilter,
      })
      setRows(result.data ?? [])
      setTotal(result.total)
      const visible = new Set((result.data ?? []).map((row) => row.id))
      setSelectedIds((current) => current.filter((id) => visible.has(id)))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [keyword, message, page, pageSize, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    form.setFieldsValue({ name: '', group: '', amount_usd: 5, count: 1, expires_at: null })
    setGenerated([])
    setCreateOpen(true)
  }

  const create = async () => {
    const values = await form.validateFields()
    setCreating(true)
    try {
      const result = await api.admin.createRedemptions({
        name: values.name || '',
        group: values.group || '',
        amount_usd: Number(values.amount_usd),
        count: Number(values.count),
        expires_at: (values.expires_at as Dayjs | null)?.toISOString(),
      })
      // Show the codes right here: they are the whole point of the action, and
      // hunting for them in the table afterwards is needless work.
      setGenerated(result.data.map((item) => item.code))
      setGeneratedAmount(Number(values.amount_usd))
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '生成失败')
    } finally {
      setCreating(false)
    }
  }

  const setStatus = async (row: Redemption, status: number) => {
    try {
      await api.admin.setRedemptionStatus(row.id, status)
      message.success(status === STATUS.DISABLED ? '已停用' : '已启用')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  // Single-row delete. Reuses the bulk endpoint: one id is a selection of one,
  // and the server applies the same "spent codes are kept" rule either way.
  const removeOne = async (row: Redemption) => {
    try {
      const result = await api.admin.deleteRedemptions([row.id])
      if (result.deleted === 0) {
        // The row moved to "used" between the listing and the click.
        message.warning('该兑换码已被兑换，作为发放记录保留')
      } else {
        message.success('已删除')
      }
      setSelectedIds((current) => current.filter((id) => id !== row.id))
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const removeSelected = () => {
    modal.confirm({
      title: `删除选中的 ${selectedIds.length} 个兑换码？`,
      // Spent codes are the record of who was credited, so the server keeps
      // them; say so rather than letting the count look wrong.
      content: '已使用的兑换码会被保留作为发放记录，不会被删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await api.admin.deleteRedemptions(selectedIds)
          message.success(`已删除 ${result.deleted} 个兑换码`)
          setSelectedIds([])
          await load()
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败')
          throw error
        }
      },
    })
  }

  const copyAll = async () => {
    if (await copyTextToClipboard(generated.join('\n'))) {
      message.success(`已复制 ${generated.length} 个兑换码`)
    } else {
      message.warning('浏览器拒绝了剪贴板访问，请手动复制')
    }
  }

  return (
    <>
      <PageHeader
        title="兑换码"
        description="生成后发给用户，用户在个人设置中兑换即可增加余额。每个码只能使用一次。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              生成兑换码
            </Button>
          </>
        }
      />

      <Space wrap className="filter-bar" size={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder="搜索兑换码、备注或使用者"
          aria-label="搜索兑换码、备注或使用者"
          style={{ width: 220 }}
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 130 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: STATUS.UNUSED, label: '未使用' },
            { value: STATUS.USED, label: '已使用' },
            { value: STATUS.DISABLED, label: '已停用' },
          ]}
        />
        {(keywordInput || statusFilter !== undefined) && (
          <Button
            type="link"
            onClick={() => {
              setKeywordInput('')
              setStatusFilter(undefined)
            }}
          >
            重置
          </Button>
        )}
        {selectedIds.length > 0 && (
          <Button danger onClick={removeSelected}>
            删除选中 {selectedIds.length} 个
          </Button>
        )}
      </Space>

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        tableLayout="fixed"
        // 各列宽度之和（含勾选列），小于它会让 fixed 布局按比例压缩列
        scroll={{ x: scrollX }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
          getCheckboxProps: (row) => ({ disabled: row.status === STATUS.USED }),
          renderCell: (_value, row, _index, node) =>
            row.status === STATUS.USED ? (
              <Tooltip title="已使用的兑换码保留作为发放记录，不可选择">
                <span tabIndex={0}>{node}</span>
              </Tooltip>
            ) : (
              node
            ),
        }}
        locale={{
          emptyText: (
            <EmptyState
              title="还没有兑换码"
              description="生成一批兑换码，发给用户用于充值。"
              action={
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  生成兑换码
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
          showTotal: (count) => `共 ${count} 个兑换码`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            ...COLUMN_GEOMETRY.code,
            title: '兑换码',
            dataIndex: 'code',
            render: (code: string) => (
              <Typography.Text className="mono" copyable={{ text: code }}>
                {code}
              </Typography.Text>
            ),
          },
          { ...COLUMN_GEOMETRY.note, title: '备注', dataIndex: 'name', ellipsis: true },
          {
            ...COLUMN_GEOMETRY.group,
            title: '分组',
            dataIndex: 'group',
            ellipsis: true,
            render: (group: string) =>
              group ? (
                <Tooltip title="同一分组每个用户只能使用一个">
                  <Tag color="purple">{group}</Tag>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
          {
            ...COLUMN_GEOMETRY.amount,
            title: '面额',
            dataIndex: 'quota',
            align: 'right',
            render: (quota: number) => formatMoney(quota),
          },
          {
            ...COLUMN_GEOMETRY.status,
            title: '状态',
            dataIndex: 'status',
            render: (status: number, row) => statusTag(status, row.expires_at),
          },
          {
            ...COLUMN_GEOMETRY.usedBy,
            title: '使用者',
            dataIndex: 'used_by_name',
            ellipsis: true,
            render: (name: string, row) =>
              name ? (
                <Tooltip title={row.used_at ? `兑换于 ${formatTime(row.used_at)}` : undefined}>
                  <span>{name}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
          {
            ...COLUMN_GEOMETRY.expiresAt,
            title: '有效期',
            dataIndex: 'expires_at',
            render: (value: string | null) => {
              if (!value) return <span className="text-muted">永久</span>
              const expired = dayjs(value).isBefore(dayjs())
              return (
                <Tooltip title={formatTime(value)}>
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
            ...COLUMN_GEOMETRY.createdAt,
            title: '创建时间',
            dataIndex: 'created_at',
            render: (value: string) => (
              <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
            ),
          },
          {
            ...COLUMN_GEOMETRY.actions,
            title: '操作',
            render: (_, row) =>
              // A spent code is the only record of who was credited, so it
              // offers neither action; the server refuses both regardless.
              row.status === STATUS.USED ? (
                <Tooltip title="已使用的兑换码保留作为发放记录，不能停用或删除">
                  <span className="text-muted" tabIndex={0}>-</span>
                </Tooltip>
              ) : (
                <Space size={4}>
                  <Button
                    size="small"
                    type="link"
                    onClick={() =>
                      void setStatus(
                        row,
                        row.status === STATUS.DISABLED ? STATUS.UNUSED : STATUS.DISABLED,
                      )
                    }
                  >
                    {row.status === STATUS.DISABLED ? '启用' : '停用'}
                  </Button>
                  <Popconfirm
                    title="删除这个兑换码？"
                    description="该码尚未被兑换，删除后无法恢复。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => removeOne(row)}
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
        open={createOpen}
        title="生成兑换码"
        width={560}
        // 生成结果只展示这一次，误点遮罩不应让整批码消失
        maskClosable={false}
        onCancel={() => {
          if (creating) return
          setCreateOpen(false)
        }}
        footer={
          generated.length
            ? [
                <Button key="done" onClick={() => setCreateOpen(false)}>
                  完成
                </Button>,
                // 此刻唯一想做的事就是复制，让它当主按钮
                <Button key="copy" type="primary" onClick={() => void copyAll()}>
                  复制全部
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>,
                <Button key="create" type="primary" loading={creating} onClick={() => void create()}>
                  生成
                </Button>,
              ]
        }
      >
        {generated.length ? (
          <>
            <Typography.Paragraph type="secondary">
              已生成 {generated.length} 个面额 ${generatedAmount} 的兑换码，复制后发给用户：
            </Typography.Paragraph>
            <pre className="code-block" style={{ maxHeight: '40vh' }}>
              {generated.join('\n')}
            </pre>
          </>
        ) : (
          <Form form={form} layout="vertical" onFinish={() => void create()}>
            <Form.Item
              name="amount_usd"
              label="面额"
              rules={[{ required: true, message: '请输入面额' }]}
            >
              <InputNumber min={0.01} step={1} precision={2} addonBefore="$" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="count"
              label="数量"
              rules={[{ required: true, message: '请输入数量' }]}
              extra="一次最多生成 200 个。"
            >
              <InputNumber min={1} max={200} step={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="name" label="备注" tooltip="仅管理员可见，用于标记这批码的用途">
              <Input placeholder="例如：双十一活动" maxLength={64} />
            </Form.Item>
            <Form.Item
              name="group"
              label="活动分组"
              tooltip="填写后，同一分组的兑换码每个用户只能使用一个；留空则不限制"
            >
              <Input placeholder="留空表示不限制，例如 double-eleven" />
            </Form.Item>
            <Form.Item name="expires_at" label="有效期" tooltip="留空表示永久有效">
              <DatePicker
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                style={{ width: '100%' }}
                placeholder="留空表示永久有效"
                disabledDate={(date) => date.isBefore(dayjs().startOf('day'))}
              />
            </Form.Item>
            <button type="submit" hidden />
          </Form>
        )}
      </Modal>
    </>
  )
}
