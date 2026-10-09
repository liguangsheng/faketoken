import type { ConsoleSettings } from '../../../api/types'

/**
 * Everything the tab panels share: the bounds the server enforces, the option
 * lists, and the counting rules the blocklist editor reports against.
 *
 * The panels are dumb by design — they render fields out of one draft and hand
 * every change back up. Splitting state out of them would mean two places to
 * look when a setting fails to save.
 */

/** A panel edits one draft and reports every change straight back up. */
export interface PanelProps {
  draft: ConsoleSettings
  patch: (patch: Partial<ConsoleSettings>) => void
}

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
  { value: 64 * MIB, label: '64 MiB' },
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

export const byteLength = (text: string) => new TextEncoder().encode(text).length

export const nonEmpty = (lines: string[]) => lines.filter((line) => line.trim() !== '').length

/**
 * How many keywords each group will actually keep, mirroring
 * relay.NormalizeBlockRules: trimmed, deduplicated within the group, oversized
 * ones dropped, and the whole set bounded by one shared budget.
 *
 * Reimplemented here rather than guessed at, so the count the operator reads
 * is the count the relay will match on.
 *
 * One difference, currently unreachable: the server's cap counts groups it
 * *keeps*, having already dropped the wholly empty ones, while the slice below
 * counts input positions. They agree only because the editor refuses to add a
 * 21st group, so the list never exceeds the cap in the first place. Lift that
 * limit and the budget would have to be spent the way the server spends it.
 */
export const keptPerRule = (rules: ConsoleSettings['block_rules']) => {
  let budget = MAX_KEYWORDS
  return rules.slice(0, MAX_RULES).map((rule) => {
    const seen = new Set<string>()
    for (const raw of rule.keywords) {
      if (budget <= 0) break
      const word = raw.trim()
      if (!word || byteLength(word) > MAX_KEYWORD_BYTES) continue
      const folded = word.toLowerCase()
      if (seen.has(folded)) continue
      seen.add(folded)
      budget--
    }
    return seen.size
  })
}

/** What the blocklist tab reports, and what the shell blocks a save on. */
export interface BlocklistStats {
  /** Keywords that will match, counting enabled groups only. */
  activeKeywords: number
  /** Non-empty keyword lines the relay will discard. */
  droppedLines: number
  /** Replies over the byte cap; the server rejects a save carrying one. */
  oversizedReplies: number
  /** Whether any group answers with a 2xx, which some endpoints cannot. */
  anyMasked: boolean
}

export const blocklistStats = (settings: ConsoleSettings): BlocklistStats => {
  const rules = settings.block_rules
  const kept = keptPerRule(rules)
  return {
    activeKeywords: rules.reduce(
      (total, rule, index) => total + (rule.enabled ? kept[index] : 0),
      0,
    ),
    droppedLines:
      rules.reduce((total, rule) => total + nonEmpty(rule.keywords), 0) -
      kept.reduce((total, count) => total + count, 0),
    oversizedReplies: rules.reduce(
      (total, rule) =>
        total + rule.replies.filter((reply) => byteLength(reply) > MAX_REPLY_BYTES).length,
      0,
    ),
    // Endpoints that cannot carry prose refuse with a 401 whatever is
    // configured, which is worth saying wherever a 2xx is in play.
    anyMasked: rules.some((rule) => (rule.status || settings.blocked_status) < 400),
  }
}
