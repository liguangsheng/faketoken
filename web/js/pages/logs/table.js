/**
 * The log table itself.
 *
 * Owned separately from the page because it has to be mutated in place: a
 * live feed inserts rows at the top several times a second, and rebuilding
 * the whole table on each arrival would drop the pointer's hover, cancel the
 * shift animation and steal focus from whatever the operator was reading.
 * So `paint` replaces everything, and `prepend` / `setLive` touch only the
 * rows that changed.
 *
 * On a phone a horizontally scrolling table can only ever show a slice of a
 * row at once. It collapses instead to one full-width column whose cell packs
 * every field a log is read for into a compact card.
 */

import { el, icon, replace } from '../../driver/dom.js'
import { formatCompact, formatDuration, formatDayTime, formatNumber, formatTime, formatUSD } from '../../core/format.js'
import { button, tag } from '../../ui/controls.js'
import { ICONS } from '../../ui/icons.js'
import { REASONING_TONE, rowTone } from './tone.js'
import { isLive, rowKeyOf } from './inflight.js'

// Past this, a call that is still running is worth a second look rather than
// just being slow. Deliberately generous: a long agentic completion
// legitimately runs this long, so it colours the number instead of flagging.
const SLOW_CALL_MS = 60_000

// Keep the highlight until it has fully faded; the CSS motion is shorter, but
// the cushion also covers its per-cell stagger.
const LIVE_ROW_ANIMATION_MS = 1000
const LIVE_ROW_SHIFT_MS = 620
const LIVE_ROW_SHIFT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Creates the table.
 *
 *   { admin, phone, onOpen(row), onCancel(key), empty() }
 *
 * Returns { node, paint(rows), prepend(row), setLive(rows), tick(), hasRow(id) }.
 */
export function createLogTable({ admin, phone, onOpen, onCancel, empty }) {
  const columns = admin ? adminColumns() : userColumns()
  const span = phone ? 1 : columns.length

  const thead = el('thead', {}, el('tr', {}, phone ? [el('th', {}, '调用记录')] : columns.map(headCell)))
  const tbody = el('tbody')
  const node = el('div', { class: 'table-wrap' }, [
    el('table', { class: `table log-table${phone ? ' log-table--phone' : ''}` }, [
      el('caption', { class: 'sr-only' }, '调用日志'),
      thead,
      tbody,
    ]),
  ])

  // What is drawn, in order: live placeholders first, then settled rows.
  let settled = []
  let live = []
  let pageSize = 20
  const byKey = new Map()
  const shiftAnimations = new Map()
  const enterTimers = new Map()
  // Keys with a cancel in flight. A set, because an operator clearing out a
  // stuck upstream presses several in a row.
  const cancelling = new Set()

  // ---- rows -------------------------------------------------------------

  function buildRow(row) {
    const running = isLive(row)
    const tr = el('tr', {
      class: running ? 'log-row--running' : null,
      dataset: { key: rowKeyOf(row) },
      // A call that has not finished has no stored exchange to read, so it is
      // not a click target: the drawer would open on nothing.
      tabindex: running ? null : 0,
      'aria-label': running ? null : `查看调用 #${row.id} 详情`,
    })

    if (!running) {
      tr.addEventListener('click', (event) => {
        // A drag-select also emits a click on the row in some browsers. Only
        // suppress it when the selection touches this row.
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) {
          const touches = [selection.anchorNode, selection.focusNode].some(
            (n) => n !== null && tr.contains(n),
          )
          if (touches) return
        }
        // Buttons inside the row own their own clicks.
        if (event.target.closest('button')) return
        onOpen(row)
      })
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') onOpen(row)
      })
    }

    if (phone) {
      tr.append(el('td', {}, phoneCard(row)))
    } else {
      for (const column of columns) {
        tr.append(el('td', { class: cellClass(column) }, column.render(row)))
      }
    }
    return tr
  }

  function cellClass(column) {
    const classes = []
    if (column.at) classes.push(`col-${column.at}`)
    if (column.align === 'right') classes.push('cell-right')
    return classes.length ? classes.join(' ') : null
  }

  function headCell(column) {
    return el('th', { class: cellClass(column), style: column.width ? { width: `${column.width}px` } : null, title: column.hint ?? null }, column.title)
  }

  // ---- live-only cells ------------------------------------------------------

  /** The elapsed time of a running call, ticked by the page once a second. */
  function elapsedText(row) {
    return formatDuration(Math.max(0, Date.now() - new Date(row.created_at).getTime()))
  }

  function cancelButton(row) {
    const key = row.live_key
    const control = button({
      label: '取消',
      variant: 'link danger',
      glyph: ICONS.stop,
      onClick: async () => {
        if (cancelling.has(key)) return
        cancelling.add(key)
        control.setBusy(true)
        try {
          await onCancel(key)
        } finally {
          cancelling.delete(key)
          if (control.isConnected) control.setBusy(false)
        }
      },
    })
    return control
  }

  // ---- desktop columns --------------------------------------------------

  function timeCell(row) {
    const running = isLive(row)
    const node = el('div', { class: 'cell-stack' }, [
      el('span', { class: 'mono' }, formatDayTime(row.created_at)),
      // A running call has no id yet — the row number is minted by the
      // database when the call settles.
      el('span', { class: 'mono text-muted cell-stack__sub' }, running ? '在途' : `#${row.id}`),
    ])
    node.title = running ? `开始于 ${formatTime(row.created_at)}，尚未结束` : formatTime(row.created_at)
    return node
  }

  function channelCell(row) {
    if (!(row.channel_id > 0)) return el('span', { class: 'text-muted' }, '-')
    return el('div', { class: 'cell-stack' }, [
      el('span', {}, Object.assign(tag(`#${row.channel_id}`), { className: 'tag mono' })),
      row.channel_name &&
        el('span', { class: 'text-muted cell-stack__sub truncate', title: row.channel_name, style: { maxWidth: '120px' } }, row.channel_name),
    ])
  }

  function tokenCell(row) {
    return el('div', { class: 'cell-stack' }, [
      admin && el('span', {}, row.username || '-'),
      el('span', { class: admin ? 'text-muted cell-stack__sub' : null }, row.token_name || '-'),
    ])
  }

  function clientCell(row) {
    return row.client_type && row.client_type !== 'unknown'
      ? tag(row.client_type)
      : el('span', { class: 'text-muted' }, '未知')
  }

  function modelCell(row) {
    const mapped = row.upstream_model && row.upstream_model !== row.model
    const node = el('div', { class: 'cell-stack', style: { minWidth: '0' } }, [
      el('span', { class: 'mono truncate' }, row.model),
      mapped
        ? el('span', { class: 'mono text-muted cell-stack__sub truncate' }, `→ ${row.upstream_model}`)
        : !admin && el('span', { class: 'text-muted cell-stack__sub' }, '未映射'),
    ])
    node.title = mapped ? `客户端请求 ${row.model}，实际转发 ${row.upstream_model}` : row.model
    return node
  }

  function reasoningCell(row) {
    if (row.reasoning_effort) return tag(row.reasoning_effort, REASONING_TONE[row.reasoning_effort] ?? null)
    return admin ? null : el('span', { class: 'text-muted' }, '未指定')
  }

  function ipCell(row) {
    return row.client_ip ? el('span', { class: 'mono', title: row.client_ip }, row.client_ip) : el('span', { class: 'text-muted' }, '-')
  }

  function statusCell(row) {
    const running = isLive(row)
    let status
    if (running) {
      status = Object.assign(tag('进行中', 'brand'), { title: '已转发给上游，还在等待回应' })
      status.prepend(icon(ICONS.loading, { size: 11 }))
      status.firstElementChild.classList.add('spin')
    } else {
      status = tag(String(row.status_code), rowTone(row))
      if (row.error && row.status_code < 400) status.title = '上游返回 200，但响应体中带有错误'
    }
    return el('div', { class: 'row', style: { gap: '4px' } }, [
      status,
      row.stream && Object.assign(tag('流', 'brand'), { title: '流式响应' }),
      row.retries > 0 && Object.assign(tag(`×${row.retries + 1}`, 'warning'), { title: `共尝试 ${row.retries + 1} 次（切换 ${row.retries} 次渠道）` }),
    ])
  }

  /**
   * Total above, first-byte below, with a vertical bar that fills with the
   * fraction of time-to-first-byte of the total — the longer the bar, the
   * more the caller waited before anything came back.
   */
  function durationCell(row) {
    if (isLive(row)) {
      const elapsed = Date.now() - new Date(row.created_at).getTime()
      const text = el('span', { class: `mono${elapsed >= SLOW_CALL_MS ? ' text-warning' : ''}` }, elapsedText(row))
      const node = el('div', { class: 'duration-cell' }, [
        el('span', { class: 'duration-bar duration-bar--running', 'aria-hidden': 'true' }),
        el('div', { class: 'cell-stack' }, [text, el('span', { class: 'text-muted cell-stack__sub' }, '…')]),
      ])
      node.title = `已运行 ${elapsedText(row)}`
      // Ticked by the page: the only moving part of a running row.
      node.dataset.elapsed = '1'
      node._tick = () => {
        const now = Date.now() - new Date(row.created_at).getTime()
        text.textContent = elapsedText(row)
        text.classList.toggle('text-warning', now >= SLOW_CALL_MS)
        node.title = `已运行 ${elapsedText(row)}`
      }
      return node
    }

    const value = row.duration_ms
    const ratio = value > 0 && row.ttfb_ms > 0 ? Math.min(row.ttfb_ms / value, 1) : 0
    const node = el('div', { class: 'duration-cell' }, [
      el('span', {
        class: 'duration-bar',
        'aria-hidden': 'true',
        // Brand = waiting for the first byte, neutral = the stream itself.
        style: { background: `linear-gradient(to top, var(--app-brand) ${ratio * 100}%, var(--app-border-strong) ${ratio * 100}%)` },
      }),
      el('div', { class: 'cell-stack' }, [
        el('span', { class: 'mono' }, formatDuration(value)),
        row.ttfb_ms > 0
          ? el('span', { class: 'mono text-muted cell-stack__sub' }, formatDuration(row.ttfb_ms))
          : el('span', { class: 'text-muted cell-stack__sub' }, '-'),
      ]),
    ])
    node.title = row.ttfb_ms > 0 ? `总耗时 ${formatDuration(value)} · 首字 ${formatDuration(row.ttfb_ms)}` : `总耗时 ${formatDuration(value)}`
    return node
  }

  function tokensCell(row) {
    // Usage is only known once the upstream has answered, and a running call
    // showing 0 would read as a call that used none.
    if (isLive(row)) return el('span', { class: 'text-muted' }, '-')
    const node = el('div', { class: 'cell-stack' }, [
      el('span', { class: 'mono' }, [el('span', { class: 'text-muted' }, '↑'), formatCompact(row.prompt_tokens)]),
      el('span', { class: 'mono text-muted cell-stack__sub' }, `↓${formatCompact(row.completion_tokens)}`),
    ])
    node.title = `输入 ${formatNumber(row.prompt_tokens)} · 输出 ${formatNumber(row.completion_tokens)} · 合计 ${formatNumber(row.total_tokens)}`
    return node
  }

  function costCell(row) {
    return isLive(row) ? el('span', { class: 'text-muted' }, '-') : formatUSD(row.cost)
  }

  /**
   * A running call has no error yet, and it is the only kind of row that can
   * still be acted on — so the column that would otherwise show a dash
   * carries the stop button instead.
   */
  function errorCell(row) {
    if (isLive(row)) return admin ? cancelButton(row) : el('span', { class: 'text-muted' }, '-')
    if (row.error) return el('span', { class: 'text-danger truncate', title: row.error, style: { display: 'block' } }, row.error)
    return el('span', { class: 'text-muted' }, '-')
  }

  function adminColumns() {
    return [
      { key: 'createdAt', title: '时间 / ID', width: 150, render: timeCell },
      { key: 'channel', title: '渠道', width: 140, at: 'md', render: channelCell },
      { key: 'token', title: '用户 / 密钥', width: 130, at: 'lg', render: tokenCell },
      { key: 'client', title: '客户端', width: 110, at: 'lg', render: clientCell },
      { key: 'model', title: '模型', width: 210, at: 'md', render: modelCell },
      { key: 'reasoning', title: '思考强度', width: 110, at: 'lg', render: reasoningCell },
      { key: 'clientIP', title: '来源 IP', width: 130, at: 'lg', render: ipCell },
      { key: 'status', title: '状态', width: 172, render: statusCell },
      { key: 'duration', title: '耗时 / 首字', width: 120, at: 'md', hint: '总耗时 / 首字时间', render: durationCell },
      { key: 'tokens', title: 'Tokens', width: 80, at: 'lg', align: 'right', hint: 'Tokens：↑ 输入 · ↓ 输出，合计悬停单元格可见', render: tokensCell },
      { key: 'cost', title: '费用', width: 100, at: 'md', align: 'right', render: costCell },
      { key: 'error', title: '错误', render: errorCell },
    ]
  }

  function userColumns() {
    return [
      { key: 'createdAt', title: '时间 / ID', width: 150, render: timeCell },
      { key: 'model', title: '模型', width: 210, render: modelCell },
      { key: 'token', title: '密钥', width: 130, at: 'lg', render: tokenCell },
      { key: 'status', title: '状态', width: 150, render: statusCell },
      { key: 'duration', title: '耗时 / 首字', width: 120, at: 'md', hint: '总耗时 / 首字时间', render: durationCell },
      { key: 'tokens', title: 'Tokens', width: 80, at: 'md', align: 'right', hint: 'Tokens：↑ 输入 · ↓ 输出', render: tokensCell },
      { key: 'cost', title: '费用', width: 100, align: 'right', render: costCell },
      { key: 'reasoning', title: '思考强度', width: 110, at: 'lg', render: reasoningCell },
      { key: 'error', title: '错误', render: errorCell },
    ]
  }

  // ---- phone card ---------------------------------------------------------

  function phoneCard(row) {
    const running = isLive(row)
    const mapped = row.upstream_model && row.upstream_model !== row.model
    const tone = running ? 'live' : { success: 'ok', warning: 'warn', danger: 'err' }[rowTone(row)]

    const meta = (glyph, text, cls = '') =>
      el('span', { class: `log-card__meta-item${cls ? ` ${cls}` : ''}` }, [
        glyph && icon(glyph, { size: 12 }),
        el('span', { class: 'log-card__meta-text' }, text),
      ])

    const durationText = el('span', { class: 'log-card__meta-text' }, running ? elapsedText(row) : formatDuration(row.duration_ms))
    const duration = el('span', { class: 'log-card__meta-item' }, [icon(ICONS.fieldTime, { size: 12 }), durationText])
    if (running) {
      duration.dataset.elapsed = '1'
      duration._tick = () => {
        durationText.textContent = elapsedText(row)
      }
    }

    let status
    if (running) {
      status = tag('进行中', 'brand')
      status.prepend(icon(ICONS.loading, { size: 11 }))
      status.firstElementChild.classList.add('spin')
    } else {
      status = tag(String(row.status_code), rowTone(row))
    }

    return el('div', { class: `log-card log-card--${tone}` }, [
      el('div', { class: 'log-card__top' }, [
        el('span', { class: 'log-card__model mono' }, row.model),
        el('span', { class: 'log-card__cost mono' }, running ? '' : formatUSD(row.cost)),
      ]),
      mapped && el('div', { class: 'log-card__mapped mono text-muted' }, `→ ${row.upstream_model}`),
      el('div', { class: 'log-card__tags' }, [
        status,
        row.stream && tag('流', 'brand'),
        row.retries > 0 && tag(`×${row.retries + 1}`, 'warning'),
        row.reasoning_effort && tag(row.reasoning_effort, REASONING_TONE[row.reasoning_effort] ?? null),
        row.client_type && row.client_type !== 'unknown' && tag(row.client_type),
      ]),
      el('div', { class: 'log-card__meta' }, [
        meta(ICONS.clock, formatDayTime(row.created_at)),
        !running && meta(null, `#${row.id}`, 'log-card__meta-item--end'),
        duration,
        !running && meta(ICONS.number, `${formatCompact(row.prompt_tokens)}/${formatCompact(row.completion_tokens)}`, 'log-card__meta-item--end'),
        row.channel_id > 0 && meta(ICONS.api, `#${row.channel_id}${row.channel_name ? ` ${row.channel_name}` : ''}`, 'log-card__meta-item--wide'),
        meta(ICONS.key, `${admin && row.username ? `${row.username} · ` : ''}${row.token_name || '-'}`, 'log-card__meta-item--wide'),
      ]),
      row.error && el('div', { class: 'log-card__error' }, row.error),
      running && admin && el('div', { style: { marginTop: '6px' } }, cancelButton(row)),
    ])
  }

  // ---- FLIP ---------------------------------------------------------------

  /**
   * Remembers where every visible row is right now, so a row inserted above
   * them can push them down from that position rather than have them jump.
   * getBoundingClientRect includes any in-flight transform, which lets a busy
   * feed continue smoothly from wherever the previous push got to.
   */
  function snapshot() {
    if (!admin || reducedMotion()) return null
    const tops = new Map()
    for (const tr of tbody.querySelectorAll('tr[data-key]')) {
      tops.set(tr.dataset.key, tr.getBoundingClientRect().top)
    }
    return tops
  }

  /** After the DOM changed: move every old row back, then animate to its new place. */
  function shiftFrom(tops) {
    if (!tops) return
    // Cancel after capturing the old visual positions, so the next delta is
    // measured against each row's clean, final layout position.
    const previous = [...shiftAnimations.values()]
    shiftAnimations.clear()
    for (const animation of previous) animation.cancel()

    for (const tr of tbody.querySelectorAll('tr[data-key]')) {
      const key = tr.dataset.key
      const before = tops.get(key)
      if (before === undefined) continue
      const delta = before - tr.getBoundingClientRect().top
      if (Math.abs(delta) < 0.5) continue

      const animation = tr.animate(
        [{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: LIVE_ROW_SHIFT_MS, easing: LIVE_ROW_SHIFT_EASING },
      )
      shiftAnimations.set(key, animation)
      const release = () => {
        if (shiftAnimations.get(key) === animation) shiftAnimations.delete(key)
      }
      animation.onfinish = release
      animation.oncancel = release
    }
  }

  function highlight(tr) {
    if (!admin || reducedMotion()) return
    const key = tr.dataset.key
    tr.classList.add('log-row--enter')
    const previous = enterTimers.get(key)
    if (previous !== undefined) window.clearTimeout(previous)
    enterTimers.set(
      key,
      window.setTimeout(() => {
        enterTimers.delete(key)
        tr.classList.remove('log-row--enter')
      }, LIVE_ROW_ANIMATION_MS),
    )
  }

  // ---- DOM sync -----------------------------------------------------------

  /** Everything drawn, in order. */
  const drawn = () => [...live, ...settled].slice(0, pageSize)

  /** Rebuilds the body from scratch. The page calls this on a load. */
  function paint() {
    byKey.clear()
    const rows = drawn()
    if (rows.length === 0) {
      replace(tbody, el('tr', {}, el('td', { colspan: span }, empty())))
      return
    }
    const fragment = document.createDocumentFragment()
    for (const row of rows) {
      const tr = buildRow(row)
      byKey.set(rowKeyOf(row), tr)
      fragment.append(tr)
    }
    replace(tbody, fragment)
  }

  /** Drops rows past the page size, from the bottom. */
  function trim() {
    const keep = new Set(drawn().map(rowKeyOf))
    for (const [key, tr] of byKey) {
      if (keep.has(key)) continue
      tr.remove()
      byKey.delete(key)
    }
  }

  /** The first settled row's element, which live rows are inserted before. */
  const firstSettled = () => (settled.length ? byKey.get(rowKeyOf(settled[0])) ?? null : null)

  return {
    node,

    setPageSize(size) {
      pageSize = size
    },

    /** A fresh page of settled rows. */
    paint(rows) {
      settled = rows
      paint()
    },

    hasRow: (id) => settled.some((row) => row.id === id),

    /**
     * One settled row arrived live. Inserted above the newest settled row
     * (below any placeholders), highlighted, and the rows beneath it slide
     * down from where they were.
     */
    prepend(row) {
      if (settled.some((r) => r.id === row.id)) return false
      const tops = snapshot()
      const wasEmpty = settled.length === 0 && live.length === 0
      settled = [row, ...settled]
      if (wasEmpty) {
        paint()
        return true
      }
      const tr = buildRow(row)
      byKey.set(rowKeyOf(row), tr)
      const anchor = byKey.get(rowKeyOf(settled[1])) ?? null
      tbody.insertBefore(tr, anchor)
      trim()
      shiftFrom(tops)
      highlight(tr)
      return true
    },

    /**
     * The committed set of running calls. Placeholders that left are removed,
     * new ones are inserted at the top, and ones still present are redrawn in
     * place so a re-routed call names its new channel.
     */
    setLive(rows) {
      const tops = snapshot()
      const next = new Map(rows.map((row) => [rowKeyOf(row), row]))
      const wasEmpty = settled.length === 0 && live.length === 0

      // Gone: retire the element.
      for (const row of live) {
        const key = rowKeyOf(row)
        if (next.has(key)) continue
        byKey.get(key)?.remove()
        byKey.delete(key)
      }

      live = rows
      if (wasEmpty || (settled.length === 0 && rows.length === 0)) {
        paint()
        return
      }

      // Present: redraw in place. New: insert in order at the top.
      let anchor = firstSettled()
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]
        const key = rowKeyOf(row)
        const existing = byKey.get(key)
        const tr = buildRow(row)
        byKey.set(key, tr)
        if (existing) {
          existing.replaceWith(tr)
        } else {
          tbody.insertBefore(tr, anchor)
          highlight(tr)
        }
        anchor = tr
      }
      // An empty-state row may be sitting there from a previous paint.
      for (const tr of tbody.querySelectorAll('tr:not([data-key])')) tr.remove()
      trim()
      shiftFrom(tops)
    },

    /** Once a second while anything is running: refreshes elapsed times. */
    tick() {
      for (const node of tbody.querySelectorAll('[data-elapsed]')) node._tick?.()
    },

    destroy() {
      for (const timer of enterTimers.values()) window.clearTimeout(timer)
      enterTimers.clear()
      for (const animation of shiftAnimations.values()) animation.cancel()
      shiftAnimations.clear()
    },
  }
}
