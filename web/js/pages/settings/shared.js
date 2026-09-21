/**
 * Everything the settings tabs share: the bounds the server enforces, the
 * option lists, and the counting rules the blocklist editor reports against.
 */

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

const MIB = 1024 * 1024
export const BODY_LIMIT_OPTIONS = [
  { value: 256 * 1024, label: '256 KiB' },
  { value: 1 * MIB, label: '1 MiB' },
  { value: 2 * MIB, label: '2 MiB' },
  { value: 4 * MIB, label: '4 MiB（默认，约 1M 上下文）' },
  { value: 8 * MIB, label: '8 MiB' },
  { value: 16 * MIB, label: '16 MiB' },
  { value: 32 * MIB, label: '32 MiB' },
]

// Mirrors the bounds in internal/relay/blocklist.go. The keyword budget is a
// total across every group, not a per-group allowance.
export const MAX_RULES = 20
export const MAX_KEYWORDS = 200
export const MAX_KEYWORD_BYTES = 200
export const MAX_REPLIES = 20
export const MAX_REPLY_BYTES = 8 * 1024
export const MAX_RULE_NAME = 40

export const STATUS_OPTIONS = [
  { value: 200, label: '200 — 伪装成正常回复' },
  { value: 400, label: '400 — 请求无效' },
  { value: 403, label: '403 — 拒绝访问' },
  { value: 429, label: '429 — 频率限制' },
  { value: 451, label: '451 — 因法律原因不可用' },
]

export const byteLength = (text) => new TextEncoder().encode(text).length

export const nonEmpty = (lines) => lines.filter((line) => line.trim() !== '').length

/**
 * How many keywords each group will actually keep, mirroring
 * relay.NormalizeBlockRules: trimmed, deduplicated within the group, oversized
 * ones dropped, and the whole set bounded by one shared budget.
 *
 * Reimplemented here rather than guessed at, so the count the operator reads
 * is the count the relay will match on.
 */
export function keptPerRule(rules) {
  let budget = MAX_KEYWORDS
  return rules.slice(0, MAX_RULES).map((rule) => {
    const seen = new Set()
    for (const raw of rule.keywords) {
      if (budget <= 0) break
      const word = raw.trim()
      if (!word || byteLength(word) > MAX_KEYWORD_BYTES) continue
      const folded = word.toLowerCase()
      if (seen.has(folded)) continue
      seen.add(folded)
      budget -= 1
    }
    return seen.size
  })
}

/** What the blocklist tab reports, and what the page blocks a save on. */
export function blocklistStats(settings) {
  const rules = settings.block_rules ?? []
  const kept = keptPerRule(rules)
  const sum = (list) => list.reduce((total, value) => total + value, 0)

  return {
    /** Keywords that will match, counting enabled groups only. */
    activeKeywords: sum(rules.map((rule, index) => (rule.enabled ? kept[index] : 0))),
    /** Non-empty keyword lines the relay will discard. */
    droppedLines: sum(rules.map((rule) => nonEmpty(rule.keywords))) - sum(kept),
    /** Replies over the byte cap; the server rejects a save carrying one. */
    oversizedReplies: sum(
      rules.map((rule) => rule.replies.filter((reply) => byteLength(reply) > MAX_REPLY_BYTES).length),
    ),
    // Endpoints that cannot carry prose refuse with a 401 whatever is
    // configured, which is worth saying wherever a 2xx is in play.
    anyMasked: rules.some((rule) => (rule.status || settings.blocked_status) < 400),
  }
}

/** block_rules is the only non-primitive, so one deep compare covers it. */
export function fieldChanged(a, b, field) {
  if (field === 'block_rules') return JSON.stringify(a.block_rules) !== JSON.stringify(b.block_rules)
  return a[field] !== b[field]
}
