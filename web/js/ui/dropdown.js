/**
 * Click-to-open menus.
 *
 * Items are built on open rather than up front, so a menu always reflects the
 * state at the moment it is opened — which account is signed in, which theme
 * is active — instead of the state when the page was rendered.
 */

import { el, icon, on, replace } from '../driver/dom.js'
import { ICONS } from './icons.js'

/**
 * Anchors a menu to a trigger.
 *
 * The menu is parked on <body> and positioned against the trigger, not nested
 * beside it: an ancestor that dims (opacity) or scrolls (overflow) swallows a
 * nested menu — it renders faded, paints under the rows below it and hands
 * them the clicks, or gets cut off at the container's edge.
 *
 * Returns { node, close, destroy }. The caller owns `destroy`: the document
 * listeners outlive the menu itself, and leaking one per table row is how a
 * long-lived console starts reacting to clicks nobody made.
 */
export function dropdown(trigger, buildItems) {
  const menu = el('div', { class: 'dropdown__menu', role: 'menu' })
  const node = el('div', { class: 'dropdown' }, [trigger])
  let open = false

  const close = () => {
    open = false
    menu.remove()
    trigger.setAttribute('aria-expanded', 'false')
  }

  /** Right edges aligned, below the trigger when it fits, above it when not. */
  const place = () => {
    const anchor = trigger.getBoundingClientRect()
    const { width, height } = menu.getBoundingClientRect()
    const gap = 6
    const edge = 8

    const below = anchor.bottom + gap
    const above = anchor.top - gap - height
    const top = below + height <= window.innerHeight - edge ? below : above

    menu.style.left = `${Math.max(edge, Math.min(anchor.right - width, window.innerWidth - width - edge))}px`
    // The menu's max-height keeps it shorter than the viewport, so clamping
    // the top alone is enough to keep the bottom on screen too.
    menu.style.top = `${Math.max(edge, top)}px`
  }

  const show = () => {
    open = true
    replace(menu, buildItems())
    document.body.append(menu)
    place()
    trigger.setAttribute('aria-expanded', 'true')
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    if (open) close()
    else show()
  })

  // Selecting an item closes the menu; so does clicking anywhere outside it.
  menu.addEventListener('click', close)
  const offDocument = on(document, 'click', () => {
    if (open) close()
  })
  const offKey = on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && open) close()
  })
  // A detached menu cannot follow its trigger, so scrolling dismisses it
  // rather than leaving it floating over unrelated rows. Capture, because
  // scroll does not bubble out of the container that scrolled; a menu long
  // enough to scroll on its own is exempt, or it would close as it is read.
  const offScroll = on(
    document,
    'scroll',
    (event) => {
      if (open && !menu.contains(event.target)) close()
    },
    true,
  )
  const offResize = on(window, 'resize', () => {
    if (open) close()
  })

  close()
  return {
    node,
    close,
    destroy: () => {
      menu.remove()
      offDocument()
      offKey()
      offScroll()
      offResize()
    },
  }
}

export function menuItem({
  label,
  glyph = null,
  onSelect,
  active = false,
  danger = false,
  disabled = false,
  title = null,
}) {
  const classes = ['dropdown__item']
  if (active) classes.push('dropdown__item--active')
  if (danger) classes.push('dropdown__item--danger')

  return el(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      class: classes.join(' '),
      disabled,
      title,
      onclick: disabled ? null : onSelect,
    },
    [
      glyph && icon(glyph, { size: 15 }),
      el('span', {}, label),
      active && icon(ICONS.check, { size: 14 }),
    ],
  )
}
