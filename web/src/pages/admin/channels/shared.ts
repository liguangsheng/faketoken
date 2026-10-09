import type { Channel } from '../../../api/types'
import { STATUS } from '../../../utils/format'

export const AUTH_STYLES = [
  { value: 'auto', label: '自动（按请求端点）' },
  { value: 'bearer', label: 'Authorization: Bearer' },
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'x-goog-api-key', label: 'X-Goog-Api-Key' },
]

export const TEST_PROTOCOLS = [
  { value: 'responses', label: 'Responses' },
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'messages', label: 'Messages' },
] as const

export type TestProtocol = (typeof TEST_PROTOCOLS)[number]['value']

/**
 * The protocol a probe should default to for a model name. Before the request
 * goes out the name is the only signal there is: gpt-* answers the Responses
 * dialect, claude-* the Messages one, and everything else the OpenAI-compatible
 * chat completions that every gateway speaks.
 */
export function protocolForModel(model: string): TestProtocol {
  const name = model.toLowerCase()
  if (name.includes('gpt')) return 'responses'
  if (name.includes('claude')) return 'messages'
  return 'chat_completions'
}

// Wide enough not to get in the way, bounded so the value still fits the int32
// columns it lands in. The weight floor is 1 because selection treats weight as
// a share of the draw, so a zero would take the channel out of rotation without
// it ever showing as disabled — the server clamps it for the same reason.
export const MIN_PRIORITY = -1_000_000
export const MAX_PRIORITY = 1_000_000
export const MIN_WEIGHT = 1
export const MAX_WEIGHT = 1_000_000

/**
 * The picker's row list: what upstream just returned, plus anything the channel
 * already serves that upstream did not offer. Without the second half a
 * configured model that has since disappeared upstream would be invisible here
 * while still counted as selected — "已选 3 / 共 2" and no way to see which.
 */
export function withConfigured(upstream: string[], configured: string[]): string[] {
  const known = new Set(upstream)
  return [...upstream, ...configured.filter((model) => !known.has(model))]
}

/**
 * What the keepalive state reads as in the table. A channel whose status flips
 * on its own needs to say why, or the next operator to look assumes a colleague
 * did it.
 */
export function keepaliveTag(channel: Channel) {
  if (!channel.keepalive_enabled) return null
  if (channel.keepalive_open) {
    return {
      color: 'green',
      text: `保活 ${channel.keepalive_success}/${channel.keepalive_target}`,
      hint: `保活窗口进行中：已成功 ${channel.keepalive_success} 次，满 ${channel.keepalive_target} 次后自动禁用`,
    }
  }
  return {
    color: undefined,
    text: `保活 ${channel.keepalive_at}`,
    hint: `每天 ${channel.keepalive_at}（服务器时区）起，若渠道处于禁用状态则自动启用，成功 ${channel.keepalive_target} 次后自动禁用；到点时本来就是启用状态则不接管`,
  }
}

export function statusHint(channel: Channel) {
  if (channel.status === STATUS.ENABLED) return '已启用，点击停止向该渠道转发'
  return '已禁用，点击恢复转发'
}
