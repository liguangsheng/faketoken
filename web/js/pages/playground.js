/**
 * The playground: one real request, watched as it streams in.
 *
 * Everything here goes through the relay for real — routing, billing, the
 * log. That is the point: a probe from the channel page proves an upstream
 * answers, but only a call made the way a client makes it proves the whole
 * path. The page can also aim at another deployment, which turns it into a
 * generic smoke test for any OpenAI-compatible endpoint.
 */

import { el, icon, replace, watchMedia } from '../driver/dom.js'
import { copyText } from '../driver/clipboard.js'
import { session } from '../driver/http.js'
import { api } from '../core/api.js'
import * as router from '../core/router.js'
import * as sessionStore from '../core/session.js'
import { formatDuration, formatNumber } from '../core/format.js'
import { banner, button, card, input, pageHeader, select, textarea, toggle } from '../ui/controls.js'
import { dropdown, menuItem } from '../ui/dropdown.js'
import { emptyState } from '../ui/feedback.js'
import { confirmModal } from '../ui/modal.js'
import { ICONS } from '../ui/icons.js'
import { toast } from '../ui/toast.js'

const HOST_STORAGE = 'faketoken-playground-host'
const PROTOCOL_STORAGE = 'faketoken-playground-protocol'
const PROXY_STORAGE = 'faketoken-playground-proxy'
const PROXY_PATH = '/api/admin/playground/relay'
const KEYS_STORAGE = 'faketoken-playground-keys'
const REMEMBER_STORAGE = 'faketoken-playground-remember'
const MAX_REMEMBERED = 5

const DEBOUNCE_MS = 300
// userAgentData is the current API; platform is what older browsers still have.
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')
/** How close to the bottom (px) still counts as "following the stream". */
const FOLLOW_SLACK = 48

const readKeys = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_STORAGE) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const maskKey = (key) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key)

/** Addresses a browser reaches over plain HTTP rather than TLS. */
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.)/i

/**
 * Turns what was typed into the prefix a request hangs off: `''` for this
 * site, `null` when it cannot be read as an address. A bare `host:port` gets
 * a scheme, and a trailing `/v1` is dropped so a base URL copied from a
 * provider — or from this console's own quick-import field — can be pasted
 * as-is.
 */
function normalizeHost(raw) {
  const text = raw.trim()
  if (!text) return ''
  let withScheme = text
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    withScheme = `${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`
  }
  try {
    const url = new URL(withScheme)
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')}`
  } catch {
    return null
  }
}

// ---- reply shapes -----------------------------------------------------------

const isDict = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Walks a path of keys, giving up quietly on anything unexpected. Own
 * properties only: a reply is untrusted JSON, and reading through the
 * prototype would let `constructor` or `__proto__` in a payload answer.
 */
const dig = (value, ...path) => {
  let current = value
  for (const key of path) {
    if (!isDict(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

const asArray = (value) => (Array.isArray(value) ? value : [])
const asText = (value) => (typeof value === 'string' ? value : '')
const asCount = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const usageFrom = (value, promptKey, completionKey) => {
  if (!isDict(value)) return null
  const prompt = asCount(value[promptKey])
  const completion = asCount(value[completionKey])
  if (prompt === undefined && completion === undefined) return null
  const usage = {}
  if (prompt !== undefined) usage.prompt_tokens = prompt
  if (completion !== undefined) usage.completion_tokens = completion
  return usage
}

const openAIUsage = (value) => usageFrom(value, 'prompt_tokens', 'completion_tokens')
/** Both native dialects count as input/output rather than prompt/completion. */
const nativeUsage = (value) => usageFrom(value, 'input_tokens', 'output_tokens')

/**
 * Folds in what a frame reported without letting it erase what it did not
 * mention: Anthropic sends the input count on the opening frame and the
 * output count on the closing one, so a plain overwrite would lose half.
 */
function mergeUsage(base, next) {
  if (!next) return base
  const merged = { ...(base ?? {}) }
  if (next.prompt_tokens !== undefined) merged.prompt_tokens = next.prompt_tokens
  if (next.completion_tokens !== undefined) merged.completion_tokens = next.completion_tokens
  return merged
}

/** Anthropic rejects a request without it; a smoke test never needs more. */
const MESSAGES_MAX_TOKENS = 4096

const PROTOCOLS = {
  chat_completions: {
    label: 'Chat Completions',
    path: '/v1/chat/completions',
    body: ({ model, system, prompt, stream }) => {
      const body = {
        model,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
        stream,
      }
      if (stream) body.stream_options = { include_usage: true }
      return body
    },
    text: (payload) => asText(dig(asArray(dig(payload, 'choices'))[0], 'message', 'content')),
    usage: (payload) => openAIUsage(dig(payload, 'usage')),
    event: (chunk) => ({
      delta: asText(dig(asArray(dig(chunk, 'choices'))[0], 'delta', 'content')),
      usage: openAIUsage(dig(chunk, 'usage')),
    }),
  },
  messages: {
    label: 'Messages',
    path: '/v1/messages',
    // Upstream Anthropic refuses a request without it, and the relay only
    // forwards what the client sent.
    headers: { 'Anthropic-Version': '2023-06-01' },
    body: ({ model, system, prompt, stream }) => {
      const body = { model, max_tokens: MESSAGES_MAX_TOKENS, messages: [{ role: 'user', content: prompt }], stream }
      if (system) body.system = system
      return body
    },
    text: (payload) =>
      asArray(dig(payload, 'content'))
        .map((block) => asText(dig(block, 'text')))
        .join(''),
    usage: (payload) => nativeUsage(dig(payload, 'usage')),
    event: (chunk) => ({
      // Tool arguments and thinking arrive as deltas of their own; only the
      // text ones belong in the answer pane.
      delta: asText(dig(chunk, 'type')) === 'content_block_delta' ? asText(dig(chunk, 'delta', 'text')) : '',
      usage: nativeUsage(dig(chunk, 'usage')) ?? nativeUsage(dig(chunk, 'message', 'usage')),
    }),
  },
  responses: {
    label: 'Responses',
    path: '/v1/responses',
    body: ({ model, system, prompt, stream }) => {
      const body = { model, input: prompt, stream }
      if (system) body.instructions = system
      return body
    },
    // Reasoning items carry no `content`, so flattening skips them on its own.
    text: (payload) =>
      asArray(dig(payload, 'output'))
        .flatMap((item) => asArray(dig(item, 'content')))
        .map((part) => asText(dig(part, 'text')))
        .join(''),
    usage: (payload) => nativeUsage(dig(payload, 'usage')),
    event: (chunk) => ({
      delta: asText(dig(chunk, 'type')) === 'response.output_text.delta' ? asText(dig(chunk, 'delta')) : '',
      usage: nativeUsage(dig(chunk, 'usage')) ?? nativeUsage(dig(chunk, 'response', 'usage')),
    }),
  },
}

const PROTOCOL_ORDER = ['chat_completions', 'messages', 'responses']

/**
 * One call to the target: straight from the browser, or handed to this
 * server to make on the page's behalf.
 *
 * The direct call is preceded by a CORS preflight, which a gateway that
 * leaves OPTIONS unhandled on its relay routes rejects — the request itself
 * would have succeeded, but the browser never sends it. Going through the
 * server turns it into a same-origin call, where no preflight applies. The
 * reply is streamed back verbatim, so both paths are read the same way.
 */
function callTarget(base, path, viaProxy, init) {
  const url = `${base}${path}`
  if (!viaProxy) {
    return fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })
  }
  const token = session.get()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(PROXY_PATH, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method: init.method, url, headers: init.headers, body: init.body ?? '' }),
    signal: init.signal,
  })
}

const readProtocol = () => {
  const stored = localStorage.getItem(PROTOCOL_STORAGE)
  return stored && stored in PROTOCOLS ? stored : 'chat_completions'
}

// ---- page -------------------------------------------------------------------

export function renderPlayground(container) {
  const isAdmin = sessionStore.isAdmin()

  let models = []
  let modelsState = 'loading'
  let protocol = readProtocol()
  let viaServer = localStorage.getItem(PROXY_STORAGE) === '1'
  let savedKeys = readKeys()
  let remember = localStorage.getItem(REMEMBER_STORAGE) !== '0'
  let stream = true
  let output = ''
  let metrics = null
  let running = false
  let abort = null
  let disposed = false
  // Whether the viewport is glued to the bottom. Recorded on every scroll —
  // before new text lands — because measuring after the render would count
  // the fresh chunk itself as "the user scrolled away".
  let follow = true
  let modelsSeq = 0
  let modelsTimer = null

  const narrow = watchMedia('(max-width: 991px)', () => {})

  // Only an administrator can ask the server to fetch, and only another host
  // needs it: this site is already the page's own origin.
  const proxyEnabled = () => viaServer && isAdmin
  const hostBase = () => normalizeHost(host.value)
  const spec = () => PROTOCOLS[protocol]

  // ---- request side -----------------------------------------------------

  const host = input({ id: 'pg-host', value: localStorage.getItem(HOST_STORAGE) ?? '', placeholder: window.location.origin })
  const hostHint = el('div', { class: 'field__hint' })
  const proxyRow = el('label', { class: 'row', style: { marginTop: '8px', cursor: 'pointer' } })

  // Restored eagerly so the page is usable the moment it opens.
  const key = input({
    id: 'pg-key',
    type: 'password',
    placeholder: 'sk-...',
    value: remember ? (savedKeys[0] ?? '') : '',
    autocomplete: 'off',
  })
  const keyMenuSlot = el('span')
  const keyHint = el('div', { class: 'field__hint' })

  const protocolSelect = select({
    id: 'pg-protocol',
    value: protocol,
    options: PROTOCOL_ORDER.map((value) => ({ value, label: `${PROTOCOLS[value].label}  ·  ${PROTOCOLS[value].path}` })),
    onChange: (value) => {
      protocol = value
      localStorage.setItem(PROTOCOL_STORAGE, value)
      paintHostHint()
    },
  })

  // A datalist rather than a select: a host that exposes no /v1/models, or
  // refuses the cross-origin read, still has to be testable by typing.
  const model = input({ id: 'pg-model', placeholder: '选择或输入模型' })
  model.setAttribute('list', 'pg-models')
  model.autocomplete = 'off'
  const modelList = el('datalist', { id: 'pg-models' })
  const modelHint = el('div', { class: 'field__hint' })

  const system = textarea({ id: 'pg-system', rows: 2, placeholder: '留空则不发送 system 消息' })
  const prompt = textarea({ id: 'pg-prompt', rows: 7, value: '用一句话介绍你自己。', placeholder: `输入提示词，${IS_MAC ? '⌘' : 'Ctrl'} + Enter 发送` })

  const streamToggle = toggle({
    checked: stream,
    ariaLabel: '流式输出',
    onChange: (checked, control) => {
      control.setChecked(checked)
      stream = checked
    },
  })

  const sendButton = button({ label: '发送', variant: 'primary', glyph: ICONS.send, onClick: () => send() })
  const stopButton = button({ label: '停止', variant: 'danger', glyph: ICONS.stop, disabled: true, onClick: () => stop() })
  stopButton.title = '仅在请求进行中可用'

  const onPromptKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!running) void send()
    }
  }
  system.addEventListener('keydown', onPromptKeyDown)
  prompt.addEventListener('keydown', onPromptKeyDown)

  // ---- response side ----------------------------------------------------

  const errorSlot = el('div')
  const metricsSlot = el('div')
  const outputBox = el('div', { class: 'playground-output' })
  const outputSlot = el('div')
  const caret = el('span', { class: 'playground-caret' })

  outputBox.addEventListener('scroll', () => {
    follow = outputBox.scrollHeight - outputBox.scrollTop - outputBox.clientHeight < FOLLOW_SLACK
  })

  const copyButton = button({
    variant: 'icon',
    glyph: ICONS.copy,
    ariaLabel: '复制输出',
    disabled: true,
    onClick: async () => {
      // Awaited: the clipboard API rejects over plain HTTP, and reporting
      // success without checking would be a lie exactly when it matters.
      if (await copyText(output)) toast.success('已复制')
      else toast.warning('浏览器拒绝了剪贴板访问，请手动选中复制')
    },
  })
  const clearButton = button({
    variant: 'icon',
    glyph: ICONS.clear,
    ariaLabel: '清空输出',
    disabled: true,
    onClick: () => {
      output = ''
      metrics = null
      replace(errorSlot, null)
      paintResponse()
    },
  })

  const responseCard = card({
    title: '响应',
    extra: el('div', { class: 'row', style: { gap: '4px' } }, [copyButton, clearButton]),
    body: [errorSlot, metricsSlot, outputSlot],
  })

  // ---- layout -----------------------------------------------------------

  const labelled = (text, control, ...extra) =>
    el('div', {}, [el('label', { class: 'field__label', for: control.id }, text), control, ...extra])

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '调用测试',
        description: '这里发起的是真实请求，会经过完整的渠道路由，产生计费与调用日志。',
      }),
      el('div', { class: 'grid grid--playground' }, [
        card({
          title: '请求',
          body: el('div', { class: 'stack', style: { gap: '14px' } }, [
            labelled('服务地址', host, hostHint, proxyRow),
            labelled('API 密钥', el('div', { class: 'input-group' }, [key, keyMenuSlot]), keyHint, rememberRow()),
            labelled('协议', protocolSelect),
            labelled('模型', el('div', {}, [model, modelList]), modelHint),
            labelled('System 提示词（可选）', system),
            labelled('用户提示词', prompt),
            el('label', { class: 'row', style: { cursor: 'pointer' } }, [streamToggle, el('span', { class: 'text-small' }, '流式输出')]),
            el('div', { class: 'row' }, [
              sendButton,
              stopButton,
              Object.assign(el('span', { class: 'text-muted text-small' }, IS_MAC ? '⌘↵' : 'Ctrl↵'), {
                title: `快捷键 ${IS_MAC ? '⌘' : 'Ctrl'} + Enter`,
              }),
            ]),
          ]),
        }),
        responseCard,
      ]),
    ]),
  )

  // Fix the label→control association for the composite fields.
  key.id = 'pg-key'
  model.id = 'pg-model'

  function rememberRow() {
    const control = toggle({
      checked: remember,
      ariaLabel: '在本浏览器记住密钥',
      onChange: async (checked, node) => {
        if (checked) {
          node.setChecked(true)
          remember = true
          localStorage.setItem(REMEMBER_STORAGE, '1')
          return
        }
        // Turning remembering off also wipes what was remembered; that is
        // destructive, so it gets the same confirmation as "clear".
        node.setChecked(true)
        const ok = await confirmForgetKeys()
        if (!ok) return
        node.setChecked(false)
        remember = false
        localStorage.setItem(REMEMBER_STORAGE, '0')
      },
    })
    return el('label', { class: 'row', style: { marginTop: '8px', cursor: 'pointer' } }, [
      control,
      el('span', { class: 'text-muted text-small' }, '在本浏览器记住密钥（明文存于 localStorage）'),
    ])
  }

  // ---- keys -------------------------------------------------------------

  function rememberKey(value) {
    savedKeys = [value, ...savedKeys.filter((item) => item !== value)].slice(0, MAX_REMEMBERED)
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(savedKeys))
    paintKeyMenu()
  }

  function forgetOneKey(value) {
    savedKeys = savedKeys.filter((item) => item !== value)
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(savedKeys))
    paintKeyMenu()
  }

  /** Resolves true once the keys are gone (or there were none to clear). */
  async function confirmForgetKeys() {
    if (savedKeys.length === 0) return true
    const confirmed = await confirmModal({
      title: `清除本机保存的 ${savedKeys.length} 个密钥？`,
      description: '只影响这台浏览器上的记忆，密钥本身不会被删除，但需要重新粘贴才能继续调试。',
      okText: '清除',
      danger: true,
    })
    if (!confirmed) return false
    localStorage.removeItem(KEYS_STORAGE)
    savedKeys = []
    paintKeyMenu()
    toast.success('已清除本机保存的密钥')
    return true
  }

  let keyMenu = null
  function paintKeyMenu() {
    keyMenu?.destroy()
    keyMenu = null
    if (savedKeys.length === 0) {
      replace(keyMenuSlot, null)
      return
    }
    const trigger = el('button', { type: 'button', class: 'btn', 'aria-label': '选择已保存的密钥', 'aria-haspopup': 'menu' }, icon(ICONS.down, { size: 12 }))
    keyMenu = dropdown(trigger, () => [
      ...savedKeys.map((saved) => {
        const item = menuItem({
          label: maskKey(saved),
          onSelect: () => {
            key.value = saved
            scheduleModels()
          },
        })
        item.classList.add('mono')
        item.append(
          el(
            'button',
            {
              type: 'button',
              class: 'chip__remove',
              'aria-label': `删除已保存的密钥 ${maskKey(saved)}`,
              onclick: (event) => {
                event.stopPropagation()
                forgetOneKey(saved)
                keyMenu?.close()
              },
            },
            icon(ICONS.close, { size: 10 }),
          ),
        )
        return item
      }),
      el('div', { class: 'dropdown__divider' }),
      menuItem({ label: '清除已保存的密钥', danger: true, onSelect: () => void confirmForgetKeys() }),
    ])
    replace(keyMenuSlot, keyMenu.node)
  }

  // ---- models -----------------------------------------------------------

  /**
   * The local list comes from the session, so a key being typed must not
   * reload it; only another host's list is read with the key. A reply from
   * the host that was in the field a moment ago must not land in the list
   * belonging to the current one.
   */
  function loadModels() {
    const seq = ++modelsSeq
    const base = normalizeHost(host.value)
    const apply = (list, state) => {
      if (modelsSeq !== seq || disposed) return
      models = list
      modelsState = state
      if (!model.value && list[0]) model.value = list[0]
      paintModels()
    }

    if (base === null) {
      apply([], 'error')
      return
    }
    if (base === '') {
      modelsState = 'loading'
      paintModels()
      api
        .myModels()
        .then((result) => apply(result.data ?? [], 'ready'))
        .catch(() => apply([], 'error'))
      return
    }
    // Another deployment has no session behind it: its model list only comes
    // back for a key it issued itself.
    const remoteKey = key.value.trim()
    if (!remoteKey) {
      apply([], 'need-key')
      return
    }
    modelsState = 'loading'
    paintModels()
    callTarget(base, '/v1/models', proxyEnabled(), { method: 'GET', headers: { Authorization: `Bearer ${remoteKey}` } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((payload) => apply(asArray(payload?.data).map((item) => asText(item?.id)).filter(Boolean), 'ready'))
      .catch(() => apply([], 'error'))
  }

  /** The model list trails the typing instead of firing a request per keystroke. */
  function scheduleModels() {
    window.clearTimeout(modelsTimer)
    modelsTimer = window.setTimeout(loadModels, DEBOUNCE_MS)
  }

  host.addEventListener('input', () => {
    localStorage.setItem(HOST_STORAGE, host.value)
    paintHostHint()
    scheduleModels()
  })
  key.addEventListener('input', () => {
    // Only a remote host's list depends on the key.
    if (hostBase()) scheduleModels()
    paintKeyHint()
  })

  function paintModels() {
    modelList.replaceChildren(...models.map((item) => el('option', { value: item })))
    const STATE_HINT = {
      loading: '加载中…',
      error: '模型列表加载失败，可直接输入模型名',
      'need-key': '填入该服务的密钥后自动拉取模型',
    }
    let hint = STATE_HINT[modelsState]
    if (!hint) hint = models.length === 0 ? '暂无可用模型，可直接输入模型名' : `${models.length} 个可选，也可直接输入`
    replace(modelHint, [
      hint,
      modelsState === 'error' && ' ',
      modelsState === 'error' && button({ label: '重试', variant: 'link', onClick: loadModels }),
    ])
  }

  // ---- hints ------------------------------------------------------------

  function paintHostHint() {
    const base = hostBase()
    host.classList.toggle('input--invalid', base === null)
    let text
    if (base === null) text = '地址读不出来，填成 https://api.example.com 这样'
    else if (base) text = `请求发往 ${base}${spec().path}${proxyEnabled() ? '（经本站服务端代发）' : ''}，计费与日志都记在那边`
    else text = `留空就是当前站点，请求发往 ${spec().path}`
    hostHint.textContent = text
    hostHint.classList.toggle('text-danger', base === null)

    // The proxy switch is only offered where it applies.
    if (isAdmin && base) {
      if (!proxyRow.childElementCount) {
        proxyRow.append(
          toggle({
            checked: viaServer,
            ariaLabel: '通过本站服务端代发',
            onChange: (checked, control) => {
              control.setChecked(checked)
              viaServer = checked
              localStorage.setItem(PROXY_STORAGE, checked ? '1' : '0')
              paintHostHint()
              scheduleModels()
            },
          }),
          el('span', { class: 'text-muted text-small' }, '通过本站服务端代发（对方不响应 CORS 预检时用）'),
        )
      }
      proxyRow.style.display = ''
    } else {
      proxyRow.style.display = 'none'
    }
    paintKeyHint()
  }

  function paintKeyHint() {
    if (hostBase()) {
      replace(keyHint, '请填那个服务签发的密钥，本站的密钥它不认。')
      return
    }
    replace(keyHint, [
      '还没有密钥？',
      el('a', { href: '/tokens', onclick: (event) => { event.preventDefault(); router.navigate('/tokens') } }, '去创建'),
    ])
  }

  // ---- response ---------------------------------------------------------

  function showError(text) {
    const notice = banner({ type: 'warning', title: '请求失败' })
    notice.lastElementChild.append(el('pre', { class: 'code-block', style: { marginTop: '8px' } }, text))
    notice.append(
      button({
        variant: 'icon',
        glyph: ICONS.close,
        ariaLabel: '关闭',
        onClick: () => replace(errorSlot, null),
      }),
    )
    replace(errorSlot, notice)
  }

  function paintMetrics() {
    if (!metrics) {
      replace(metricsSlot, null)
      return
    }
    const item = (label, value, hint = null, cls = null) =>
      el('div', { class: 'metric-strip__item' }, [
        Object.assign(el('span', { class: 'metric-strip__label' }, label), { title: hint }),
        el('span', { class: `metric-strip__value${cls ? ` ${cls}` : ''}` }, value),
      ])

    // Generation speed: tokens over the time they streamed in, not over the
    // queueing wait before the first byte.
    const generationMs = metrics.totalMs - metrics.ttfbMs
    const tokensPerSecond =
      metrics.usage?.completion_tokens && generationMs > 0
        ? (metrics.usage.completion_tokens / (generationMs / 1000)).toFixed(1)
        : null

    replace(
      metricsSlot,
      el('div', { class: 'metric-strip' }, [
        item('首字节', metrics.ttfbMs ? formatDuration(metrics.ttfbMs) : '-'),
        item('总耗时', formatDuration(metrics.totalMs)),
        item('输出字符', formatNumber(metrics.chars)),
        metrics.usage &&
          item('输入 / 输出 Token', `${formatNumber(metrics.usage.prompt_tokens ?? 0)} / ${formatNumber(metrics.usage.completion_tokens ?? 0)}`),
        tokensPerSecond && item('输出速度', `${tokensPerSecond} tok/s`, '按首字节之后的生成时间计算'),
        metrics.aborted && item('状态', '已手动停止', null, 'text-warning'),
      ]),
    )
  }

  function paintResponse() {
    copyButton.disabled = !output
    copyButton.title = output ? '复制输出' : '暂无可复制的输出'
    const clearable = Boolean(output || metrics || errorSlot.childElementCount)
    clearButton.disabled = !clearable
    clearButton.title = clearable ? '清空' : '暂无可清空的内容'
    paintMetrics()

    if (output || running) {
      outputBox.textContent = output
      if (running) outputBox.append(caret)
      if (!outputSlot.contains(outputBox)) replace(outputSlot, outputBox)
      // Follow the stream while glued; scrolling up to re-read must not be
      // fought by the incoming text.
      if (running && follow) outputBox.scrollTop = outputBox.scrollHeight
      return
    }
    if (errorSlot.childElementCount) {
      replace(outputSlot, null)
      return
    }
    replace(
      outputSlot,
      emptyState({ title: '还没有响应', description: '填好密钥、选择模型后点「发送」，这里会实时展示输出。' }),
    )
  }

  function setRunning(next) {
    running = next
    sendButton.setBusy(next)
    stopButton.disabled = !next
    stopButton.title = next ? '中止本次请求' : '仅在请求进行中可用'
  }

  // ---- send ---------------------------------------------------------------

  function stop() {
    abort?.abort()
    abort = null
  }

  async function send() {
    const base = hostBase()
    if (base === null) {
      toast.warning('服务地址读不出来，填成 https://api.example.com 这样')
      host.focus()
      return
    }
    const proxied = Boolean(base) && proxyEnabled()
    const secret = key.value.trim()
    if (!secret) {
      toast.warning('请先填入 API 密钥（在「API 密钥」页面创建时复制）')
      key.focus()
      return
    }
    if (!model.value.trim()) {
      toast.warning('请选择模型')
      model.focus()
      return
    }
    if (!prompt.value.trim()) {
      // An empty user turn still bills and still logs; stop it before it costs.
      toast.warning('请输入用户提示词')
      prompt.focus()
      return
    }

    abort?.abort()
    const controller = new AbortController()
    abort = controller

    setRunning(true)
    output = ''
    metrics = null
    replace(errorSlot, null)
    // A fresh request starts glued to the bottom, whatever the last one did.
    follow = true
    paintResponse()

    // On a phone the response card is below the fold; bring it into view so
    // the stream is seen, not just produced.
    if (narrow.matches()) responseCard.scrollIntoView({ behavior: 'smooth', block: 'start' })

    const startedAt = performance.now()
    const current = spec()
    let ttfb = 0
    let usage = null
    let text = ''
    let failed = false

    try {
      const response = await callTarget(base, current.path, proxied, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, ...(current.headers ?? {}) },
        body: JSON.stringify(current.body({ model: model.value.trim(), system: system.value.trim(), prompt: prompt.value, stream })),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        showError(`HTTP ${response.status}\n${await response.text()}`)
        failed = true
        return
      }

      if (remember) rememberKey(secret)

      if (!stream) {
        // No first-byte metric here: the whole body arrives at once, so the
        // number would just repeat the total.
        const payload = await response.json()
        usage = current.usage(payload)
        // An unrecognised shape is still worth seeing: a gateway that answers
        // in its own envelope is exactly what a test page is for.
        text = current.text(payload) || JSON.stringify(payload, null, 2)
        output = text
        paintResponse()
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const event = current.event(JSON.parse(payload))
            usage = mergeUsage(usage, event.usage)
            if (event.delta) {
              if (!ttfb) ttfb = performance.now() - startedAt
              text += event.delta
              output = text
              paintResponse()
            }
          } catch {
            // Keep-alive comments and partial frames are not worth surfacing.
          }
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        failed = true
        // "Failed to fetch" says nothing actionable; name the likely cause and
        // keep the raw error underneath as detail.
        const detail = String(error)
        if (!(error instanceof TypeError)) {
          showError(detail)
        } else if (!base) {
          showError(`无法连接到服务，请检查网络或服务是否在运行。\n${detail}`)
        } else {
          // The browser reports a refused preflight as an ordinary network
          // failure, so the way past it has to be named here.
          const hint = isAdmin && !proxied ? '\n如果对方不响应 CORS 预检，打开上面的「通过本站服务端代发」再试。' : ''
          showError(`无法连接到 ${base}，请检查地址是否正确、服务是否在运行，以及它是否允许跨域调用。${hint}\n${detail}`)
        }
      }
    } finally {
      const aborted = controller.signal.aborted
      // A failed request produced nothing to measure; a strip of zeros would
      // only suggest something arrived.
      if (!failed && (text || usage || aborted || ttfb)) {
        metrics = {
          ttfbMs: Math.round(ttfb),
          totalMs: Math.round(performance.now() - startedAt),
          chars: text.length,
          usage,
          aborted,
        }
      }
      if (abort === controller) abort = null
      if (!disposed) {
        setRunning(false)
        paintResponse()
      }
    }
  }

  // ---- start --------------------------------------------------------------

  paintKeyMenu()
  paintHostHint()
  paintResponse()
  loadModels()

  return () => {
    disposed = true
    stop()
    narrow.stop()
    window.clearTimeout(modelsTimer)
    keyMenu?.destroy()
  }
}
