import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Avatar,
  Badge,
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
  DesktopOutlined,
  ExclamationCircleOutlined,
  LogoutOutlined,
  MenuOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  ReloadOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { IMAGE_PAGE, useImageJobs } from '../imageJobs/ImageJobsContext'
import { NAV_SECTIONS, navLookup } from '../nav'
import type { NavItem } from '../nav'
import { useThemeMode } from '../theme/ThemeProvider'
import type { ThemeMode } from '../theme/ThemeProvider'
import { formatMoney, formatUSD, toUSD } from '../utils/format'

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
      <img className="app-brand__mark" src="/favicon.svg" alt="" />
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
  const { running: runningImageJobs } = useImageJobs()

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [version, setVersion] = useState('')
  // Manual balance refresh needs visible feedback; the auto-poll stays silent.
  const [refreshingBalance, setRefreshingBalance] = useState(false)

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
    // A render left running on another page stays in sight on its entry.
    const label = (item: NavItem) => (
      <Link to={item.key}>
        {item.label}
        {item.key === IMAGE_PAGE && runningImageJobs > 0 && (
          <Badge count={runningImageJobs} size="small" style={{ marginInlineStart: 6 }} />
        )}
      </Link>
    )

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
          label: label(item),
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
        // A real link, so middle-click / Cmd+click opens a page in a new tab —
        // indispensable when reading logs against another screen.
        label: label(item),
      })),
    }))
  }, [collapsed, isMobile, sections, runningImageJobs])

  const navMenu = (
    <Menu
      mode="inline"
      selectedKeys={[location.pathname]}
      items={menuItems}
      style={{ border: 'none', paddingBlock: 4 }}
      // The label anchors handle their own navigation (and modifier clicks);
      // this catches clicks on the icon and padding around them.
      onClick={({ key, domEvent }) => {
        if (!(domEvent.target as HTMLElement).closest('a')) navigate(key)
      }}
    />
  )

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1')
      return !value
    })
  }

  const quotaMicro = user?.quota ?? 0
  const balanceEmpty = quotaMicro <= 0
  // A heads-up tier: warn while there is still money to act on.
  const balanceLow = !balanceEmpty && toUSD(quotaMicro) < 1

  const refreshBalance = async () => {
    setRefreshingBalance(true)
    try {
      await refresh()
    } finally {
      setRefreshingBalance(false)
    }
  }

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
        title={<Brand collapsed={false} />}
        onClose={() => setDrawerOpen(false)}
        styles={{ body: { padding: 0 }, header: { padding: '0 8px 0 0' } }}
      >
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
            isMobile ? (
              // The drawer already gives the section context; on a phone the
              // page name alone is what fits.
              <span
                style={{
                  color: 'var(--app-text)',
                  fontSize: 13,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {current.item.label}
              </span>
            ) : (
              <Breadcrumb
                style={{ fontSize: 13 }}
                items={[
                  { title: current.section.label },
                  { title: <span style={{ color: 'var(--app-text)' }}>{current.item.label}</span> },
                ]}
              />
            )
          ) : (
            <span className="text-muted" style={{ fontSize: 13 }}>
              FakeToken
            </span>
          )}

          <span className="app-header__spacer" />

          <Tooltip
            title={
              balanceEmpty
                ? '余额已用尽，请充值后再调用 · 点击刷新'
                : balanceLow
                  ? `余额不足 $1（${formatUSD(quotaMicro)}），请及时充值 · 点击刷新`
                  : `${formatUSD(quotaMicro)} · 点击刷新`
            }
          >
            <button
              type="button"
              className={`balance-chip${
                balanceEmpty ? ' balance-chip--empty' : balanceLow ? ' balance-chip--low' : ''
              }`}
              aria-label={`余额 ${formatMoney(quotaMicro)}${
                balanceEmpty ? '，已用尽' : balanceLow ? '，不足 $1' : ''
              }，点击刷新`}
              onClick={() => void refreshBalance()}
            >
              <span className="balance-chip__label">余额</span>
              <span className="balance-chip__value">{formatMoney(quotaMicro)}</span>
              {(balanceEmpty || balanceLow) && (
                <ExclamationCircleOutlined
                  style={{
                    color: balanceEmpty ? 'var(--app-danger)' : 'var(--app-warning)',
                    fontSize: 11,
                  }}
                />
              )}
              <ReloadOutlined spin={refreshingBalance} style={{ fontSize: 11, opacity: 0.5 }} />
            </button>
          </Tooltip>

          <Dropdown menu={themeMenu} trigger={['click']} placement="bottomRight">
            <Button
              type="text"
              aria-label="切换主题"
              icon={
                mode === 'system' ? (
                  <DesktopOutlined />
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
            <button
              type="button"
              className="user-trigger"
              aria-label={`账户菜单：${user?.display_name || user?.username || ''}`}
              aria-haspopup="menu"
            >
              {/* soft 底 + 品牌色前景：白字压在浅紫上在暗色下会糊掉 */}
              <Avatar
                size={26}
                style={{ background: 'var(--app-brand-soft)', color: 'var(--app-brand)' }}
              >
                <span aria-hidden>
                  {(user?.display_name || user?.username || '?').slice(0, 1).toUpperCase()}
                </span>
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
