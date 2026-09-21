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
 * Returns { node, close, destroy }. The caller owns `destroy`: the document
 * listeners outlive the menu itself, and leaking one per table row is how a
 * long-lived console starts reacting to clicks nobody made.
 */
export function dropdown(trigger, buildItems) {
  const menu = el('div', {
    class: 'dropdown__menu',
    role: 'menu',
    style: { display: 'none' },
  })
  const node = el('div', { class: 'dropdown' }, [trigger, menu])
  let open = false

  const close = () => {
    open = false
    menu.style.display = 'none'
    trigger.setAttribute('aria-expanded', 'false')
  }

  const show = () => {
    open = true
    replace(menu, buildItems())
    menu.style.display = ''
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

  close()
  return {
    node,
    close,
    destroy: () => {
      offDocument()
      offKey()
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
