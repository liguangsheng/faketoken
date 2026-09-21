/**
 * The console shell: sidebar, header, and the container pages render into.
 *
 * Built once per session rather than per navigation. The router swaps only the
 * content node, so the sidebar keeps its scroll position and the header keeps
 * its balance reading while moving between pages.
 */

import { el, icon, on, replace, watchMedia } from './driver/dom.js'
import { api } from './core/api.js'
import * as sessionStore from './core/session.js'
import * as router from './core/router.js'
import * as theme from './core/theme.js'
import { NAV_SECTIONS, navLookup } from './core/nav.js'
import { formatMoney, formatUSD, toUSD } from './core/format.js'
import { dropdown, menuItem } from './ui/dropdown.js'
import { ICONS } from './ui/icons.js'
import { toast } from './ui/toast.js'

/** One glyph per theme mode, shared by the header button and its menu. */
const THEME_GLYPH = {
  light: ICONS.sun,
  dark: ICONS.moon,
  system: ICONS.desktop,
}

const COLLAPSE_KEY = 'faketoken-sider-collapsed'
/** The balance in the header is only useful if it tracks actual spending. */
const BALANCE_REFRESH_MS = 60_000
const MOBILE_QUERY = '(max-width: 991px)'

export function createShell() {
  const content = el('main', { class: 'app-content' })
  const cleanups = []

  let collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'
  let drawerOpen = false

  const mobile = watchMedia(MOBILE_QUERY, () => {
    closeDrawer()
    paintLayout()
  })
  cleanups.push(mobile.stop)

  // ---- sidebar ----------------------------------------------------------

  const brand = (showText) =>
    el('div', { class: 'app-brand' }, [
      el('img', { class: 'app-brand__mark', src: '/favicon.svg', alt: '' }),
      showText &&
        el('span', { class: 'app-brand__text' }, [
          el('span', { class: 'app-brand__title' }, 'FakeToken'),
          el('span', { class: 'app-brand__subtitle' }, 'API Gateway'),
        ]),
    ])

  /** Builds the nav list. Plain <a>s: the router intercepts the clicks. */
  const navList = () => {
    const node = el('nav', { class: 'app-sider__nav', 'aria-label': '主导航' })
    const current = router.path()

    for (const section of NAV_SECTIONS) {
      if (section.admin && !sessionStore.isAdmin()) continue
      const items = section.items.filter((item) => !item.hidden)
      if (items.length === 0) continue

      const group = el('div', { class: 'nav-group' }, [
        el('div', { class: 'nav-group__label' }, section.label),
      ])

      for (const item of items) {
        const active = item.path === current
        group.append(
          el(
            'a',
            {
              class: `nav-item${active ? ' nav-item--active' : ''}`,
              href: item.path,
              'aria-current': active ? 'page' : null,
              title: collapsed ? item.label : null,
            },
            [
              icon(item.glyph, { size: 16 }),
              el('span', { class: 'nav-item__label' }, item.label),
            ],
          ),
        )
      }
      node.append(group)
    }
    return node
  }

  const siderFooter = el('div', { class: 'app-sider__footer' }, '\u00a0')
  const sider = el('aside', { class: 'app-sider' })

  const paintSider = () => {
    sider.classList.toggle('app-sider--collapsed', collapsed)
    replace(sider, [brand(!collapsed), navList(), !collapsed && siderFooter])
  }

  // ---- mobile drawer ----------------------------------------------------

  let drawerNodes = null

  function closeDrawer() {
    if (!drawerNodes) return
    drawerNodes.scrim.remove()
    drawerNodes.drawer.remove()
    drawerNodes = null
    drawerOpen = false
  }

  function openDrawer() {
    if (drawerOpen) return
    drawerOpen = true
    const scrim = el('div', { class: 'drawer-scrim', onclick: closeDrawer })
    const drawer = el('div', { class: 'app-drawer', role: 'dialog', 'aria-label': '导航' }, [
      brand(true),
      navList(),
    ])
    drawerNodes = { scrim, drawer }
    document.body.append(scrim, drawer)
  }

  // ---- header -----------------------------------------------------------

  const menuButton = el(
    'button',
    { type: 'button', class: 'btn btn--icon', 'aria-label': '打开导航', onclick: openDrawer },
    icon(ICONS.menu, { size: 18 }),
  )

  const collapseButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--icon',
      onclick: () => {
        collapsed = !collapsed
        localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
        paintSider()
        paintLayout()
      },
    },
    icon(ICONS.menuFold, { size: 18 }),
  )

  const crumb = el('div', { class: 'app-header__crumb' })

  const balanceChip = el('button', {
    type: 'button',
    class: 'balance-chip',
    onclick: async () => {
      await sessionStore.refresh()
      toast.success('余额已刷新')
    },
  })

  const themeButton = el('button', {
    type: 'button',
    class: 'btn btn--icon',
    'aria-label': '切换主题',
    'aria-haspopup': 'menu',
  })
  const themeMenu = dropdown(themeButton, () =>
    theme.MODES.map((option) =>
      menuItem({
        label: option.label,
        glyph: THEME_GLYPH[option.key],
        active: theme.getMode() === option.key,
        onSelect: () => {
          theme.setMode(option.key)
          paintTheme()
        },
      }),
    ),
  )

  const userButton = el('button', {
    type: 'button',
    class: 'user-trigger',
    'aria-haspopup': 'menu',
  })
  const userMenu = dropdown(userButton, () => {
    const user = sessionStore.getUser()
    return [
      el('div', { class: 'dropdown__header' }, [
        el('div', { style: { fontWeight: '600' } }, user?.display_name || user?.username || ''),
        el(
          'div',
          { class: 'text-small text-muted' },
          `分组 ${user?.group ?? '-'} · ${sessionStore.isAdmin() ? '管理员' : '普通用户'}`,
        ),
      ]),
      menuItem({
        label: '个人设置',
        glyph: ICONS.user,
        onSelect: () => router.navigate('/profile'),
      }),
      el('div', { class: 'dropdown__divider' }),
      menuItem({
        label: '退出登录',
        glyph: ICONS.logout,
        danger: true,
        onSelect: () => sessionStore.signOut(),
      }),
    ]
  })

  cleanups.push(themeMenu.destroy, userMenu.destroy)

  const header = el('header', { class: 'app-header' }, [
    menuButton,
    collapseButton,
    crumb,
    el('span', { class: 'app-header__spacer' }),
    balanceChip,
    themeMenu.node,
    userMenu.node,
  ])

  // ---- painting ---------------------------------------------------------

  function paintLayout() {
    const isMobile = mobile.matches()
    sider.style.display = isMobile ? 'none' : ''
    menuButton.style.display = isMobile ? '' : 'none'
    collapseButton.style.display = isMobile ? 'none' : ''
    collapseButton.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏')
    replace(collapseButton, icon(collapsed ? ICONS.menuUnfold : ICONS.menuFold, { size: 18 }))
  }

  function paintTheme() {
    replace(themeButton, icon(THEME_GLYPH[theme.getMode()], { size: 17 }))
  }

  function paintCrumb() {
    const found = navLookup(router.path())
    document.title = found ? `${found.item.label} · FakeToken` : 'FakeToken'

    if (!found) {
      replace(crumb, 'FakeToken')
      return
    }
    replace(crumb, [`${found.section.label} / `, el('strong', {}, found.item.label)])
  }

  function paintBalance() {
    const user = sessionStore.getUser()
    const quota = user?.quota ?? 0
    const empty = quota <= 0
    // A heads-up tier: warn while there is still money left to act on.
    const low = !empty && toUSD(quota) < 1

    let modifier = ''
    let hint = `${formatUSD(quota)} · 点击刷新`
    if (empty) {
      modifier = ' balance-chip--empty'
      hint = '余额已用尽，请充值后再调用 · 点击刷新'
    } else if (low) {
      modifier = ' balance-chip--low'
      hint = `余额不足 $1（${formatUSD(quota)}）· 点击刷新`
    }

    balanceChip.className = `balance-chip${modifier}`
    balanceChip.title = hint
    balanceChip.setAttribute('aria-label', `余额 ${formatMoney(quota)}，点击刷新`)

    replace(balanceChip, [
      el('span', { class: 'balance-chip__label' }, '余额'),
      el('span', { class: 'balance-chip__value' }, formatMoney(quota)),
      (empty || low) && icon(ICONS.warning, { size: 12 }),
      icon(ICONS.reload, { size: 12 }),
    ])
  }

  function paintUser() {
    const user = sessionStore.getUser()
    const name = user?.display_name || user?.username || '?'
    replace(userButton, [
      el('span', { class: 'avatar' }, name.slice(0, 1).toUpperCase()),
      !mobile.matches() && el('span', { class: 'truncate' }, name),
      !mobile.matches() && sessionStore.isAdmin() && el('span', { class: 'tag tag--warning' }, '管理员'),
    ])
    userButton.setAttribute('aria-label', `账户菜单：${name}`)
  }

  // ---- wiring -----------------------------------------------------------

  cleanups.push(
    sessionStore.subscribe(() => {
      paintBalance()
      paintUser()
      paintSider()
    }),
  )

  cleanups.push(
    router.onNavigate(() => {
      closeDrawer()
      paintSider()
      paintCrumb()
      // Balance and counters drift as requests flow through the relay, so the
      // profile is re-read whenever the operator moves around.
      void sessionStore.refresh()
    }),
  )

  const timer = window.setInterval(() => void sessionStore.refresh(), BALANCE_REFRESH_MS)
  cleanups.push(() => window.clearInterval(timer))

  cleanups.push(
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void sessionStore.refresh()
    }),
  )

  api
    .version()
    .then((result) => {
      siderFooter.textContent = result.version ? `版本 ${result.version}` : '\u00a0'
    })
    .catch(() => {
      siderFooter.textContent = '\u00a0'
    })

  paintSider()
  paintLayout()
  paintTheme()
  paintBalance()
  paintUser()

  const root = el('div', { class: 'app-shell' }, [
    sider,
    el('div', { class: 'app-main' }, [header, content]),
  ])

  return {
    root,
    content,
    destroy: () => {
      closeDrawer()
      for (const stop of cleanups) stop()
    },
  }
}
