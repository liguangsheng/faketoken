/**
 * A tab strip.
 *
 * Only the strip: which tab is active and how to switch. What each tab shows
 * is the caller's business, because the two pages that use tabs want
 * different things underneath — one a card, one a code block.
 */

import { el, replace } from '../driver/dom.js'

/**
 * Builds the strip.
 *
 *   tabs({ items: [{ key, label }], value, onChange, marked?: Set })
 *
 * `marked` names tabs that should carry a dot — the settings page uses it for
 * "this tab has unsaved changes", which has to be visible from every other tab
 * or it is only found on the way back. Call `.setValue()` / `.setMarked()` to
 * restyle without rebuilding.
 */
export function tabs({ items, value, onChange, marked = null, ariaLabel = null } = {}) {
  let current = value
  let dots = marked ?? new Set()

  const node = el('div', { class: 'tabs', role: 'tablist', 'aria-label': ariaLabel })

  const paint = () => {
    replace(
      node,
      items.map((item) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `tabs__item${item.key === current ? ' tabs__item--active' : ''}`,
            'aria-selected': item.key === current ? 'true' : 'false',
            onclick: () => {
              if (item.key === current) return
              current = item.key
              paint()
              onChange?.(item.key)
            },
          },
          [
            item.label,
            dots.has(item.key) && el('span', { class: 'tabs__dot', 'aria-label': '有未保存的修改' }),
          ],
        ),
      ),
    )
  }

  paint()

  node.setValue = (next) => {
    current = next
    paint()
  }
  node.setMarked = (next) => {
    dots = next ?? new Set()
    paint()
  }
  node.value = () => current
  return node
}
