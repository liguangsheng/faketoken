/**
 * Transient messages.
 *
 * One host node, appended once, so a page never has to own the lifetime of a
 * message it raised — a toast outlives the page that produced it, which is
 * what makes "保存成功" survive the navigation that follows it.
 */

import { el, icon } from '../driver/dom.js'
import { ICONS } from './icons.js'

const MAX_VISIBLE = 3
const DEFAULT_MS = 2500

let host = null

function ensureHost() {
  if (!host) {
    // aria-live so a screen reader announces what a sighted user sees.
    host = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' })
    document.body.append(host)
  }
  return host
}

const GLYPH = {
  success: ICONS.check,
  error: ICONS.close,
  warning: ICONS.warning,
  info: ICONS.info,
}

function show(type, content, duration = DEFAULT_MS) {
  const parent = ensureHost()

  // The oldest goes when a fourth arrives: a stack taller than this covers the
  // control that is producing them.
  while (parent.childElementCount >= MAX_VISIBLE) parent.firstElementChild.remove()

  const node = el('div', { class: `toast toast--${type}` }, [
    el('span', { class: 'toast__icon' }, icon(GLYPH[type] ?? GLYPH.info, { size: 15 })),
    el('span', {}, String(content)),
  ])
  parent.append(node)

  const timer = window.setTimeout(() => node.remove(), duration)
  return () => {
    window.clearTimeout(timer)
    node.remove()
  }
}

export const toast = {
  success: (content, duration) => show('success', content, duration),
  error: (content, duration) => show('error', content, duration ?? 4000),
  warning: (content, duration) => show('warning', content, duration),
  info: (content, duration) => show('info', content, duration),
}

/** The message an unknown failure should carry, never "[object Object]". */
export const errorText = (error, fallback = '操作失败') =>
  error instanceof Error ? error.message : fallback
