/**
 * Tables.
 *
 * Columns carry their own reveal breakpoint: what a row is and what it costs
 * stay at every width, and the rest come back as there is room. The hiding itself is CSS — a class per column — so a
 * resize does not re-render anything.
 *
 *   column: { key, title, width?, at?: 'md' | 'lg', align?, sortable?, render(row) }
 *
 * `expand` adds a disclosure column and renders a detail row under each open
 * one: { opened: Set, rowId(row), onToggle(id), render(row) }. The set is the
 * caller's, so which rows are open survives the repaint that a save triggers.
 */

import { el, icon } from '../driver/dom.js'
import { checkbox } from './controls.js'
import { ICONS } from './icons.js'

const cellClass = (column) => {
  const classes = []
  if (column.at) classes.push(`col-${column.at}`)
  if (column.align === 'right') classes.push('cell-right')
  return classes.length > 0 ? classes.join(' ') : null
}

/**
 * Builds a table.
 *
 * `selection` turns on the checkbox column:
 *   { selected: Set, rowId(row), onChange(nextSet), disabled(row)?, disabledHint? }
 *
 * The selected set is owned by the caller and handed back whole on every
 * change, so the page keeps one source of truth rather than two that can drift.
 */
export function table({
  columns,
  rows,
  rowKey,
  empty = null,
  caption = null,
  selection = null,
  sort = null,
  expand = null,
  rowClass = null,
} = {}) {
  const headCells = columns.map((column) => {
    const attrs = {
      class: cellClass(column),
      style: column.width ? { width: `${column.width}px` } : null,
      scope: 'col',
    }

    // A sortable header is a button inside the cell, not a click handler on
    // the cell: it has to be reachable by keyboard and announce its state.
    if (!column.sortable || !sort) return el('th', attrs, column.title)

    const active = sort.key === column.key
    let order = 'none'
    if (active) order = sort.desc ? 'descending' : 'ascending'
    attrs['aria-sort'] = order

    return el(
      'th',
      attrs,
      el(
        'button',
        {
          type: 'button',
          class: `th-sort${active ? ' th-sort--active' : ''}`,
          onclick: () => sort.onSort(column.key),
        },
        [
          el('span', {}, column.title),
          active && icon(sort.desc ? ICONS.sortDesc : ICONS.sortAsc, { size: 13 }),
        ],
      ),
    )
  })

  if (selection) {
    // Rows the server would refuse cannot be selected, so a bulk action never
    // reports a count the backend is going to reduce.
    const selectable = rows.filter((row) => !selection.disabled?.(row))
    const selectedCount = selectable.filter((row) =>
      selection.selected.has(selection.rowId(row)),
    ).length

    const all = checkbox({
      checked: selectable.length > 0 && selectedCount === selectable.length,
      indeterminate: selectedCount > 0 && selectedCount < selectable.length,
      disabled: selectable.length === 0,
      ariaLabel: '全选本页',
      onChange: (checked) => {
        const next = new Set(selection.selected)
        for (const row of selectable) {
          if (checked) next.add(selection.rowId(row))
          else next.delete(selection.rowId(row))
        }
        selection.onChange(next)
      },
    })

    headCells.unshift(el('th', { class: 'cell-select', scope: 'col' }, all))
  }

  if (expand) headCells.push(el('th', { class: 'cell-expand', scope: 'col' }))

  const body = el('tbody')
  const span = columns.length + (selection ? 1 : 0) + (expand ? 1 : 0)

  if (rows.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: span }, empty)))
  } else {
    for (const row of rows) {
      const cells = columns.map((column) =>
        el('td', { class: cellClass(column) }, column.render(row)),
      )

      const opened = expand ? expand.opened.has(expand.rowId(row)) : false
      if (expand) {
        cells.push(
          el(
            'td',
            { class: 'cell-expand' },
            el(
              'button',
              {
                type: 'button',
                class: `expand-toggle${opened ? ' expand-toggle--open' : ''}`,
                'aria-expanded': opened ? 'true' : 'false',
                'aria-label': opened ? '收起详情' : '展开详情',
                onclick: () => expand.onToggle(expand.rowId(row)),
              },
              icon(ICONS.chevronRight, { size: 12 }),
            ),
          ),
        )
      }

      if (selection) {
        const id = selection.rowId(row)
        const blocked = Boolean(selection.disabled?.(row))
        cells.unshift(
          el(
            'td',
            { class: 'cell-select' },
            checkbox({
              checked: selection.selected.has(id),
              disabled: blocked,
              title: blocked ? selection.disabledHint : null,
              ariaLabel: `选择第 ${id} 行`,
              onChange: (checked) => {
                const next = new Set(selection.selected)
                if (checked) next.add(id)
                else next.delete(id)
                selection.onChange(next)
              },
            }),
          ),
        )
      }

      const classes = []
      if (rowClass) {
        const extra = rowClass(row)
        if (extra) classes.push(extra)
      }
      if (opened) classes.push('row-expanded')

      body.append(
        el(
          'tr',
          {
            class: classes.length > 0 ? classes.join(' ') : null,
            dataset: rowKey ? { key: String(rowKey(row)) } : null,
          },
          cells,
        ),
      )

      if (opened) {
        body.append(el('tr', { class: 'row-detail' }, el('td', { colspan: span }, expand.render(row))))
      }
    }
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      caption && el('caption', { class: 'sr-only' }, caption),
      el('thead', {}, el('tr', {}, headCells)),
      body,
    ]),
  ])
}

/** Two lines in one cell: a value with its quieter qualifier underneath. */
export function cellStack(primary, secondary) {
  return el('div', { class: 'cell-stack' }, [
    el('span', {}, primary),
    el('span', { class: 'cell-stack__sub' }, secondary),
  ])
}
