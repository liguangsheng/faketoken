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
  SettingOutlined,
  SolutionOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons'

export interface NavItem {
  key: string
  label: string
  icon: ReactNode
  /** Short sentence rendered under the page title. */
  description: string
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
      {
        key: '/',
        label: '仪表盘',
        icon: <BarChartOutlined />,
        description: '用量、消费与调用成功率概览',
      },
      {
        key: '/tokens',
        label: 'API 密钥',
        icon: <KeyOutlined />,
        description: '创建密钥并把中转地址填给任意客户端',
      },
      {
        key: '/models',
        label: '模型广场',
        icon: <AppstoreOutlined />,
        description: '当前分组可用的模型与实际计费单价',
      },
      {
        key: '/playground',
        label: '调用测试',
        icon: <ExperimentOutlined />,
        description: '走完整路由链路发起真实请求，会计费并留下日志',
      },
      {
        key: '/logs',
        label: '调用日志',
        icon: <FileTextOutlined />,
        description: '每次请求的渠道、用量、耗时与错误详情',
      },
    ],
  },
  {
    key: 'admin',
    label: '系统管理',
    admin: true,
    items: [
      {
        key: '/admin/logs',
        label: '全局日志',
        icon: <FileTextOutlined />,
        description: '全部用户的逐次调用记录与完整正文',
        admin: true,
      },
      {
        key: '/admin/channels',
        label: '渠道管理',
        icon: <ApiOutlined />,
        description: '上游渠道、优先级权重与模型清单',
        admin: true,
      },
      {
        key: '/admin/users',
        label: '用户管理',
        icon: <TeamOutlined />,
        description: '账号、分组、余额与权限',
        admin: true,
      },
      {
        key: '/admin/groups',
        label: '分组倍率',
        icon: <ThunderboltOutlined />,
        description: '分组决定可用渠道与计费倍率',
        admin: true,
      },
      {
        key: '/admin/prices',
        label: '模型价格',
        icon: <DollarOutlined />,
        description: '按「美元 / 100 万 Token」维护模型单价',
        admin: true,
      },
      {
        key: '/admin/redemptions',
        label: '兑换码',
        icon: <GiftOutlined />,
        description: '生成兑换码，用户自助充值余额',
        admin: true,
      },
      {
        key: '/admin/invites',
        label: '邀请码',
        icon: <SolutionOutlined />,
        description: '生成邀请码，控制谁可以注册',
        admin: true,
      },
      {
        key: '/admin/settings',
        label: '全局设置',
        icon: <SettingOutlined />,
        description: '对所有用户生效的控制台配置',
        admin: true,
      },
    ],
  },
  {
    key: 'account',
    label: '账号',
    items: [
      {
        key: '/profile',
        label: '个人设置',
        icon: <UserOutlined />,
        description: '资料、密码、兑换码充值与账户用量',
        hidden: true,
      },
    ],
  },
]

const INDEX: Record<string, { item: NavItem; section: NavSection }> = {}
for (const section of NAV_SECTIONS) {
  for (const item of section.items) INDEX[item.key] = { item, section }
}

export const navLookup = (pathname: string) => INDEX[pathname]
