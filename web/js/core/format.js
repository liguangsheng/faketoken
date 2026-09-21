/**
 * Number and time formatting.
 *
 * The relative-time helper stands in for dayjs: the only thing that was used
 * for is a handful of Chinese phrases, which is not worth a dependency.
 */

const MICRO_USD = 1_000_000

/** Balances and costs are stored as integer micro-USD. */
export const toUSD = (micro) => micro / MICRO_USD

export function formatUSD(micro, digits = 4) {
  const value = toUSD(micro ?? 0)
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs !== 0 && abs < 0.0001) return `${sign}$${abs.toExponential(2)}`
  return `${sign}$${abs.toFixed(digits)}`
}

/** Same precision rules, for a value already in dollars. */
export const formatUSDValue = (value, digits = 4) => formatUSD((value ?? 0) * MICRO_USD, digits)

export const formatMoney = (micro) => formatUSD(micro, 2)

/**
 * A per-1M-token unit price, as the operator entered it (a dollar amount, not
 * micro-USD).
 *
 * One shared shape so the price table and the plaza render the same number the
 * same way: no float noise, no scientific notation.
 */
export function formatPrice(value) {
  if (!value) return '$0'
  const sign = value < 0 ? '-' : ''
  const rounded = Number(Math.abs(value).toPrecision(6))
  return `${sign}$${rounded.toLocaleString('en-US', { maximumFractionDigits: 10 })}`
}

export const formatNumber = (value) => Math.round(value ?? 0).toLocaleString('en-US')

/** 12 345 -> "12.3k". Keeps chart axes and dense tables readable. */
export function formatCompact(value) {
  const number = value ?? 0
  const abs = Math.abs(number)
  if (abs < 1000) return String(Math.round(number))
  if (abs < 1_000_000) return `${(number / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(number / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`
}

export const formatPercent = (value, digits = 1) => `${((value ?? 0) * 100).toFixed(digits)}%`

const pad = (value) => String(value).padStart(2, '0')

const parseDate = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "2026-08-19 11:42:03" */
export function formatTime(value) {
  const date = parseDate(value)
  if (!date) return '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** "08-19 11:42" — for axes and dense cells, where the year is noise. */
export function formatDayTime(value, withTime = true) {
  const date = parseDate(value)
  if (!date) return '-'
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day
}

/** "11:42" — the hour-bucket axis label. */
export function formatHour(value) {
  const date = parseDate(value)
  if (!date) return '-'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const RELATIVE_STEPS = [
  { limit: 45, divisor: 1, suffix: '秒' },
  { limit: 45 * 60, divisor: 60, suffix: '分钟' },
  { limit: 22 * 3600, divisor: 3600, suffix: '小时' },
  { limit: 26 * 86400, divisor: 86400, suffix: '天' },
  { limit: 320 * 86400, divisor: 30 * 86400, suffix: '个月' },
]

/** "3 分钟前" — pair it with a title carrying the absolute timestamp. */
export function formatRelative(value, fallback = '-') {
  const date = parseDate(value)
  if (!date) return fallback

  const seconds = (Date.now() - date.getTime()) / 1000
  const abs = Math.abs(seconds)
  const ahead = seconds < 0

  if (abs < 5) return '刚刚'

  for (const step of RELATIVE_STEPS) {
    if (abs < step.limit) {
      const amount = Math.max(1, Math.round(abs / step.divisor))
      return ahead ? `${amount} ${step.suffix}后` : `${amount} ${step.suffix}前`
    }
  }

  const years = Math.max(1, Math.round(abs / (365 * 86400)))
  return ahead ? `${years} 年后` : `${years} 年前`
}

/** "4 MiB" — binary units, matching how the capture limit is configured. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`
}

export const STATUS = { ENABLED: 1, DISABLED: 2 }

export function formatDuration(ms) {
  if (ms <= 0) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** Splits a textarea into a trimmed, de-duplicated list. */
export const parseList = (text) =>
  Array.from(
    new Set(
      text
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )

/**
 * Parses pasted HTTP headers into a name/value object.
 *
 * A header name cannot contain a colon, so the first one is the separator and
 * everything after it belongs to the value — verbatim. That is the whole
 * point: bearer tokens, base64 padding and cookies are full of "=" and ":",
 * and a generic "from=to" parser splits those in the wrong place.
 *
 * Falls back to "=" on a line that has no colon, so pairs saved before this
 * field spoke HTTP still load and still save.
 */
export function parseHeaders(text) {
  const headers = {}
  text
    .split('\n')
    // Lets a line lifted straight out of a curl command work as-is. The
    // quotes are only stripped when they wrap the whole line, so a quoted
    // value like X-Foo: "bar" keeps its own.
    .map((line) => line.trim().replace(/^-H\s+/i, '').trim())
    .map((line) =>
      (line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))
        ? line.slice(1, -1).trim()
        : line,
    )
    .filter(Boolean)
    .forEach((line) => {
      const index = line.includes(':') ? line.indexOf(':') : line.indexOf('=')
      if (index <= 0) return
      const name = line.slice(0, index).trim()
      const value = line.slice(index + 1).trim()
      if (name && value) headers[name] = value
    })
  return headers
}

/** Renders headers the way they travel, so they can be copied back out. */
export const stringifyHeaders = (headers) =>
  Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

/**
 * Parses thinking-level rules, one per line:
 *
 *   *:max=xhigh
 *   gpt-5.1:max=high
 *   gpt-oss:120b:max=high
 *
 * The selector ends at the last colon *before* the "=", not the first one:
 * model names carry colons themselves (gpt-oss:120b), and splitting on the
 * first would cut such a name in half. A line with no selector is read as
 * "*", so an old configuration pasted straight back in works.
 */
export function parseEffortRules(text) {
  const rules = {}
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const equals = line.indexOf('=')
      if (equals <= 0) return

      const split = line.lastIndexOf(':', equals)
      const selector = split >= 0 ? line.slice(0, split).trim() || '*' : '*'
      const rest = split >= 0 ? line.slice(split + 1) : line

      const index = rest.indexOf('=')
      if (index <= 0) return
      const from = rest.slice(0, index).trim()
      const to = rest.slice(index + 1).trim()
      if (!from || !to) return
      rules[selector] = { ...(rules[selector] ?? {}), [from]: to }
    })
  return rules
}

/** Renders the rules back out, wildcard first so the general case reads first. */
export const stringifyEffortRules = (rules) =>
  Object.entries(rules ?? {})
    .filter(([, levels]) => levels && Object.keys(levels).length > 0)
    .sort(([a], [b]) => {
      if (a === '*') return -1
      if (b === '*') return 1
      return a.localeCompare(b)
    })
    .flatMap(([selector, levels]) =>
      Object.entries(levels).map(([from, to]) => `${selector}:${from}=${to}`),
    )
    .join('\n')

/**
 * Parses "from=to" lines into the model mapping object.
 *
 * "=" wins over ":" here, the opposite of parseHeaders: a model name may
 * itself contain a colon (qwen:7b=qwen2:7b), and splitting on that would cut
 * the name in half.
 */
export function parseMapping(text) {
  const mapping = {}
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

export const stringifyMapping = (mapping) =>
  Object.entries(mapping ?? {})
    .map(([from, to]) => `${from}=${to}`)
    .join('\n')
