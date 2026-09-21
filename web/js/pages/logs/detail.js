/**
 * The detail drawer: what one call was, and — on the administrator surface —
 * what it carried.
 *
 * The bodies are held for a limited number of recent calls, so "not here" is
 * a normal outcome and is spelled out rather than shown as an empty panel.
 */

import { el, replace } from '../../driver/dom.js'
import { copyText } from '../../driver/clipboard.js'
import { api } from '../../core/api.js'
import { parseRequestConversation, parseResponseConversation } from '../../core/conversation.js'
import { get as consoleSettings } from '../../core/settings.js'
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
  formatUSD,
} from '../../core/format.js'
import { banner, button, segmented, tag } from '../../ui/controls.js'
import { skeleton } from '../../ui/feedback.js'
import { openModal } from '../../ui/modal.js'
import { tabs } from '../../ui/tabs.js'
import { ICONS } from '../../ui/icons.js'
import { toast } from '../../ui/toast.js'
import { REASONING_TONE, cacheRate, rowTone } from './tone.js'

// Standard reason phrases for the status codes a relay realistically returns.
// Anything unlisted simply omits the phrase, which is valid HTTP.
const REASON_PHRASE = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  499: 'Client Closed Request',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

const PART_LABEL = {
  text: '',
  reasoning: '思考',
  tool_call: '调用工具',
  tool_result: '工具结果',
  image: '附件',
  other: '其他',
}

// Long system prompts dominate a transcript, so anything past this is folded
// away behind a toggle. Generous enough that ordinary turns are never clipped.
const PART_CLAMP = 1600

/** Opens the drawer for one settled row. */
export function openLogDetail(entry, { admin }) {
  const title = el('span', { class: 'row', style: { gap: '8px' } }, [
    `调用详情 #${entry.id}`,
    tag(String(entry.status_code), rowTone(entry)),
  ])

  if (!admin) {
    const dialog = openModal({
      title,
      width: 560,
      body: metaView(entry, { admin }),
      footer: (close) => [button({ label: '关闭', onClick: close })],
    })
    dialog.dialog.classList.add('modal--drawer')
    return
  }

  // Only the administrator surface serves the bodies; they are fetched when
  // the drawer opens and may legitimately be gone.
  let bodies = null
  let bodiesState = 'loading'
  const panel = el('div')

  const paintPanel = (key) => {
    if (key === 'meta') replace(panel, metaView(entry, { admin }))
    else replace(panel, bodyView(key, { entry, bodies, state: bodiesState }))
  }

  const strip = tabs({
    items: [
      { key: 'meta', label: '概览' },
      { key: 'request', label: '请求正文' },
      { key: 'response', label: '响应正文' },
    ],
    value: 'meta',
    ariaLabel: '详情分组',
    onChange: paintPanel,
  })
  paintPanel('meta')

  api.admin
    .logDetail(entry.id)
    .then((result) => {
      bodies = result
      bodiesState = 'idle'
    })
    .catch((error) => {
      // 410 is the ordinary outcome for anything past the window, so it is
      // reported as a state rather than as an error.
      const gone = error instanceof Error && error.message.includes('保留范围')
      bodiesState = gone ? 'expired' : 'failed'
    })
    .finally(() => {
      if (strip.value() !== 'meta') paintPanel(strip.value())
    })

  const dialog = openModal({
    title,
    // Wider than the metadata alone needs: request bodies are the reason
    // this drawer is opened, and they read badly in a narrow column.
    width: 860,
    body: [strip, el('div', { style: { marginTop: '16px' } }, panel)],
    footer: (close) => [button({ label: '关闭', onClick: close })],
  })
  dialog.dialog.classList.add('modal--drawer', 'modal--wide')
}

// ---- metadata -----------------------------------------------------------

/** The metadata a log row already carries; no fetch needed. */
function metaView(detail, { admin }) {
  const muted = (text) => el('span', { class: 'text-muted' }, text)
  const mono = (text) => el('span', { class: 'mono' }, text)

  const rows = [
    ['ID', mono(String(detail.id))],
    ['时间', formatTime(detail.created_at)],
  ]
  if (admin) rows.push(['用户', detail.username])
  rows.push(['密钥', detail.token_name || '-'], ['接口', mono(detail.endpoint)], ['请求模型', mono(detail.model)])

  if (!admin || (detail.upstream_model && detail.upstream_model !== detail.model)) {
    rows.push(['上游模型', mono(detail.upstream_model || detail.model)])
  }

  const channel = el('span', { class: 'row', style: { gap: '6px' } }, [
    detail.channel_id > 0
      ? [Object.assign(tag(`#${detail.channel_id}`), { className: 'tag mono' }), detail.channel_name || '（已删除）']
      : '-',
    detail.retries > 0 && tag(`重试 ${detail.retries} 次`, 'warning'),
  ])
  rows.push(['渠道', channel])

  rows.push([
    '状态码',
    el('span', { class: 'row', style: { gap: '6px' } }, [
      tag(String(detail.status_code), rowTone(detail)),
      detail.stream ? tag('流式', 'brand') : tag('非流式'),
    ]),
  ])

  if (!admin || detail.reasoning_effort) {
    rows.push([
      '思考强度',
      detail.reasoning_effort
        ? tag(detail.reasoning_effort, REASONING_TONE[detail.reasoning_effort] ?? null)
        : muted('未指定'),
    ])
  }

  rows.push(
    ['客户端', detail.client_type && detail.client_type !== 'unknown' ? tag(detail.client_type) : muted('未识别')],
    [
      '来源 IP',
      detail.client_ip
        ? Object.assign(mono(detail.client_ip), {
            title: '来自 X-Forwarded-For；直连本服务的调用方可以自行设置该头，仅供参考',
          })
        : muted('-'),
    ],
    [
      'Token 用量',
      `输入 ${formatNumber(detail.prompt_tokens)} · 输出 ${formatNumber(detail.completion_tokens)} · 合计 ${formatNumber(detail.total_tokens || detail.prompt_tokens + detail.completion_tokens)}`,
    ],
    ['缓存命中', el('span', {}, [formatNumber(detail.cached_tokens), muted(` / ${formatNumber(detail.prompt_tokens)} 输入`)])],
    [
      '缓存率',
      Object.assign(el('span', {}, formatPercent(cacheRate(detail))), {
        title: '缓存命中的输入 token 占全部输入的比例；命中部分按缓存价计费',
      }),
    ],
    [
      '缓存创建',
      Object.assign(el('span', {}, formatNumber(detail.cache_creation_tokens)), {
        title: '写入缓存的输入 token，已计入输入总数；上游通常按高于普通输入的价格计费',
      }),
    ],
    ['费用', formatUSD(detail.cost, 6)],
    [
      '耗时',
      `总计 ${formatDuration(detail.duration_ms)}${detail.ttfb_ms > 0 ? ` · 首字节 ${formatDuration(detail.ttfb_ms)}` : ''}`,
    ],
    [
      '错误',
      detail.error
        ? el('span', { class: 'row', style: { alignItems: 'flex-start', gap: '6px' } }, [
            el('span', { class: 'text-danger', style: { whiteSpace: 'pre-wrap', flex: '1' } }, detail.error),
            button({
              variant: 'icon',
              glyph: ICONS.copy,
              ariaLabel: '复制错误',
              onClick: async () => {
                if (await copyText(detail.error)) toast.success('已复制')
              },
            }),
          ])
        : muted('无'),
    ],
  )

  return el('dl', { class: 'desc' }, rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]))
}

// ---- bodies -------------------------------------------------------------

/**
 * Renders one side of the call as it would appear on the wire: start line,
 * folded headers, blank line, body. Reading a relayed call means comparing it
 * against the upstream's own docs and curl output, and both speak raw HTTP.
 */
function httpMessage(kind, entry, headers, body) {
  let startLine
  if (kind === 'request') {
    startLine = `${entry.method || 'POST'} ${entry.endpoint || '/'} HTTP/1.1`
  } else {
    const phrase = REASON_PHRASE[entry.status_code]
    startLine = `HTTP/1.1 ${entry.status_code}${phrase ? ` ${phrase}` : ''}`
  }

  // Repeated headers stay on separate lines, which is how they travel.
  const lines = Object.entries(headers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, values]) => values.map((value) => `${name}: ${value}`))

  return `${[startLine, ...lines].join('\n')}\n\n${body ?? ''}`
}

function bodyView(kind, { entry, bodies, state }) {
  const settings = consoleSettings()

  if (state === 'loading') return skeleton(6)
  if (state === 'expired') {
    return banner({
      title: '这次调用的正文已不再保留',
      description: `只保留最近 ${formatNumber(settings.log_detail_keep)} 次调用的完整正文，这条已经滚出该范围。可在「全局设置 → 日志留存」调整条数。`,
    })
  }
  if (state === 'failed') return banner({ type: 'warning', title: '加载正文失败' })
  if (!bodies) {
    return banner({
      title: '未记录正文',
      description: '完整日志当前处于关闭状态，可在「全局设置 → 日志留存」开启。',
    })
  }

  const request = kind === 'request'
  const headers = request ? bodies.request_headers : bodies.response_headers
  const body = request ? bodies.request_body : bodies.response_body
  const truncated = request ? bodies.request_truncated : bodies.response_truncated
  const httpText = httpMessage(kind, entry, headers, body)
  const turns = request ? parseRequestConversation(body) : parseResponseConversation(body)

  // Non-chat calls (embeddings, audio, …) have nothing to show in the chat
  // view; land them on the raw message instead of an apology.
  let view = turns ? 'chat' : 'raw'
  const content = el('div')
  const caption = el('span', { class: 'text-muted text-small' })
  const copyButton = button({
    label: '复制报文',
    glyph: ICONS.copy,
    onClick: async () => {
      if (await copyText(httpText)) toast.success('已复制报文')
      else toast.warning('浏览器拒绝了剪贴板访问，请手动选中复制')
    },
  })

  const paint = () => {
    if (view === 'raw') {
      caption.textContent = `敏感头已脱敏${turns ? '' : ' · 该正文不是可识别的对话'}`
      copyButton.style.display = ''
      replace(content, el('pre', { class: 'code-block' }, httpText))
    } else {
      caption.textContent = `${turns?.length ?? 0} 条消息${truncated ? '（正文被截断，可能不完整）' : ''}`
      copyButton.style.display = 'none'
      replace(content, conversationView(turns ?? []))
    }
  }

  const switcher = segmented({
    value: view,
    options: [
      { value: 'raw', label: '报文' },
      { value: 'chat', label: '会话' },
    ],
    onChange: (next) => {
      // The chat tab is inert for a body that is not a conversation.
      if (next === 'chat' && !turns) {
        switcher.setValue('raw')
        return
      }
      view = next
      paint()
    },
  })
  paint()

  return el('div', { class: 'stack', style: { gap: '12px' } }, [
    truncated &&
      banner({
        type: 'warning',
        title: `正文超过 ${formatBytes(settings.log_body_limit)}，已截断或省略`,
        description: '上限可在「全局设置 → 日志留存」调整。',
      }),
    el('div', { class: 'row row--wrap' }, [switcher, caption, copyButton]),
    content,
  ])
}

function conversationView(turns) {
  return el(
    'div',
    { class: 'chat-log' },
    turns.map((turn) =>
      el('div', { class: `chat-turn chat-turn--${turn.role}` }, [
        el('div', { class: 'chat-turn__role' }, turn.role),
        el('div', { class: 'chat-turn__parts' }, turn.parts.map(chatPart)),
      ]),
    ),
  )
}

function chatPart(part) {
  const long = part.text.length > PART_CLAMP
  let expanded = false
  const label = PART_LABEL[part.kind] ?? ''

  const text = el('pre', { class: 'chat-part__text' })
  const more = long
    ? button({
        variant: 'link',
        onClick: () => {
          expanded = !expanded
          paint()
        },
      })
    : null

  const paint = () => {
    text.textContent = long && !expanded ? part.text.slice(0, PART_CLAMP) : part.text
    if (more) {
      replace(more, el('span', {}, expanded ? '收起' : `展开剩余 ${formatNumber(part.text.length - PART_CLAMP)} 字`))
    }
  }
  paint()

  return el('div', { class: `chat-part chat-part--${part.kind}` }, [
    (label || part.name) &&
      el('div', { class: 'chat-part__label' }, [label, part.name && el('span', { class: 'mono' }, ` ${part.name}`)]),
    text,
    more,
  ])
}
