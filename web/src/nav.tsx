import type { ReactNode } from 'react'
import {
  ApiOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  DollarOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  GiftOutlined,
  KeyOutlined,
  PictureOutlined,
  SettingOutlined,
  SolutionOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons'

/**
 * Navigation is label-only on purpose. The sentence under a page title is the
 * page's own copy (see each page's PageHeader): three of them are dynamic —
 * the dashboard varies by role, the plaza names the group and its rate, the
 * price table counts its rows — so a static string here could only ever be a
 * second, staler version of the same thing.
 */
export interface NavItem {
  key: string
  label: string
  icon: ReactNode
  admin?: boolean
  /** Hidden from the sidebar but still needs a title/breadcrumb. */
  hidden?: boolean
}

export interface NavSection {
  key: string
  label: string
  admin?: boolean
  items: NavItem[]
}

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'workspace',
    label: '工作台',
    items: [
      { key: '/', label: '仪表盘', icon: <BarChartOutlined /> },
      { key: '/tokens', label: 'API 密钥', icon: <KeyOutlined /> },
      { key: '/models', label: '模型广场', icon: <AppstoreOutlined /> },
      { key: '/logs', label: '调用日志', icon: <FileTextOutlined /> },
    ],
  },
  {
    key: 'admin',
    label: '系统管理',
    admin: true,
    items: [
      { key: '/admin/logs', label: '全局日志', icon: <FileTextOutlined />, admin: true },
      { key: '/admin/channels', label: '渠道管理', icon: <ApiOutlined />, admin: true },
      { key: '/admin/playground', label: '调用测试', icon: <ExperimentOutlined />, admin: true },
      { key: '/admin/playground/images', label: '生图测试', icon: <PictureOutlined />, admin: true },
      { key: '/admin/users', label: '用户管理', icon: <TeamOutlined />, admin: true },
      { key: '/admin/groups', label: '分组倍率', icon: <ThunderboltOutlined />, admin: true },
      { key: '/admin/prices', label: '模型价格', icon: <DollarOutlined />, admin: true },
      { key: '/admin/redemptions', label: '兑换码', icon: <GiftOutlined />, admin: true },
      { key: '/admin/invites', label: '邀请码', icon: <SolutionOutlined />, admin: true },
      { key: '/admin/settings', label: '全局设置', icon: <SettingOutlined />, admin: true },
    ],
  },
  {
    key: 'account',
    label: '账号',
    items: [{ key: '/profile', label: '个人设置', icon: <UserOutlined />, hidden: true }],
  },
]

const INDEX: Record<string, { item: NavItem; section: NavSection }> = {}
for (const section of NAV_SECTIONS) {
  for (const item of section.items) INDEX[item.key] = { item, section }
}

export const navLookup = (pathname: string) => INDEX[pathname]
