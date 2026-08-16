import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Avatar,
  Breadcrumb,
  Button,
  Drawer,
  Dropdown,
  Layout as AntLayout,
  Menu,
  Tag,
  Tooltip,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  BulbOutlined,
  DesktopOutlined,
  LogoutOutlined,
  MenuOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  ReloadOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { NAV_SECTIONS, navLookup } from '../nav'
import { useThemeMode } from '../theme/ThemeProvider'
import type { ThemeMode } from '../theme/ThemeProvider'
import { formatMoney } from '../utils/format'

const { Header, Sider, Content } = AntLayout

const COLLAPSE_KEY = 'faketoken-sider-collapsed'
/** The balance in the header is only useful if it tracks actual spending. */
const BALANCE_REFRESH_MS = 60_000

const THEME_OPTIONS: { key: ThemeMode; label: string; icon: ReactNode }[] = [
  { key: 'light', label: '浅色', icon: <SunOutlined /> },
  { key: 'dark', label: '深色', icon: <MoonOutlined /> },
  { key: 'system', label: '跟随系统', icon: <DesktopOutlined /> },
]

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="app-brand">
      <span className="app-brand__mark" aria-hidden>
        ⇄
      </span>
      {!collapsed && (
        <span className="app-brand__text">
          <span className="app-brand__title">FakeToken</span>
          <span className="app-brand__subtitle">API Gateway</span>
        </span>
      )}
    </div>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, isAdmin, signOut, refresh } = useAuth()
  const { mode, resolved, setMode } = useThemeMode()
  const navigate = useNavigate()
  const location = useLocation()
  const isMobile = useMediaQuery('(max-width: 991px)')

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [version, setVersion] = useState('')

  const current = navLookup(location.pathname)

  useEffect(() => {
    document.title = current ? `${current.item.label} · FakeToken` : 'FakeToken'
  }, [current])

  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  useEffect(() => {
    api
      .version()
      .then((result) => setVersion(result.version))
      .catch(() => setVersion(''))
  }, [])

  // Balance and usage counters drift as soon as requests flow through the
  // relay, so re-read the profile on a timer, on focus and on navigation.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), BALANCE_REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [location.pathname, refresh])

  const sections = useMemo(
    () => NAV_SECTIONS.filter((section) => !section.admin || isAdmin),
    [isAdmin],
  )

  const menuItems = useMemo<MenuProps['items']>(() => {
    const visible = sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !item.hidden),
      }))
      .filter((section) => section.items.length > 0)

    // Group headings read as noise when the rail is collapsed to icons.
    if (collapsed && !isMobile) {
      return visible.flatMap((section, index) => [
        ...(index > 0 ? [{ type: 'divider' as const, key: `d-${section.key}` }] : []),
        ...section.items.map((item) => ({
          key: item.key,
          icon: item.icon,
          label: item.label,
        })),
      ])
    }

    return visible.map((section) => ({
      key: section.key,
      type: 'group' as const,
      label: section.label,
      children: section.items.map((item) => ({
        key: item.key,
        icon: item.icon,
        label: item.label,
      })),
    }))
  }, [collapsed, isMobile, sections])

  const navMenu = (
    <Menu
      mode="inline"
      selectedKeys={[location.pathname]}
      items={menuItems}
      style={{ border: 'none', paddingBlock: 4 }}
      onClick={({ key }) => navigate(key)}
    />
  )

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1')
      return !value
    })
  }

  const lowBalance = (user?.quota ?? 0) <= 0

  const themeMenu: MenuProps = {
    selectable: true,
    selectedKeys: [mode],
    items: THEME_OPTIONS.map((option) => ({
      key: option.key,
      icon: option.icon,
      label: option.label,
    })),
    onClick: ({ key }) => setMode(key as ThemeMode),
  }

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      {!isMobile && (
        <Sider
          className="app-sider"
          theme="light"
          width={224}
          collapsedWidth={72}
          collapsed={collapsed}
          trigger={null}
        >
          <Brand collapsed={collapsed} />
          <div className="app-sider__nav">{navMenu}</div>
          {!collapsed && (
            <div className="app-sider__footer">{version ? `版本 ${version}` : '\u00a0'}</div>
          )}
        </Sider>
      )}

      <Drawer
        open={drawerOpen}
        placement="left"
        width={248}
        closable={false}
        onClose={() => setDrawerOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        <Brand collapsed={false} />
        {navMenu}
      </Drawer>

      <AntLayout>
        <Header className="app-header">
          {isMobile ? (
            <Button
              type="text"
              icon={<MenuOutlined />}
              aria-label="打开导航"
              onClick={() => setDrawerOpen(true)}
            />
          ) : (
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              onClick={toggleCollapsed}
            />
          )}

          {current ? (
            <Breadcrumb
              style={{ fontSize: 13 }}
              items={[
                { title: current.section.label },
                { title: <span style={{ color: 'var(--app-text)' }}>{current.item.label}</span> },
              ]}
            />
          ) : (
            <span className="text-muted" style={{ fontSize: 13 }}>
              FakeToken
            </span>
          )}

          <span className="app-header__spacer" />

          <Tooltip title="点击刷新余额">
            <button
              type="button"
              className={`balance-chip${lowBalance ? ' balance-chip--empty' : ''}`}
              onClick={() => void refresh()}
              style={{ cursor: 'pointer' }}
            >
              <span className="balance-chip__label">余额</span>
              <span className="balance-chip__value">{formatMoney(user?.quota ?? 0)}</span>
              <ReloadOutlined style={{ fontSize: 11, opacity: 0.5 }} />
            </button>
          </Tooltip>

          <Dropdown menu={themeMenu} trigger={['click']} placement="bottomRight">
            <Button
              type="text"
              aria-label="切换主题"
              icon={
                mode === 'system' ? (
                  <BulbOutlined />
                ) : resolved === 'dark' ? (
                  <MoonOutlined />
                ) : (
                  <SunOutlined />
                )
              }
            />
          </Dropdown>

          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            menu={{
              items: [
                {
                  key: 'header',
                  type: 'group',
                  label: (
                    <div style={{ padding: '4px 0' }}>
                      <div style={{ fontWeight: 600, color: 'var(--app-text)' }}>
                        {user?.display_name || user?.username}
                      </div>
                      <div style={{ fontSize: 12 }}>
                        分组 {user?.group} · {isAdmin ? '管理员' : '普通用户'}
                      </div>
                    </div>
                  ),
                },
                { type: 'divider' },
                { key: '/profile', icon: <UserOutlined />, label: '个人设置' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => (key === 'logout' ? signOut() : navigate(key)),
            }}
          >
            <button type="button" className="user-trigger">
              <Avatar size={26} style={{ background: 'var(--app-brand)' }}>
                {(user?.display_name || user?.username || '?').slice(0, 1).toUpperCase()}
              </Avatar>
              {!isMobile && (
                <span className="user-trigger__name">
                  {user?.display_name || user?.username}
                </span>
              )}
              {isAdmin && !isMobile && (
                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                  管理员
                </Tag>
              )}
            </button>
          </Dropdown>
        </Header>

        <Content>
          <div className="app-content">
            <div key={location.pathname} className="page-enter">
              {children}
            </div>
          </div>
        </Content>
      </AntLayout>
    </AntLayout>
  )
}
