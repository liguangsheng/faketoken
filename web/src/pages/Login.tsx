import { useEffect, useState } from 'react'
import { App, Button, Card, Form, Input, Segmented } from 'antd'
import { GiftOutlined, LockOutlined, UserOutlined } from '@ant-design/icons'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'

type Mode = 'login' | 'register'

/**
 * Deliberately anonymous: an unauthenticated visitor should not be able to
 * tell what this deployment is, what it proxies or who runs it. No product
 * name, no feature copy, no contact hints — just the credential form.
 */
export default function Login() {
  const { signIn, signUp } = useAuth()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [allowRegister, setAllowRegister] = useState(false)
  const [requireInvite, setRequireInvite] = useState(false)
  const [mode, setMode] = useState<Mode>('login')
  const [form] = Form.useForm()

  useEffect(() => {
    api
      .status()
      .then((status) => {
        setAllowRegister(status.allow_register)
        setRequireInvite(status.require_invite_code)
      })
      .catch(() => setAllowRegister(false))
  }, [])

  const submit = async (values: { username: string; password: string; invite_code?: string }) => {
    setLoading(true)
    try {
      if (mode === 'login') {
        await signIn(values.username.trim(), values.password)
      } else {
        await signUp(values.username.trim(), values.password, values.invite_code?.trim())
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-shell">
      <main className="login-card">
        <Card>
          <div className="login-mark" aria-hidden>
            <LockOutlined />
          </div>
          {/* The switcher already names both modes, so a heading beside it
              would just say the same thing twice. */}
          {/* Fixed height: the register switch arrives async, and the swap
              from plain title to Segmented must not bump the form. */}
          <div style={{ minHeight: 52 }}>
            {allowRegister ? (
              <Segmented
                block
                value={mode}
                onChange={(value) => {
                  setMode(value as Mode)
                  // Register-only errors (min length) must not linger on login.
                  form.setFields([{ name: 'password', errors: [] }])
                }}
                options={[
                  { value: 'login', label: '登录' },
                  { value: 'register', label: '注册' },
                ]}
                style={{ marginBottom: 20 }}
              />
            ) : (
              <h1 className="login-title">登录</h1>
            )}
          </div>

          <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
            <Form.Item
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
              style={{ marginBottom: 14 }}
            >
              <Input
                prefix={<UserOutlined className="text-muted" />}
                placeholder="用户名"
                aria-label="用户名"
                size="large"
                autoFocus
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[
                { required: true, message: '请输入密码' },
                ...(mode === 'register' ? [{ min: 8, message: '密码至少 8 位' }] : []),
              ]}
              style={{ marginBottom: 18 }}
            >
              <Input.Password
                prefix={<LockOutlined className="text-muted" />}
                placeholder={mode === 'register' ? '密码（至少 8 位）' : '密码'}
                aria-label="密码"
                size="large"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Form.Item>
            {/* Shown only when the server says it is required. The server
                checks again regardless: this endpoint is reachable without
                ever loading this page. */}
            {mode === 'register' && requireInvite && (
              <Form.Item
                name="invite_code"
                rules={[{ required: true, message: '请输入邀请码' }]}
                style={{ marginBottom: 18 }}
              >
                <Input
                  prefix={<GiftOutlined className="text-muted" />}
                  placeholder="邀请码"
                  aria-label="邀请码"
                  size="large"
                  autoComplete="off"
                />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              {mode === 'login' ? '登录' : '注册'}
            </Button>
          </Form>
        </Card>
      </main>
    </div>
  )
}
