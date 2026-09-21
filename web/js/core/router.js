/**
 * History-API router.
 *
 * Routes are exact paths — this console has no parameterised ones — and a page
 * is a function that renders into a container and returns an optional cleanup.
 * Running that cleanup on every navigation is what stops timers and streams
 * from outliving the page that started them, which a framework would otherwise
 * have done in an unmount hook.
 */

const routes = new Map()
let notFound = null
let container = null
let disposeCurrent = null
let currentPath = null
const listeners = new Set()

/** Registers a page. `render(container)` may return a cleanup function. */
export function route(path, render) {
  routes.set(path, render)
}

export function setNotFound(render) {
  notFound = render
}

/** Notified after every navigation, so the shell can restyle its nav. */
export function onNavigate(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const path = () => window.location.pathname

/**
 * Navigates within the console.
 *
 * An absolute URL or a path this router does not own is a full page load, so
 * the server gets to answer it rather than pushState showing a blank frame.
 */
export function navigate(to, { replace = false } = {}) {
  if (/^https?:\/\//i.test(to) || !routes.has(to)) {
    window.location.assign(to)
    return
  }
  if (to === window.location.pathname) return

  if (replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  render()
}

/** Re-renders the current path, tearing the previous page down first. */
export function render() {
  const next = window.location.pathname

  // Cleanup runs before the container is emptied, so a page can still read
  // its own nodes (scroll position, focus) while unwinding.
  if (disposeCurrent) {
    try {
      disposeCurrent()
    } catch (error) {
      console.error('page cleanup failed', error)
    }
    disposeCurrent = null
  }

  container.replaceChildren()
  currentPath = next

  const page = routes.get(next) ?? notFound
  if (!page) return

  const dispose = page(container)
  disposeCurrent = typeof dispose === 'function' ? dispose : null

  for (const listener of listeners) listener(next)
}

/** Tears the current page down without rendering another — used at sign-out. */
export function reset() {
  if (disposeCurrent) {
    try {
      disposeCurrent()
    } catch (error) {
      console.error('page cleanup failed', error)
    }
    disposeCurrent = null
  }
  currentPath = null
  container?.replaceChildren()
}

export const mountedPath = () => currentPath

/**
 * Starts routing into `target`.
 *
 * Link clicks are intercepted here rather than at each anchor, so a page can
 * emit a plain <a href> and still get client-side navigation — while
 * middle-click and Cmd/Ctrl-click keep opening a real tab, which is what makes
 * the log and channel pages usable against a second screen.
 */
export function start(target) {
  container = target

  window.addEventListener('popstate', render)

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    const anchor = event.target.closest?.('a[href]')
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return

    const url = new URL(anchor.href, window.location.href)
    if (url.origin !== window.location.origin) return
    // Not ours: let the browser load it normally.
    if (!routes.has(url.pathname)) return

    event.preventDefault()
    navigate(url.pathname)
  })

  render()
}
