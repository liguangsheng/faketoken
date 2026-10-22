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
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`
  return `${(value / 1_000_000_000).toFixed(abs < 10_000_000_000 ? 1 : 0)}B`
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

/** "863 ms" · "12.5 s" — tenths are enough; hundredths are noise at these lengths. */
export const formatDuration = (ms: number) => {
  if (ms <= 0) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
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

/**
 * Parses pasted HTTP headers into a name/value object.
 *
 * A header name cannot contain a colon, so the first one is the separator and
 * everything after it belongs to the value — verbatim. That is the whole point:
 * bearer tokens, base64 padding and cookies are full of "=" and ":", and the
 * generic "from=to" parser splits those in the wrong place.
 *
 * Falls back to "=" on a line that has no colon, so pairs saved before this
 * field spoke HTTP still load and still save.
 */
export const parseHeaders = (text: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  text
    .split('\n')
    // Lets a line lifted straight out of a curl command work as-is. The quotes
    // are only stripped when they wrap the whole line, so a quoted value like
    // X-Foo: "bar" keeps its own.
    .map((line) => line.trim().replace(/^-H\s+/i, '').trim())
    .map((line) =>
      (line.startsWith('"') && line.endsWith('"')) ||
      (line.startsWith("'") && line.endsWith("'"))
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
export const stringifyHeaders = (headers: Record<string, string> | null | undefined) =>
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
 * Every line carries its own selector, so a line means the same thing wherever
 * it sits. Grouping the rules under a heading instead would make each line
 * depend on the one above it, and reordering or deleting a heading would
 * silently reassign the rules under it.
 *
 * The selector ends at the last colon *before* the "=", not the first one:
 * model names carry colons themselves (gpt-oss:120b), and splitting on the
 * first would cut such a name in half. Level names never contain a colon, so
 * everything after that point belongs to the rename.
 *
 * A line with no selector is read as "*", which is what the field meant before
 * it had selectors — so an old configuration pasted straight back in works.
 */
export const parseEffortRules = (text: string): Record<string, Record<string, string>> => {
  const rules: Record<string, Record<string, string>> = {}

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
export const stringifyEffortRules = (
  rules: Record<string, Record<string, string>> | null | undefined,
) =>
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
 * "=" wins over ":" here, the opposite of parseHeaders: a model name may itself
 * contain a colon (qwen:7b=qwen2:7b), and splitting on that would cut the name
 * in half.
 */
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

// "429=503" or "429:503". Both sides are three digits; the range is checked
// separately so the error can say which rule is out of it.
const STATUS_RULE = /^(\d{3})\s*[=:]\s*(\d{3})$/

const isErrorStatus = (code: number) => code >= 400 && code <= 599

/**
 * Checks status-mapping text line by line. Returns the first bad line, or
 * undefined when every line is a rule between two error codes. A typo must be
 * reported, not dropped: a silently skipped rule just stops working.
 */
export const invalidStatusRule = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => {
      const match = STATUS_RULE.exec(line)
      return !match || !isErrorStatus(Number(match[1])) || !isErrorStatus(Number(match[2]))
    })

/** Parses "429=503" lines into the status rewrite map. Lines that do not parse are skipped. */
export const parseStatusMapping = (text: string): Record<string, number> => {
  const mapping: Record<string, number> = {}
  text
    .split('\n')
    .map((line) => line.trim())
    .forEach((line) => {
      const match = STATUS_RULE.exec(line)
      if (match) mapping[match[1]] = Number(match[2])
    })
  return mapping
}

/** Lowest code first: integer keys enumerate in ascending order on their own. */
export const stringifyStatusMapping = (mapping: Record<string, number> | null | undefined) =>
  Object.entries(mapping ?? {})
    .map(([from, to]) => `${from}=${to}`)
    .join('\n')

export const stringifyMapping = (mapping: Record<string, string> | null | undefined) =>
  Object.entries(mapping ?? {})
    .map(([from, to]) => `${from}=${to}`)
    .join('\n')
