import { useCallback, useEffect, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'

import { api, type UserGroup } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { formatRelative, formatTime } from '../../utils/format'

export default function Groups() {
  const { message, modal } = App.useApp()
  const [rows, setRows] = useState<UserGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<UserGroup | null>(null)
  const [saving, setSaving] = useState(false)
  const [togglingGroup, setTogglingGroup] = useState<string | null>(null)
  const [form] = Form.useForm<UserGroup>()
  const rateValue = Form.useWatch('rate', form)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.admin.listGroups()
      setRows(result.data ?? [])
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const openModal = (group?: UserGroup) => {
    setEditing(group ?? null)
    // New groups start closed: opening one hands out both channel access and
    // its price multiplier, so it should be a deliberate choice.
    form.setFieldsValue(
      group ?? { name: '', rate: 1, description: '', user_selectable: false },
    )
    setOpen(true)
  }

  // Flipped straight from the table: it is the one field an operator changes
  // on its own, and opening a modal to tick one box is friction for nothing.
  // Opening a discounted group is the exception — that hands the discount to
  // every user, so it asks first.
  const confirmToggleSelectable = (group: UserGroup, selectable: boolean) => {
    if (selectable && group.rate < 1) {
      modal.confirm({
        title: `向所有用户开放「${group.name}」（×${group.rate}）？`,
        content:
          group.rate === 0
            ? '该分组倍率为 0，开放后任何用户都能把密钥指向它免费调用。'
            : `开放后任何用户都能把密钥指向该分组，按 ${group.rate} 倍计费。`,
        okText: '开放',
        onOk: () => toggleSelectable(group, true),
      })
      return
    }
    void toggleSelectable(group, selectable)
  }

  const toggleSelectable = async (group: UserGroup, selectable: boolean) => {
    setTogglingGroup(group.name)
    try {
      await api.admin.upsertGroup({ ...group, user_selectable: selectable })
      message.success(selectable ? `「${group.name}」已对用户开放` : `「${group.name}」已收回`)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingGroup(null)
    }
  }

  const submit = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      await api.admin.upsertGroup(values)
      message.success(`「${values.name}」已保存，倍率 ×${values.rate} 立即生效`)
      setOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        title="分组倍率"
        description="分组同时决定「可用渠道」和「计费倍率」，是权限与定价的最小单元。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              新建分组
            </Button>
          </>
        }
      />

      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="费用 = 模型价格 × 分组倍率 × 渠道倍率"
        description="用户只能路由到把自己分组列入「可用分组」的渠道；倍率填 0 表示该分组免费使用。"
      />

      <Table
        rowKey="name"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 780 }}
        locale={{
          emptyText: (
            <EmptyState
              title="还没有分组"
              description="系统至少需要一个 default 分组。"
              action={
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
                  新建分组
                </Button>
              }
            />
          ),
        }}
        columns={[
          {
            title: '分组名',
            dataIndex: 'name',
            width: 180,
            render: (name: string) => (
              <Space size={6}>
                <strong className="mono">{name}</strong>
                {name === 'default' && <Tag color="blue">默认</Tag>}
              </Space>
            ),
          },
          {
            title: '计费倍率',
            dataIndex: 'rate',
            width: 140,
            sorter: (a, b) => a.rate - b.rate,
            render: (rate: number) => (
              <Tag color={rate === 0 ? 'green' : rate < 1 ? 'blue' : rate > 1 ? 'orange' : undefined}>
                × {rate}
              </Tag>
            ),
          },
          {
            title: '用户可选',
            dataIndex: 'user_selectable',
            width: 150,
            render: (selectable: boolean, row) => (
              <Tooltip
                title={
                  selectable
                    ? '普通用户可以把自己的密钥指向这个分组'
                    : '只有管理员能把密钥指向这个分组'
                }
              >
                <Switch
                  size="small"
                  checked={selectable}
                  loading={togglingGroup === row.name}
                  aria-label={`允许普通用户使用「${row.name}」分组`}
                  onChange={(checked) => confirmToggleSelectable(row, checked)}
                />
              </Tooltip>
            ),
          },
          {
            title: '说明',
            dataIndex: 'description',
            ellipsis: { showTitle: false },
            render: (value: string) =>
              value ? (
                <Tooltip title={value}>
                  <span>{value}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
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
            width: 130,
            render: (_, row) => (
              <Space size={2}>
                <Button size="small" type="link" onClick={() => openModal(row)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除这个分组？"
                  description="该分组下的用户将无法匹配任何渠道，请先把他们移至其他分组。此操作不可撤销。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  disabled={row.name === 'default'}
                  onConfirm={async () => {
                    try {
                      await api.admin.deleteGroup(row.name)
                      message.success('已删除')
                      await load()
                    } catch (error) {
                      message.error(error instanceof Error ? error.message : '删除失败')
                    }
                  }}
                >
                  <Tooltip title={row.name === 'default' ? '默认分组不可删除' : undefined}>
                    {/* span：disabled 按钮不冒泡鼠标事件，Tooltip 需要有人接住 hover */}
                    <span style={{ display: 'inline-block', cursor: row.name === 'default' ? 'not-allowed' : undefined }}>
                      <Button size="small" type="link" danger disabled={row.name === 'default'}>
                        删除
                      </Button>
                    </span>
                  </Tooltip>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? `编辑分组：${editing.name}` : '新建分组'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="保存"
        confirmLoading={saving}
        destroyOnClose
      >
        {editing && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="倍率修改保存后立即生效，影响该分组所有用户的后续计费。"
          />
        )}
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} onFinish={() => void submit()}>
          <Form.Item
            name="name"
            label="分组名"
            rules={[{ required: true, message: '请输入分组名' }]}
            tooltip="创建后不可修改，建议用英文小写"
          >
            <Input disabled={Boolean(editing)} placeholder="vip" className="mono" />
          </Form.Item>
          <Form.Item
            name="rate"
            label="计费倍率"
            tooltip="1 表示原价，0.5 表示五折，0 表示免费"
            rules={[{ required: true, message: '请输入倍率' }]}
            extra={
              rateValue === 0
                ? '倍率为 0：该分组将免费使用，不产生任何扣费。'
                : typeof rateValue === 'number' && rateValue > 10
                  ? '倍率异常偏高，请确认不是想输入小数。'
                  : undefined
            }
          >
            <InputNumber min={0} step={0.1} style={{ width: '100%' }} addonBefore="×" />
          </Form.Item>
          <Form.Item
            name="user_selectable"
            label="允许普通用户使用"
            valuePropName="checked"
            tooltip="开启后，普通用户可以在创建密钥时选择这个分组；关闭则只有管理员能指定"
            extra="分组同时决定可用渠道和计费倍率，开放低倍率分组等于给所有人打折。"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} placeholder="例如：内部团队专用，走高优先级渠道" />
          </Form.Item>
          <button type="submit" hidden />
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          新分组创建后，记得在「渠道管理」里把它加入对应渠道的可用分组。
        </Typography.Text>
      </Modal>
    </>
  )
}
