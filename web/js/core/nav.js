/**
 * The navigation tree.
 *
 * One entry per page, in sidebar order.
 *
 * Labels only, deliberately — the sentence under a page title is that page's
 * own copy, and repeating it here would only let the two drift apart.
 */

import { ICONS } from '../ui/icons.js'

export const NAV_SECTIONS = [
  {
    key: 'workspace',
    label: '工作台',
    items: [
      { path: '/', label: '仪表盘', glyph: ICONS.dashboard },
      { path: '/tokens', label: 'API 密钥', glyph: ICONS.key },
      { path: '/models', label: '模型广场', glyph: ICONS.apps },
      { path: '/playground', label: '调用测试', glyph: ICONS.flask },
      { path: '/logs', label: '调用日志', glyph: ICONS.file },
    ],
  },
  {
    key: 'admin',
    label: '系统管理',
    admin: true,
    items: [
      { path: '/admin/logs', label: '全局日志', glyph: ICONS.file },
      { path: '/admin/channels', label: '渠道管理', glyph: ICONS.api },
      { path: '/admin/users', label: '用户管理', glyph: ICONS.team },
      { path: '/admin/groups', label: '分组倍率', glyph: ICONS.bolt },
      { path: '/admin/prices', label: '模型价格', glyph: ICONS.dollar },
      { path: '/admin/redemptions', label: '兑换码', glyph: ICONS.gift },
      { path: '/admin/invites', label: '邀请码', glyph: ICONS.ticket },
      { path: '/admin/settings', label: '全局设置', glyph: ICONS.settings },
    ],
  },
  {
    key: 'account',
    label: '账号',
    items: [
      // Reachable from the account menu rather than the sidebar, but it still
      // needs a title and a breadcrumb.
      { path: '/profile', label: '个人设置', glyph: ICONS.user, hidden: true },
    ],
  },
]

const INDEX = new Map()
for (const section of NAV_SECTIONS) {
  for (const item of section.items) INDEX.set(item.path, { item, section })
}

export const navLookup = (path) => INDEX.get(path)
