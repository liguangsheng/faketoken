/**
 * Bootstrap.
 *
 * Decides between the login form and the console, and registers the routes.
 */

import { el } from './driver/dom.js'
import * as sessionStore from './core/session.js'
import * as router from './core/router.js'
import * as theme from './core/theme.js'
import * as consoleSettings from './core/settings.js'
import { createShell } from './shell.js'
import { renderLogin } from './pages/login.js'
import { renderDashboard } from './pages/dashboard.js'
import { renderProfile } from './pages/profile.js'
import { renderGroups } from './pages/groups.js'
import { renderUsers } from './pages/users.js'
import { renderPlaza } from './pages/plaza.js'
import { renderPrices } from './pages/prices.js'
import { renderSettings } from './pages/settings/index.js'
import { renderTokens } from './pages/tokens.js'
import { renderChannels } from './pages/channels/index.js'
import { renderAdminLogs, renderLogs } from './pages/logs/index.js'
import { renderPlayground } from './pages/playground.js'
import { renderRedemptions } from './pages/codes/redemptions.js'
import { renderInvites } from './pages/codes/invites.js'
import { button } from './ui/controls.js'
import { emptyState } from './ui/feedback.js'
import { toast } from './ui/toast.js'

const root = document.getElementById('app')

/** What the shell is currently showing: nothing, the login form, or a session. */
let mounted = null
let shell = null

function mountLogin() {
  if (mounted === 'login') return
  teardown()
  mounted = 'login'
  renderLogin(root)
}

function mountConsole() {
  if (mounted === 'console') return
  teardown()
  mounted = 'console'

  shell = createShell()
  root.append(shell.root)
  router.start(shell.content)
}

function teardown() {
  router.reset()
  shell?.destroy()
  shell = null
  root.replaceChildren()
  mounted = null
}

/** The first paint, before the session has been read back. */
function mountBooting() {
  if (mounted === 'booting') return
  teardown()
  mounted = 'booting'
  root.append(
    el('div', { class: 'boot' }, el('div', { class: 'skeleton', style: { width: '160px', height: '8px' } })),
  )
}

// ---- routes ---------------------------------------------------------------

router.route('/', renderDashboard)
router.route('/profile', renderProfile)
router.route('/models', renderPlaza)
router.route('/tokens', renderTokens)
router.route('/logs', renderLogs)
router.route('/playground', renderPlayground)
// The server refuses the underlying endpoints for a non-admin anyway; this
// only avoids rendering a page whose every call would come back 403.
const adminOnly = (render) => (container) =>
  sessionStore.isAdmin() ? render(container) : renderForbidden(container)

router.route('/admin/groups', adminOnly(renderGroups))
router.route('/admin/users', adminOnly(renderUsers))
router.route('/admin/prices', adminOnly(renderPrices))
router.route('/admin/settings', adminOnly(renderSettings))
router.route('/admin/channels', adminOnly(renderChannels))
router.route('/admin/logs', adminOnly(renderAdminLogs))
router.route('/admin/redemptions', adminOnly(renderRedemptions))
router.route('/admin/invites', adminOnly(renderInvites))

router.setNotFound((container) => {
  container.append(
    emptyState({
      title: '页面不存在',
      description: window.location.pathname,
      action: button({ label: '回到仪表盘', variant: 'primary', onClick: () => router.navigate('/') }),
    }),
  )
})

function renderForbidden(container) {
  container.append(
    emptyState({
      title: '没有权限访问这个页面',
      description: '该页面仅管理员可见。',
      action: button({ label: '回到仪表盘', variant: 'primary', onClick: () => router.navigate('/') }),
    }),
  )
}

// ---- start ----------------------------------------------------------------

theme.start()
mountBooting()

sessionStore.subscribe((state) => {
  if (state.loading) {
    mountBooting()
    return
  }

  if (!state.user) {
    // Drop the cached preferences: the next session may be a different
    // account, and page size is stored per deployment, not per browser.
    consoleSettings.reset()
    mountLogin()
    return
  }

  if (consoleSettings.isLoaded()) {
    mountConsole()
    return
  }

  // Tables read the default page size as their initial state, so the console
  // waits for it rather than loading once at the wrong size and reloading.
  // A failed read leaves the fallback in place and still mounts: a missing
  // preference is not a reason to refuse the whole console.
  mountBooting()
  void consoleSettings.refresh().then(() => {
    if (sessionStore.getUser()) mountConsole()
  })
})

sessionStore
  .start({
    onExpired: () => toast.warning('登录已过期，请重新登录', 4000),
  })
  .catch((error) => {
    console.error('session bootstrap failed', error)
  })

// Tells the fatal-error handler in index.html that the modules got this far;
// anything failing after this point is a page error, not a boot failure.
window.__consoleBooted = true
