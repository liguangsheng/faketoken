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
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'

import { api, type Redemption } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useSettings } from '../../settings/SettingsContext'
import { formatMoney, formatRelative, formatTime } from '../../utils/format'

const STATUS = { UNUSED: 1, USED: 2, DISABLED: 3 }

const statusTag = (status: number) => {
  if (status === STATUS.USED) return <Tag>已使用</Tag>
  if (status === STATUS.DISABLED) return <Tag color="red">已停用</Tag>
  return <Tag color="green">未使用</Tag>
}

export default function Redemptions() {
  const { message, modal } = App.useApp()
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
        const result = await api.admin.deleteRedemptions(selectedIds)
        message.success(`已删除 ${result.deleted} 个兑换码`)
        setSelectedIds([])
        await load()
      },
    })
  }

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(generated.join('\n'))
      message.success(`已复制 ${generated.length} 个兑换码`)
    } catch {
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

      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          placeholder="搜索兑换码、备注或使用者"
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
        {selectedIds.length > 0 && (
          <Button size="small" danger onClick={removeSelected}>
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
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
          getCheckboxProps: (row) => ({ disabled: row.status === STATUS.USED }),
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
            title: '兑换码',
            dataIndex: 'code',
            render: (code: string) => (
              <Typography.Text className="mono" copyable={{ text: code }}>
                {code}
              </Typography.Text>
            ),
          },
          { title: '备注', dataIndex: 'name', width: 130, ellipsis: true, responsive: ['lg'] },
          {
            title: '分组',
            dataIndex: 'group',
            width: 120,
            ellipsis: true,
            responsive: ['lg'],
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
            title: '面额',
            dataIndex: 'quota',
            width: 100,
            align: 'right',
            render: (quota: number) => formatMoney(quota),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (status: number) => statusTag(status),
          },
          {
            title: '使用者',
            dataIndex: 'used_by_name',
            width: 120,
            ellipsis: true,
            responsive: ['md'],
            render: (name: string, row) =>
              name ? (
                <Tooltip title={`兑换于 ${formatTime(row.used_at)}`}>{name}</Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
          {
            title: '有效期',
            dataIndex: 'expires_at',
            width: 110,
            responsive: ['xl'],
            render: (value: string | null) =>
              value ? (
                <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
              ) : (
                <span className="text-muted">永久</span>
              ),
          },
          {
            title: '创建时间',
            dataIndex: 'created_at',
            width: 110,
            responsive: ['xl'],
            render: (value: string) => (
              <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
            ),
          },
          {
            title: '操作',
            width: 120,
            render: (_, row) =>
              // A spent code is the only record of who was credited, so it
              // offers neither action; the server refuses both regardless.
              row.status === STATUS.USED ? (
                <Tooltip title="已使用的兑换码保留作为发放记录，不能停用或删除">
                  <span className="text-muted">-</span>
                </Tooltip>
              ) : (
                <Space size={4}>
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: 0 }}
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
                    <Button size="small" type="link" danger style={{ padding: 0 }}>
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
        onCancel={() => setCreateOpen(false)}
        footer={
          generated.length
            ? [
                <Button key="copy" onClick={() => void copyAll()}>
                  复制全部
                </Button>,
                <Button key="done" type="primary" onClick={() => setCreateOpen(false)}>
                  完成
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
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>已生成 {generated.length} 个兑换码：</Typography.Text>
            <pre className="code-block" style={{ maxHeight: 320 }}>
              {generated.join('\n')}
            </pre>
          </Space>
        ) : (
          <Form form={form} layout="vertical">
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
            >
              <InputNumber min={1} max={200} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="name" label="备注" tooltip="仅管理员可见，用于标记这批码的用途">
              <Input placeholder="例如：双十一活动" />
            </Form.Item>
            <Form.Item
              name="group"
              label="活动分组"
              tooltip="填写后，同一分组的兑换码每个用户只能使用一个；留空则不限制"
            >
              <Input placeholder="留空表示不限制，例如 double-eleven" />
            </Form.Item>
            <Form.Item name="expires_at" label="有效期" tooltip="留空表示永久有效">
              <DatePicker showTime style={{ width: '100%' }} placeholder="留空表示永久有效" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </>
  )
}
