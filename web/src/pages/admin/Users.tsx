import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'

import { api, type User, type UserGroup } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useSettings } from '../../settings/SettingsContext'
import { formatMoney, formatNumber, formatRelative, formatTime, STATUS, toUSD } from '../../utils/format'

const QUICK_AMOUNTS = [5, 10, 50, 100]

export default function Users() {
  const { message, modal } = App.useApp()
  const { user: me, refresh: refreshMe } = useAuth()
  const [rows, setRows] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const { defaultPageSize } = useSettings()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [keywordInput, setKeywordInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<UserGroup[]>([])

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const [quotaTarget, setQuotaTarget] = useState<User | null>(null)
  const [quotaForm] = Form.useForm<{ amount_usd: number }>()
  const [passwordTarget, setPasswordTarget] = useState<User | null>(null)
  const [passwordForm] = Form.useForm<{ password: string; confirm: string }>()

  const keyword = useDebouncedValue(keywordInput)

  useEffect(() => {
    setPage(1)
  }, [keyword])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.admin.listUsers({ page, page_size: pageSize, keyword })
      setRows(result.data ?? [])
      setTotal(result.total)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [keyword, message, page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api.admin
      .listGroups()
      .then((result) => setGroups(result.data ?? []))
      .catch(() => setGroups([]))
  }, [])

  const groupOptions = useMemo(
    () => groups.map((group) => ({ value: group.name, label: `${group.name}（×${group.rate}）` })),
    [groups],
  )

  const openModal = (user?: User) => {
    setEditing(user ?? null)
    form.setFieldsValue(
      user
        ? {
            display_name: user.display_name,
            email: user.email,
            role: user.role,
            status: user.status,
            group: user.group,
            quota_usd: toUSD(user.quota),
          }
        : {
            username: '',
            password: '',
            display_name: '',
            email: '',
            role: 1,
            status: STATUS.ENABLED,
            group: 'default',
            quota_usd: 1,
          },
    )
    setOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await api.admin.updateUser(editing.id, values)
        message.success('已保存')
        if (editing.id === me?.id) await refreshMe()
      } else {
        await api.admin.createUser(values)
        message.success('用户已创建')
      }
      setOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // The update endpoint replaces every editable field, so echo the row back.
  const setStatus = async (row: User, status: number) => {
    try {
      await api.admin.updateUser(row.id, {
        display_name: row.display_name,
        email: row.email,
        role: row.role,
        status,
        group: row.group,
        quota_usd: toUSD(row.quota),
      })
      message.success(status === STATUS.ENABLED ? '账号已启用' : '账号已禁用')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  const grantQuota = async () => {
    if (!quotaTarget) return
    const values = await quotaForm.validateFields()
    // Guarded because the server adds to the balance rather than setting it:
    // a double click would be a second top-up, not a repeat of the first.
    setSaving(true)
    try {
      await api.admin.grantQuota(quotaTarget.id, Number(values.amount_usd))
      message.success(`已为「${quotaTarget.username}」充值 $${values.amount_usd}`)
      setQuotaTarget(null)
      if (quotaTarget.id === me?.id) await refreshMe()
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '充值失败')
    } finally {
      setSaving(false)
    }
  }

  const resetPassword = async () => {
    if (!passwordTarget) return
    const values = await passwordForm.validateFields()
    setSaving(true)
    try {
      await api.admin.resetPassword(passwordTarget.id, values.password)
      message.success(`已重置「${passwordTarget.username}」的密码`)
      setPasswordTarget(null)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重置失败')
    } finally {
      setSaving(false)
    }
  }

  const removeUser = (row: User) => {
    modal.confirm({
      title: `删除用户「${row.username}」？`,
      content: '该用户的 API 密钥会一并删除，历史日志保留。此操作不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        await api.admin.deleteUser(row.id)
        message.success('已删除')
        await load()
      },
    })
  }

  return (
    <>
      <PageHeader
        title="用户管理"
        description="分组决定用户可用的渠道和计费倍率；余额为负时请求会被拒绝。"
        extra={
          <>
            <Input
              allowClear
              placeholder="搜索用户名 / 邮箱"
              style={{ width: 200 }}
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              新建用户
            </Button>
          </>
        }
      />

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 1080 }}
        locale={{
          emptyText: <EmptyState title="没有匹配的用户" description="换个关键词试试。" />,
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          hideOnSinglePage: total <= 10,
          showTotal: (count) => `共 ${count} 个用户`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            title: '用户',
            dataIndex: 'username',
            width: 220,
            render: (username: string, row) => (
              <div style={{ display: 'grid', gap: 2 }}>
                <Space size={6}>
                  <strong>{username}</strong>
                  {row.id === me?.id && <Tag color="blue">当前登录</Tag>}
                </Space>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  {row.display_name || '未设置昵称'}
                  {row.email ? ` · ${row.email}` : ''}
                </span>
              </div>
            ),
          },
          {
            title: '角色',
            dataIndex: 'role',
            width: 100,
            render: (role: number) =>
              role >= 100 ? <Tag color="gold">管理员</Tag> : <Tag>普通用户</Tag>,
          },
          {
            title: '分组',
            dataIndex: 'group',
            width: 110,
            render: (group: string) => <Tag color="blue">{group}</Tag>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (status: number) =>
              status === STATUS.ENABLED ? <Tag color="green">正常</Tag> : <Tag color="red">禁用</Tag>,
          },
          {
            title: '余额 / 累计消费',
            dataIndex: 'quota',
            width: 160,
            render: (value: number, row) => (
              <div style={{ display: 'grid', gap: 2 }}>
                <strong style={{ color: value <= 0 ? 'var(--app-danger)' : undefined }}>
                  {formatMoney(value)}
                </strong>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  已消费 {formatMoney(row.used_quota)}
                </span>
              </div>
            ),
          },
          {
            title: '调用次数',
            dataIndex: 'request_count',
            width: 100,
            align: 'right',
            render: (value: number) => formatNumber(value),
          },
          {
            title: '注册时间',
            dataIndex: 'created_at',
            width: 130,
            render: (value: string) => (
              <Tooltip title={formatTime(value)}>{formatRelative(value)}</Tooltip>
            ),
          },
          {
            title: '操作',
            width: 170,
            fixed: 'right',
            render: (_, row) => (
              <Space size={2}>
                <Button size="small" type="link" onClick={() => openModal(row)}>
                  编辑
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    quotaForm.setFieldsValue({ amount_usd: 10 })
                    setQuotaTarget(row)
                  }}
                >
                  充值
                </Button>
                <Dropdown
                  menu={{
                    items: [
                      { key: 'password', icon: <KeyOutlined />, label: '重置密码' },
                      row.status === STATUS.ENABLED
                        ? {
                            key: 'disable',
                            icon: <StopOutlined />,
                            label: '禁用账号',
                            disabled: row.id === me?.id,
                          }
                        : { key: 'enable', icon: <CheckCircleOutlined />, label: '启用账号' },
                      { type: 'divider' as const },
                      {
                        key: 'delete',
                        icon: <DeleteOutlined />,
                        label: '删除用户',
                        danger: true,
                        disabled: row.id === me?.id,
                      },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'password') {
                        passwordForm.resetFields()
                        setPasswordTarget(row)
                      } else if (key === 'delete') {
                        removeUser(row)
                      } else {
                        void setStatus(row, key === 'enable' ? STATUS.ENABLED : STATUS.DISABLED)
                      }
                    },
                  }}
                >
                  <Button size="small" type="text" icon={<EllipsisOutlined />} />
                </Dropdown>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? `编辑用户：${editing.username}` : '新建用户'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          {!editing && (
            <>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="password"
                label="初始密码"
                rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <Form.Item name="display_name" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱">
            <Input type="email" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            tooltip={editing?.id === me?.id ? '不能取消自己的管理员权限' : undefined}
          >
            <Select
              disabled={Boolean(editing && editing.id === me?.id)}
              options={[
                { value: 1, label: '普通用户' },
                { value: 100, label: '管理员' },
              ]}
            />
          </Form.Item>
          <Form.Item name="group" label="分组" tooltip="决定可用渠道与计费倍率">
            <Select options={groupOptions} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              disabled={Boolean(editing && editing.id === me?.id)}
              options={[
                { value: STATUS.ENABLED, label: '正常' },
                { value: STATUS.DISABLED, label: '禁用' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="quota_usd"
            label="余额（美元）"
            tooltip="这里是直接设置余额；日常增补建议用列表里的「充值」"
          >
            <InputNumber min={-1000000} step={1} style={{ width: '100%' }} addonBefore="$" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(quotaTarget)}
        title={`为「${quotaTarget?.username}」充值`}
        onCancel={() => setQuotaTarget(null)}
        onOk={grantQuota}
        confirmLoading={saving}
        okText="确认充值"
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          当前余额 {formatMoney(quotaTarget?.quota ?? 0)}，充值金额会累加到余额上；填负数表示扣减。
        </Typography.Paragraph>
        <Form form={quotaForm} layout="vertical">
          <Form.Item
            name="amount_usd"
            label="充值金额"
            rules={[{ required: true, message: '请输入金额' }]}
          >
            <InputNumber step={1} style={{ width: '100%' }} addonBefore="$" autoFocus />
          </Form.Item>
        </Form>
        <Space wrap>
          {QUICK_AMOUNTS.map((amount) => (
            <Button
              key={amount}
              size="small"
              onClick={() => quotaForm.setFieldsValue({ amount_usd: amount })}
            >
              +${amount}
            </Button>
          ))}
        </Space>
      </Modal>

      <Modal
        open={Boolean(passwordTarget)}
        title={`重置「${passwordTarget?.username}」的密码`}
        onCancel={() => setPasswordTarget(null)}
        onOk={resetPassword}
        confirmLoading={saving}
        okText="确认重置"
        destroyOnClose
      >
        <Form form={passwordForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            name="password"
            label="新密码"
            rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}
          >
            <Input.Password autoComplete="new-password" autoFocus />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  !value || value === getFieldValue('password')
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的密码不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
