import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
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
import { useNavigate } from 'react-router-dom'

import { api, type InviteCode } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useSettings } from '../../settings/SettingsContext'
import { copyTextToClipboard } from '../../utils/clipboard'
import { formatDateMinute, formatRelative, formatTime } from '../../utils/format'

const STATUS = { UNUSED: 1, USED: 2, DISABLED: 3 }

// 红色留给「已过期」这类永久失效；停用是可逆的暂存态，用橙色。
const statusTag = (status: number, expiresAt?: string | null) => {
  if (status === STATUS.USED) return <Tag>已使用</Tag>
  if (status === STATUS.DISABLED) return <Tag color="orange">已停用</Tag>
  if (expiresAt && dayjs(expiresAt).isBefore(dayjs())) return <Tag color="red">已过期</Tag>
  return <Tag color="green">未使用</Tag>
}

export default function Invites() {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { defaultPageSize, settings } = useSettings()
  const [rows, setRows] = useState<InviteCode[]>([])
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
      const result = await api.admin.listInvites({
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
    form.setFieldsValue({ name: '', count: 1, expires_at: null })
    setGenerated([])
    setCreateOpen(true)
  }

  const create = async () => {
    const values = await form.validateFields()
    setCreating(true)
    try {
      const result = await api.admin.createInvites({
        name: values.name || '',
        count: Number(values.count),
        expires_at: (values.expires_at as Dayjs | null)?.toISOString(),
      })
      // Show the codes right here: handing them out is the point of the
      // action, and hunting for them in the table afterwards is needless work.
      setGenerated(result.data.map((item) => item.code))
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '生成失败')
    } finally {
      setCreating(false)
    }
  }

  const setStatus = async (row: InviteCode, status: number) => {
    try {
      await api.admin.setInviteStatus(row.id, status)
      message.success(status === STATUS.DISABLED ? '已停用' : '已启用')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  const removeOne = async (row: InviteCode) => {
    try {
      const result = await api.admin.deleteInvites([row.id])
      if (result.deleted === 0) {
        message.warning('该邀请码已被使用，作为注册记录保留')
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
      title: `删除选中的 ${selectedIds.length} 个邀请码？`,
      // Used codes are the record of which invitation an account came from, so
      // the server keeps them; say so rather than letting the count look wrong.
      content: '已使用的邀请码会被保留作为注册记录，不会被删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await api.admin.deleteInvites(selectedIds)
          message.success(`已删除 ${result.deleted} 个邀请码`)
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
      message.success(`已复制 ${generated.length} 个邀请码`)
    } else {
      message.warning('浏览器拒绝了剪贴板访问，请手动复制')
    }
  }

  return (
    <>
      <PageHeader
        title="邀请码"
        description="生成后发给受邀者，注册时填写即可创建账号。每个邀请码只能注册一个账号。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              生成邀请码
            </Button>
          </>
        }
      />

      {/* Generating codes while nothing asks for them is a common way to be
          confused later, so the state of the switch is stated here. */}
      {!settings.require_invite_code && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前注册不需要邀请码"
          description="这些邀请码暂时不会被用到。开启「注册需要邀请码」后才会生效。"
          action={
            <Button size="small" onClick={() => navigate('/admin/settings')}>
              去开启
            </Button>
          }
        />
      )}

      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder="搜索邀请码、备注或使用者"
          aria-label="搜索邀请码、备注或使用者"
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
        loading={loading}
        dataSource={rows}
        scroll={{ x: 1030 }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
          getCheckboxProps: (row) => ({ disabled: row.status === STATUS.USED }),
          renderCell: (_value, row, _index, node) =>
            row.status === STATUS.USED ? (
              <Tooltip title="已使用的邀请码保留作为注册记录，不可选择">
                <span tabIndex={0}>{node}</span>
              </Tooltip>
            ) : (
              node
            ),
        }}
        locale={{
          emptyText: (
            <EmptyState
              title="还没有邀请码"
              description="生成一批邀请码，发给你想邀请的人。"
              action={
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  生成邀请码
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
          showTotal: (count) => `共 ${count} 个邀请码`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            title: '邀请码',
            dataIndex: 'code',
            width: 240,
            render: (code: string) => (
              <Typography.Text className="mono" copyable={{ text: code }}>
                {code}
              </Typography.Text>
            ),
          },
          {
            title: '备注',
            dataIndex: 'name',
            ellipsis: true,
            render: (name: string) => name || <span className="text-muted">-</span>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (status: number, row) => statusTag(status, row.expires_at),
          },
          {
            title: '使用者',
            dataIndex: 'used_by_name',
            width: 140,
            ellipsis: true,
            render: (name: string, row) =>
              name ? (
                <Tooltip title={row.used_at ? `注册于 ${formatTime(row.used_at)}` : undefined}>
                  <span>{name}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
          {
            title: '有效期',
            dataIndex: 'expires_at',
            width: 150,
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
            title: '创建时间',
            dataIndex: 'created_at',
            width: 140,
            render: (value: string) => (
              <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
            ),
          },
          {
            title: '操作',
            width: 120,
            render: (_, row) =>
              // A used code is the record of where an account came from, so it
              // offers neither action; the server refuses both regardless.
              row.status === STATUS.USED ? (
                <Tooltip title="已使用的邀请码保留作为注册记录，不能停用或删除">
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
                    title="删除这个邀请码？"
                    description="该邀请码尚未被使用，删除后无法恢复。"
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
        title="生成邀请码"
        width={560}
        // 生成结果只展示这一次，误点遮罩不应让整批码消失
        maskClosable={false}
        onCancel={() => {
          if (creating) return
          setCreateOpen(false)
        }}
        footer={
          generated.length > 0
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
                <Button
                  key="create"
                  type="primary"
                  loading={creating}
                  onClick={() => void create()}
                >
                  生成
                </Button>,
              ]
        }
      >
        {generated.length > 0 ? (
          <>
            <Typography.Paragraph type="secondary">
              已生成 {generated.length} 个邀请码，复制后发给受邀者：
            </Typography.Paragraph>
            <pre className="code-block" style={{ maxHeight: '40vh' }}>
              {generated.join('\n')}
            </pre>
          </>
        ) : (
          <Form
            form={form}
            layout="vertical"
            style={{ marginTop: 12 }}
            onFinish={() => void create()}
          >
            <Form.Item
              name="count"
              label="数量"
              rules={[{ required: true, message: '请输入数量' }]}
              extra="一次最多生成 200 个。"
            >
              <InputNumber min={1} max={200} step={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="name" label="备注" tooltip="只用于你自己辨认，受邀者看不到">
              <Input placeholder="例如：内测第一批" maxLength={64} />
            </Form.Item>
            <Form.Item name="expires_at" label="有效期" tooltip="留空表示永不过期">
              <DatePicker
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                style={{ width: '100%' }}
                // The server refuses an expiry in the past.
                disabledDate={(date) => date.isBefore(dayjs().startOf('day'))}
                placeholder="留空表示永不过期"
              />
            </Form.Item>
            <button type="submit" hidden />
          </Form>
        )}
      </Modal>
    </>
  )
}
