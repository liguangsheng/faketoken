/**
 * The model plaza: every model the caller's group can reach, and what each
 * would cost them.
 *
 * Read-only on purpose. Prices are shown after the group multiplier, because
 * the number a user needs is the one they will actually be billed.
 */

import { el, replace } from '../driver/dom.js'
import { copyText } from '../driver/clipboard.js'
import { api } from '../core/api.js'
import { formatPrice } from '../core/format.js'
import { button, pageHeader, searchInput, tag } from '../ui/controls.js'
import { emptyState, skeletonCard } from '../ui/feedback.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

/**
 * Vendors are guessed from the model name, purely for grouping and filtering.
 * Order matters: the first match wins, so the specific patterns sit above the
 * generic ones.
 */
const VENDORS = [
  {
    key: 'openai',
    label: 'OpenAI',
    test: /^(gpt|chatgpt|o[1345](-|$)|codex|davinci|babbage|text-embedding|dall-e|whisper|tts|sora)/i,
  },
  { key: 'anthropic', label: 'Anthropic', test: /claude/i },
  { key: 'google', label: 'Google', test: /^(gemini|gemma|imagen|veo|learnlm|models\/)/i },
  { key: 'deepseek', label: 'DeepSeek', test: /deepseek/i },
  { key: 'qwen', label: '通义千问', test: /^(qwen|qwq|qvq)/i },
  { key: 'zhipu', label: '智谱', test: /^(glm|chatglm|cogview|cogvideo)/i },
  { key: 'doubao', label: '豆包', test: /^doubao/i },
  { key: 'moonshot', label: 'Kimi', test: /^(kimi|moonshot)/i },
  { key: 'xai', label: 'xAI', test: /grok/i },
  { key: 'meta', label: 'Meta', test: /llama/i },
  {
    key: 'mistral',
    label: 'Mistral',
    test: /(mistral|mixtral|codestral|ministral|magistral|devstral|pixtral)/i,
  },
  { key: 'baidu', label: '百度', test: /ernie/i },
  { key: 'tencent', label: '腾讯混元', test: /hunyuan/i },
  { key: 'minimax', label: 'MiniMax', test: /(minimax|abab)/i },
  { key: 'cohere', label: 'Cohere', test: /^(command|c4ai|aya)/i },
]

const OTHER = { key: 'other', label: '其他' }

const vendorOf = (model) => VENDORS.find((vendor) => vendor.test.test(model)) ?? OTHER

export function renderPlaza(container) {
  let models = []
  let group = ''
  let rate = 1
  let policy = 'reject'
  let keyword = ''
  let vendorKey = 'all'
  let loading = true
  let error = null
  let disposed = false

  const headerSlot = el('div')
  const chipSlot = el('div')
  const bodySlot = el('div')

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const search = searchInput({
    placeholder: '搜索模型或厂商',
    onSearch: (value) => {
      keyword = value
      paint()
    },
  })

  container.append(el('div', { class: 'page-enter' }, [headerSlot, chipSlot, bodySlot]))

  async function load() {
    loading = true
    refreshButton.setBusy(true)
    paint()

    try {
      const result = await api.plaza()
      if (disposed) return
      models = result.data ?? []
      group = result.group
      rate = result.group_rate > 0 ? result.group_rate : 1
      policy = result.unpriced_policy
      error = null
    } catch (caught) {
      if (disposed) return
      error = errorText(caught, '加载失败')
      // The full-page error state only renders when there is nothing to show;
      // a failed refresh over an existing catalogue still needs a signal.
      toast.error(error)
    } finally {
      if (!disposed) {
        loading = false
        refreshButton.setBusy(false)
        paint()
      }
    }
  }

  /** Applies the group multiplier and works out what the model can do. */
  function entries() {
    return models.map((model) => {
      const missing = model.price_status === 'missing'
      const sum =
        model.input_price + model.output_price + model.cached_price + model.per_request_price
      return {
        ...model,
        vendor: vendorOf(model.model),
        input: model.input_price * rate,
        output: model.output_price * rate,
        cached: model.cached_price * rate,
        perRequest: model.per_request_price * rate,
        // A missing price only bills nothing when the operator relays it;
        // under the reject policy the model cannot be called at all.
        free: missing ? policy !== 'reject' : sum === 0,
        blocked: missing && policy === 'reject',
      }
    })
  }

  function paint() {
    const all = entries()

    // Keyword first, vendor second: the chips count what the keyword left, so
    // a chip never promises models that clicking it then fails to show.
    const needle = keyword.trim().toLowerCase()
    const byKeyword = needle
      ? all.filter(
          (entry) =>
            entry.model.toLowerCase().includes(needle) ||
            entry.vendor.label.toLowerCase().includes(needle) ||
            entry.vendor.key.includes(needle),
        )
      : all

    const shown = byKeyword.filter((entry) => vendorKey === 'all' || entry.vendor.key === vendorKey)

    paintHeader()
    paintChips(byKeyword)
    paintBody(all, byKeyword, shown)
  }

  function paintHeader() {
    const scaled =
      rate === 1
        ? '，即实际计费单价。'
        : `，已按分组倍率 ×${Number(rate.toPrecision(4))} 折算为实际计费单价。`

    replace(
      headerSlot,
      pageHeader({
        title: '模型广场',
        description: el('span', {}, [
          '当前分组 ',
          el('code', { class: 'mono' }, group || '-'),
          ' 可用的全部模型。价格单位为「美元 / 100 万 Token」',
          scaled,
        ]),
        extra: [search, refreshButton],
      }),
    )
  }

  function paintChips(byKeyword) {
    if (models.length === 0) {
      replace(chipSlot, null)
      return
    }

    const counts = new Map()
    for (const entry of byKeyword) {
      counts.set(entry.vendor.key, (counts.get(entry.vendor.key) ?? 0) + 1)
    }

    const chip = (key, label, count) =>
      el(
        'button',
        {
          type: 'button',
          class: `chip${vendorKey === key ? ' chip--active' : ''}`,
          role: 'radio',
          'aria-checked': vendorKey === key ? 'true' : 'false',
          'aria-label': `${label}，${count} 个模型`,
          onclick: () => {
            // Clicking the active chip clears the filter rather than doing
            // nothing, which is what a second click reads as.
            vendorKey = vendorKey === key ? 'all' : key
            paint()
          },
        },
        `${label}（${count}）`,
      )

    const chips = [...VENDORS, OTHER]
      .filter((vendor) => counts.has(vendor.key))
      .map((vendor) => chip(vendor.key, vendor.label, counts.get(vendor.key)))

    replace(
      chipSlot,
      el(
        'div',
        {
          class: 'tag-list',
          role: 'radiogroup',
          'aria-label': '按厂商筛选',
          style: { marginBottom: '16px' },
        },
        [chip('all', '全部', byKeyword.length), ...chips],
      ),
    )
  }

  function paintBody(all, byKeyword, shown) {
    if (loading && all.length === 0) {
      replace(
        bodySlot,
        el(
          'div',
          { class: 'model-grid' },
          Array.from({ length: 8 }, () => skeletonCard(120)),
        ),
      )
      return
    }

    if (error && all.length === 0) {
      replace(
        bodySlot,
        emptyState({
          title: '加载失败',
          description: error,
          action: button({
            label: '重试',
            variant: 'primary',
            glyph: ICONS.reload,
            onClick: () => load(),
          }),
        }),
      )
      return
    }

    if (all.length === 0) {
      replace(
        bodySlot,
        emptyState({
          title: '当前分组暂无可用模型',
          description: '还没有渠道向这个分组提供模型，请联系管理员配置渠道。',
        }),
      )
      return
    }

    if (shown.length === 0) {
      replace(
        bodySlot,
        emptyState({
          title: '没有匹配的模型',
          description: '换个关键词或厂商筛选试试。',
          action: button({
            label: '清除筛选',
            onClick: () => {
              search.clear()
              keyword = ''
              vendorKey = 'all'
              paint()
            },
          }),
        }),
      )
      return
    }

    // One section per vendor, in declaration order.
    const byVendor = new Map()
    for (const entry of shown) {
      const list = byVendor.get(entry.vendor.key)
      if (list) list.push(entry)
      else byVendor.set(entry.vendor.key, [entry])
    }

    replace(
      bodySlot,
      [...VENDORS, OTHER]
        .filter((vendor) => byVendor.has(vendor.key))
        .map((vendor) => {
          const list = byVendor.get(vendor.key).sort((a, b) => a.model.localeCompare(b.model))
          return el('section', { class: 'vendor-section' }, [
            el('h2', { class: 'vendor-section__title' }, [
              vendor.label,
              el('span', { class: 'text-muted text-small' }, `${list.length} 个模型`),
            ]),
            el('div', { class: 'model-grid' }, list.map(modelCard)),
          ])
        }),
    )
  }

  function modelCard(entry) {
    const priceRow = (label, value) =>
      el('div', { class: 'price-row' }, [
        el('span', { class: 'text-muted' }, label),
        el('span', { class: value === null ? 'text-muted' : 'mono' }, value ?? '-'),
      ])

    const tags = [tag(entry.vendor.label)]
    if (entry.blocked) tags.push(tag('暂不可用', 'danger'))
    else if (entry.free) tags.push(tag('免费', 'success'))
    if (entry.price_status === 'fallback') tags.push(tag('兜底价', 'warning'))

    const prices = [
      priceRow('输入 / 1M', entry.blocked ? null : formatPrice(entry.input)),
      priceRow('输出 / 1M', entry.blocked ? null : formatPrice(entry.output)),
    ]
    if (entry.cached > 0) prices.push(priceRow('缓存输入 / 1M', formatPrice(entry.cached)))
    if (entry.perRequest > 0) prices.push(priceRow('每次请求', formatPrice(entry.perRequest)))

    return el(
      'article',
      { class: `model-card${entry.blocked ? ' model-card--blocked' : ''}` },
      [
        el('div', { class: 'model-card__head' }, [
          el('span', { class: 'model-card__name mono truncate', title: entry.model }, entry.model),
          button({
            variant: 'icon',
            glyph: ICONS.copy,
            ariaLabel: `复制模型名 ${entry.model}`,
            title: '复制模型名',
            onClick: async () => {
              if (await copyText(entry.model)) toast.success(`已复制：${entry.model}`)
              else toast.error('复制失败：浏览器不允许访问剪贴板，请手动选中复制')
            },
          }),
        ]),
        el('div', { class: 'model-card__tags' }, tags),
        el('div', { class: 'model-card__prices' }, prices),
        // Touch screens never see a title tooltip, so the reason lives on the
        // card itself.
        entry.blocked &&
          el(
            'div',
            { class: 'text-muted text-small', style: { marginTop: '8px' } },
            '未配置价格，按当前计费策略暂不可调用',
          ),
      ],
    )
  }

  paint()
  void load()

  return () => {
    disposed = true
    search.stop()
  }
}
