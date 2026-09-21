/**
 * Light / dark / follow-system.
 *
 * The resolved mode is written to `data-theme` on <html>, which is what every
 * colour in the stylesheet keys off. index.html resolves it once before the
 * first paint; this module keeps it in step afterwards.
 */

// The key predates this console; keeping it preserves everyone's choice.
const STORAGE_KEY = 'faketoken-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const listeners = new Set()
let mode = read()

function read() {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

const systemMode = () => (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light')

export const getMode = () => mode
export const resolved = () => (mode === 'system' ? systemMode() : mode)

export const MODES = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
]

function apply() {
  document.documentElement.dataset.theme = resolved()
  for (const listener of listeners) listener(mode, resolved())
}

export function setMode(next) {
  mode = next
  localStorage.setItem(STORAGE_KEY, next)
  apply()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function start() {
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    // Only matters while following the system; setting it explicitly wins.
    if (mode === 'system') apply()
  })
  apply()
}
