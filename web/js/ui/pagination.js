/**
 * Pager for a server-paged list.
 *
 * Page numbers are windowed rather than listed in full: a log table can run to
 * hundreds of pages, and a control that grows with the data stops being one.
 */

import { el, icon } from '../driver/dom.js'
import { formatNumber } from '../core/format.js'
import { ICONS } from './icons.js'

const PAGE_SIZES = [10, 20, 50, 100]

/** Page numbers around `current`, with gaps collapsed to an ellipsis. */
function pageWindow(current, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)

  const window = new Set([1, pages, current, current - 1, current + 1])
  // The first and last pages are always reachable; so are the two neighbours.
  const sorted = [...window].filter((page) => page >= 1 && page <= pages).sort((a, b) => a - b)

  const output = []
  let previous = 0
  for (const page of sorted) {
    if (previous && page - previous > 1) output.push('…')
    output.push(page)
    previous = page
  }
  return output
}

/**
 * Builds the pager.
 *
 * `onChange(page, pageSize)` is called with the full pair, because changing
 * the size has to reset the page — a page 9 of 10 does not exist once the
 * rows per page quadruple.
 */
export function pagination({ page, pageSize, total, unit = '条', onChange } = {}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))

  // Nothing to page through, and the count is already in the empty state.
  if (total === 0) return el('div')

  const numbers = pageWindow(page, pages).map((entry) => {
    if (entry === '…') return el('span', { class: 'pager__gap' }, '…')
    const active = entry === page
    return el(
      'button',
      {
        type: 'button',
        class: `pager__page${active ? ' pager__page--active' : ''}`,
        'aria-current': active ? 'page' : null,
        'aria-label': `第 ${entry} 页`,
        onclick: () => !active && onChange(entry, pageSize),
      },
      String(entry),
    )
  })

  const step = (delta, label, glyph) =>
    el(
      'button',
      {
        type: 'button',
        class: 'pager__page',
        'aria-label': label,
        disabled: delta < 0 ? page <= 1 : page >= pages,
        onclick: () => onChange(page + delta, pageSize),
      },
      icon(glyph, { size: 15 }),
    )

  const sizeSelect = el(
    'select',
    {
      class: 'input select pager__size',
      'aria-label': '每页条数',
      onchange: (event) => onChange(1, Number(event.target.value)),
    },
    PAGE_SIZES.map((size) =>
      el('option', { value: String(size), selected: size === pageSize }, `${size} / 页`),
    ),
  )

  return el('div', { class: 'pager' }, [
    el('span', { class: 'pager__total' }, `共 ${formatNumber(total)} ${unit}`),
    el('span', { class: 'pager__spacer' }),
    // A single page still shows the size control: it is how you get off one.
    pages > 1 && step(-1, '上一页', ICONS.chevronLeft),
    pages > 1 && el('div', { class: 'pager__pages' }, numbers),
    pages > 1 && step(1, '下一页', ICONS.chevronRight),
    sizeSelect,
  ])
}
