/**
 * What the channel page and its dialogs share: the bounds the server
 * enforces, the option lists, and how a channel's state reads.
 */

import { STATUS } from '../../core/format.js'

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
]

export const protocolLabel = (value) =>
  TEST_PROTOCOLS.find((item) => item.value === value)?.label ?? value

// Wide enough not to get in the way, bounded so the value still fits the
// int32 columns it lands in. The weight floor is 1 because selection treats
// weight as a share of the draw, so a zero would take the channel out of
// rotation without it ever showing as disabled — the server clamps it for the
// same reason.
export const MIN_PRIORITY = -1_000_000
export const MAX_PRIORITY = 1_000_000
export const MIN_WEIGHT = 1
export const MAX_WEIGHT = 1_000_000

/**
 * The picker's row list: what upstream just returned, plus anything the
 * channel already serves that upstream did not offer. Without the second half
 * a configured model that has since disappeared upstream would be invisible
 * here while still counted as selected — "已选 3 / 共 2" and no way to see which.
 */
export function withConfigured(upstream, configured) {
  const known = new Set(upstream)
  return [...upstream, ...configured.filter((model) => !known.has(model))]
}

/**
 * What the keepalive state reads as in the table. A channel whose status
 * flips on its own needs to say why, or the next operator to look assumes a
 * colleague did it.
 */
export function keepaliveTag(channel) {
  if (!channel.keepalive_enabled) return null
  if (channel.keepalive_open) {
    return {
      tone: 'success',
      text: `保活 ${channel.keepalive_success}/${channel.keepalive_target}`,
      hint: `保活窗口进行中：已成功 ${channel.keepalive_success} 次，满 ${channel.keepalive_target} 次后自动禁用`,
    }
  }
  return {
    tone: null,
    text: `保活 ${channel.keepalive_at}`,
    hint: `每天 ${channel.keepalive_at}（服务器时区）起，若渠道处于禁用状态则自动启用，成功 ${channel.keepalive_target} 次后自动禁用；到点时本来就是启用状态则不接管`,
  }
}

export function statusHint(channel) {
  if (channel.status === STATUS.ENABLED) return '已启用，点击停止向该渠道转发'
  return '已禁用，点击恢复转发'
}

/** A model list too long for a title: the first twenty, then a count. */
export function modelsSummary(list) {
  if (list.length === 0) return '未配置，仅按前缀匹配'
  if (list.length > 20) return `${list.slice(0, 20).join('、')} …等 ${list.length} 个，展开行查看全部`
  return list.join('、')
}
