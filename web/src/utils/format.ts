import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const MICRO_USD = 1_000_000

/** Balances and costs are stored as integer micro-USD. */
export const toUSD = (micro: number) => micro / MICRO_USD

export const formatUSD = (micro: number, digits = 4) => {
  const value = toUSD(micro)
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs !== 0 && abs < 0.0001) return `${sign}$${abs.toExponential(2)}`
  return `${sign}$${abs.toFixed(digits)}`
}

/** Same precision rules as formatUSD, for values already in dollars. */
export const formatUSDValue = (value: number, digits = 4) => formatUSD(value * MICRO_USD, digits)

/**
 * A per-1M-token unit price, as entered by the operator (a dollar amount, not
 * micro-USD). One shared shape so the price page and the plaza render the
 * same number the same way: no float noise, no scientific notation.
 */
export const formatPrice = (value: number) => {
  if (!value) return '$0'
  const sign = value < 0 ? '-' : ''
  const rounded = Number(Math.abs(value).toPrecision(6))
  return `${sign}$${rounded.toLocaleString('en-US', { maximumFractionDigits: 10 })}`
}

export const formatMoney = (micro: number) => formatUSD(micro, 2)

export const formatNumber = (value: number) => value.toLocaleString('en-US')

/** 12 345 -> "12.3k". Keeps chart axes and dense tables readable. */
export const formatCompact = (value: number) => {
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`
}

export const formatPercent = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`

export const formatTime = (value?: string | null) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'

/**
 * "08-15 11:42:03" — an absolute timestamp that still fits a table column.
 * The year is dropped because log tables are read in the present; the full
 * value stays available in a tooltip.
 */
export const formatTimeShort = (value?: string | null) =>
  value ? dayjs(value).format('MM-DD HH:mm:ss') : '-'

/** "2026-08-19 11:42" — for deadlines, where the exact date matters but seconds don't. */
export const formatDateMinute = (value?: string | null) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'

/** "3 分钟前" — pair it with a tooltip carrying the absolute timestamp. */
export const formatRelative = (value?: string | null, fallback = '-') =>
  value ? dayjs(value).fromNow() : fallback

/** "4 MiB" — binary units, matching how the capture limit is configured. */
export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`
}

export const formatDuration = (ms: number) => {
  if (ms <= 0) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export const STATUS = {
  ENABLED: 1,
  DISABLED: 2,
}

/** Splits a textarea into a trimmed, de-duplicated list. */
export const parseList = (text: string) =>
  Array.from(
    new Set(
      text
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )

/** Parses "from=to" lines into the model mapping object. */
export const parseMapping = (text: string): Record<string, string> => {
  const mapping: Record<string, string> = {}
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const separator = line.includes('=') ? '=' : ':'
      const index = line.indexOf(separator)
      if (index <= 0) return
      const from = line.slice(0, index).trim()
      const to = line.slice(index + 1).trim()
      if (from && to) mapping[from] = to
    })
  return mapping
}

export const stringifyMapping = (mapping: Record<string, string> | null | undefined) =>
  Object.entries(mapping ?? {})
    .map(([from, to]) => `${from}=${to}`)
    .join('\n')
