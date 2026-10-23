import { useState } from 'react'
import { App, Avatar, Button, Card, Col, Form, Input, Row, Space, Tag, Typography } from 'antd'

import { api, session } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import PageHeader from '../components/PageHeader'
import { formatMoney, formatNumber, formatTime } from '../utils/format'

interface PasswordValues {
  old_password: string
  new_password: string
  confirm: string
}

export default function Profile() {
  const { user, refresh, isAdmin } = useAuth()
  const { message } = App.useApp()
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordForm] = Form.useForm<PasswordValues>()
  const [redeemCode, setRedeemCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)

  const redeem = async () => {
    const code = redeemCode.trim()
    // Guarded because the server credits on every call: a double Enter would
    // redeem twice (and fail confusingly the second time).
    if (!code || redeeming) return
    setRedeeming(true)
    try {
      const result = await api.redeem(code)
      message.success(`兑换成功，到账 ${formatMoney(result.quota)}`)
      setRedeemCode('')
      // Refresh so the balance shown here and in the header both move.
      await refresh()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '兑换失败')
    } finally {
      setRedeeming(false)
    }
  }

  const saveProfile = async (values: { display_name?: string; email?: string }) => {
    setSavingProfile(true)
    try {
      await api.updateMe(values.display_name ?? '', values.email ?? '')
      await refresh()
      message.success('资料已更新')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSavingProfile(false)
    }
  }

  const changePassword = async (values: PasswordValues) => {
    setSavingPassword(true)
    try {
      const result = await api.changePassword(values.old_password, values.new_password)
      // The old token died with the old password; without this the next
      // request would bounce this tab to the login form.
      session.set(result.token)
      message.success('密码已修改，其他设备需重新登录')
      passwordForm.resetFields()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '修改失败')
    } finally {
      setSavingPassword(false)
    }
  }

  const stats = [
    { label: '账户余额', value: formatMoney(user?.quota ?? 0) },
    { label: '累计消费', value: formatMoney(user?.used_quota ?? 0) },
    { label: '调用次数', value: formatNumber(user?.request_count ?? 0) },
  ]

  return (
    <>
      <PageHeader
        title="个人设置"
        description="账户信息、昵称邮箱与登录密码，以及使用兑换码为余额充值。"
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={10}>
          <Card>
            <Space align="start" size={14}>
              <Avatar
                size={52}
                style={{
                  background: 'var(--app-brand-soft)',
                  color: 'var(--app-brand)',
                  fontSize: 22,
                }}
              >
                <span aria-hidden>
                  {(user?.display_name || user?.username || '?').slice(0, 1).toUpperCase()}
                </span>
              </Avatar>
              <div style={{ display: 'grid', gap: 6 }}>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {user?.display_name || user?.username}
                </Typography.Title>
                <Space size={6} wrap>
                  <Tag className="mono">{user?.username}</Tag>
                  {isAdmin ? <Tag color="gold">管理员</Tag> : <Tag>普通用户</Tag>}
                  <Tag color="blue">分组 {user?.group}</Tag>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  注册于 {formatTime(user?.created_at)}
                </Typography.Text>
              </div>
            </Space>

            <Row gutter={[12, 12]} style={{ marginTop: 20 }}>
              {stats.map((item) => (
                <Col xs={24} sm={8} key={item.label}>
                  <div
                    style={{
                      background: 'var(--app-surface-sunken)',
                      border: '1px solid var(--app-border)',
                      borderRadius: 10,
                      padding: '10px 12px',
                    }}
                  >
                    <div className="stat-card__label">{item.label}</div>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 650,
                        marginTop: 4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.value}
                    </div>
                  </div>
                </Col>
              ))}
            </Row>
          </Card>

          <Card title="兑换码充值" style={{ marginTop: 12 }}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={redeemCode}
                placeholder="输入兑换码"
                aria-label="兑换码"
                className="mono"
                disabled={redeeming}
                onChange={(event) => setRedeemCode(event.target.value)}
                onPressEnter={() => void redeem()}
              />
              <Button
                type="primary"
                loading={redeeming}
                disabled={!redeemCode.trim()}
                onClick={() => void redeem()}
              >
                兑换
              </Button>
            </Space.Compact>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
              兑换成功后余额立即到账，每个兑换码只能使用一次。
            </Typography.Text>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card title="修改资料" style={{ marginBottom: 12 }}>
            <Form
              layout="vertical"
              initialValues={{ display_name: user?.display_name, email: user?.email }}
              onFinish={saveProfile}
            >
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="display_name"
                    label="昵称"
                    extra="展示在右上角与调用日志中。"
                  >
                    <Input maxLength={32} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="email"
                    label="邮箱"
                    rules={[{ type: 'email', message: '邮箱格式不正确' }]}
                  >
                    <Input placeholder="you@example.com" />
                  </Form.Item>
                </Col>
              </Row>
              <Button type="primary" htmlType="submit" loading={savingProfile}>
                保存资料
              </Button>
            </Form>
          </Card>

          <Card title="修改密码">
            <Form form={passwordForm} layout="vertical" onFinish={changePassword}>
              <Form.Item
                name="old_password"
                label="当前密码"
                rules={[{ required: true, message: '请输入当前密码' }]}
              >
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="new_password"
                    label="新密码"
                    rules={[
                      { required: true, message: '请输入新密码' },
                      { min: 8, message: '密码至少 8 位' },
                    ]}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="confirm"
                    label="确认新密码"
                    dependencies={['new_password']}
                    rules={[
                      { required: true, message: '请再次输入新密码' },
                      ({ getFieldValue }) => ({
                        validator: (_, value) =>
                          !value || value === getFieldValue('new_password')
                            ? Promise.resolve()
                            : Promise.reject(new Error('两次输入的密码不一致')),
                      }),
                    ]}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                </Col>
              </Row>
              <Button type="primary" htmlType="submit" loading={savingPassword}>
                修改密码
              </Button>
            </Form>
          </Card>
        </Col>
      </Row>
    </>
  )
}
