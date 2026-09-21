/**
 * Placeholders: what a page shows instead of data.
 *
 * Kept together because the choice between them is a single decision — first
 * load, no rows, or failed — and scattering that across pages is how the three
 * end up looking like three different products.
 */

import { el } from '../driver/dom.js'

/** Nothing to show, and why. `action` is an optional button. */
export function emptyState({ title, description, action, compact = false } = {}) {
  return el('div', { class: `empty${compact ? ' empty--compact' : ''}` }, [
    title && el('div', { class: 'empty__title' }, title),
    description && el('div', { class: 'empty__description' }, description),
    action && el('div', { class: 'empty__action' }, action),
  ])
}

/** Grey bars standing in for text that has not arrived yet. */
export function skeleton(rows = 4) {
  return el(
    'div',
    {},
    Array.from({ length: rows }, (_, index) =>
      el('div', {
        class: 'skeleton skeleton__line',
        // A ragged last line reads as text rather than as a broken layout.
        style: { width: index === rows - 1 ? '60%' : '100%' },
      }),
    ),
  )
}

/** A card-shaped skeleton, for the dashboard's first paint. */
export function skeletonCard(height = 300) {
  return el('div', { class: 'skeleton', style: { height: `${height}px` } })
}
