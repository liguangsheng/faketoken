/**
 * The usage chart.
 *
 * Hand-drawn SVG rather than a charting library: the console needs exactly one
 * chart — requests as an area, cost on a second axis, errors as a dashed line
 * — and that is a few hundred lines of geometry against 400 kB of dependency.
 *
 * Colours come from CSS variables, so a theme switch repaints the chart
 * without redrawing it.
 */

import { el, on } from '../driver/dom.js'
import { formatCompact, formatNumber, formatUSDValue } from '../core/format.js'

const NS = 'http://www.w3.org/2000/svg'

const VIEW = { width: 960, height: 300 }
const PAD = { top: 12, right: 56, bottom: 28, left: 56 }

const plotWidth = VIEW.width - PAD.left - PAD.right
const plotHeight = VIEW.height - PAD.top - PAD.bottom

const svgEl = (tag, attrs) => {
  const node = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value))
  }
  return node
}

/** Ticks scale with the amount, so a $0.003 day is not a wall of "$0.00". */
function costTick(value) {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(0)}`
}

/** The rounded steps an axis is allowed to end on, smallest first. */
const NICE_STEPS = [1, 2, 5, 10]

/** A "nice" upper bound, so the axis reads 0 / 25 / 50 rather than 0 / 23 / 46. */
function niceMax(value) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalised = value / magnitude
  const step = NICE_STEPS.find((candidate) => normalised <= candidate) ?? 10
  return step * magnitude
}

/**
 * Renders the chart.
 *
 * `points` are { label, fullLabel, requests, errors, costUsd }.
 * Returns an element; call `.destroy()` when the page goes away.
 */
export function usageChart({ points, showErrors = false } = {}) {
  const svg = svgEl('svg', {
    class: 'chart__svg',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  })

  const maxRequests = niceMax(Math.max(...points.map((p) => p.requests), 0))
  const maxCost = niceMax(Math.max(...points.map((p) => p.costUsd), 0))

  // A single bucket has no segment to draw; it is rendered as a dot instead.
  const single = points.length === 1
  const xFor = (index) =>
    single ? PAD.left + plotWidth / 2 : PAD.left + (index / (points.length - 1)) * plotWidth
  const yFor = (value, max) => PAD.top + plotHeight - (value / max) * plotHeight

  // ---- grid and axes
  const TICKS = 4
  for (let i = 0; i <= TICKS; i += 1) {
    const y = PAD.top + (i / TICKS) * plotHeight
    svg.append(
      svgEl('line', { class: 'chart__grid', x1: PAD.left, x2: PAD.left + plotWidth, y1: y, y2: y }),
    )
    const value = maxRequests * (1 - i / TICKS)
    svg.append(
      Object.assign(
        svgEl('text', {
          class: 'chart__axis-text',
          x: PAD.left - 8,
          y: y + 4,
          'text-anchor': 'end',
        }),
        { textContent: formatCompact(value) },
      ),
    )
    svg.append(
      Object.assign(
        svgEl('text', {
          class: 'chart__axis-text',
          x: PAD.left + plotWidth + 8,
          y: y + 4,
          'text-anchor': 'start',
        }),
        { textContent: costTick(maxCost * (1 - i / TICKS)) },
      ),
    )
  }

  // X labels: thinned so they never collide, whatever the bucket count.
  const every = Math.max(1, Math.ceil(points.length / 8))
  points.forEach((point, index) => {
    const last = index === points.length - 1
    if (index % every !== 0 && !last) return

    // The end labels hug the plot edges so they do not overhang it.
    let anchor = 'middle'
    if (index === 0) anchor = 'start'
    else if (last) anchor = 'end'

    svg.append(
      Object.assign(
        svgEl('text', {
          class: 'chart__axis-text',
          x: xFor(index),
          y: VIEW.height - 8,
          'text-anchor': anchor,
        }),
        { textContent: point.label },
      ),
    )
  })

  // ---- series
  const linePath = (accessor, max) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(accessor(p), max)}`).join(' ')

  if (!single) {
    const area =
      `M${PAD.left},${PAD.top + plotHeight} ` +
      points.map((p, i) => `L${xFor(i)},${yFor(p.requests, maxRequests)}`).join(' ') +
      ` L${PAD.left + plotWidth},${PAD.top + plotHeight} Z`
    svg.append(svgEl('path', { class: 'chart__area', d: area }))
    svg.append(svgEl('path', { class: 'chart__line-requests', d: linePath((p) => p.requests, maxRequests) }))
    svg.append(svgEl('path', { class: 'chart__line-cost', d: linePath((p) => p.costUsd, maxCost) }))
    if (showErrors) {
      svg.append(svgEl('path', { class: 'chart__line-errors', d: linePath((p) => p.errors, maxRequests) }))
    }
  } else {
    const point = points[0]
    svg.append(
      svgEl('circle', {
        class: 'chart__line-requests',
        cx: xFor(0),
        cy: yFor(point.requests, maxRequests),
        r: 3,
      }),
    )
    svg.append(
      svgEl('circle', {
        class: 'chart__line-cost',
        cx: xFor(0),
        cy: yFor(point.costUsd, maxCost),
        r: 3,
      }),
    )
  }

  // ---- hover readout
  const hoverLine = svgEl('line', {
    class: 'chart__hover-line',
    y1: PAD.top,
    y2: PAD.top + plotHeight,
    opacity: '0',
  })
  svg.append(hoverLine)

  const tooltip = el('div', { class: 'chart__tooltip', style: { display: 'none' } })
  const container = el('div', { class: 'chart' }, [
    svg,
    tooltip,
    el('div', { class: 'chart__legend' }, [
      legendItem('调用次数', 'var(--app-brand)'),
      legendItem('消费（右轴）', 'var(--app-accent)'),
      showErrors ? legendItem('失败', 'var(--app-danger)') : null,
    ]),
  ])

  const hide = () => {
    tooltip.style.display = 'none'
    hoverLine.setAttribute('opacity', '0')
  }

  const offMove = on(svg, 'pointermove', (event) => {
    const box = svg.getBoundingClientRect()
    if (box.width === 0) return

    // The viewBox is stretched to the element's width, so the pointer has to
    // be converted back into viewBox units before it can pick a bucket.
    const x = ((event.clientX - box.left) / box.width) * VIEW.width
    const ratio = (x - PAD.left) / plotWidth
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))))
    const point = points[index]
    if (!point) return

    hoverLine.setAttribute('x1', String(xFor(index)))
    hoverLine.setAttribute('x2', String(xFor(index)))
    hoverLine.setAttribute('opacity', '1')

    tooltip.replaceChildren(
      el('div', { class: 'chart__tooltip-label' }, point.fullLabel),
      tooltipRow('调用次数', formatNumber(point.requests), 'var(--app-brand)'),
      tooltipRow('消费', formatUSDValue(point.costUsd), 'var(--app-accent)'),
      showErrors ? tooltipRow('失败', formatNumber(point.errors), 'var(--app-danger)') : null,
    )

    tooltip.style.display = 'block'
    // Flipped to the other side near the right edge so it stays on screen.
    const left = (xFor(index) / VIEW.width) * box.width
    const flip = left > box.width - 170
    tooltip.style.left = `${flip ? left - 162 : left + 12}px`
    tooltip.style.top = '8px'
  })

  const offLeave = on(svg, 'pointerleave', hide)

  container.destroy = () => {
    offMove()
    offLeave()
  }
  return container
}

function legendItem(label, colour) {
  return el('span', {}, [
    el('span', { class: 'chart__legend-dot', style: { background: colour } }),
    label,
  ])
}

function tooltipRow(label, value, colour) {
  return el('div', { class: 'chart__tooltip-row' }, [
    el('span', { class: 'text-muted' }, [
      el('span', { class: 'chart__legend-dot', style: { background: colour } }),
      label,
    ]),
    el('strong', {}, value),
  ])
}
