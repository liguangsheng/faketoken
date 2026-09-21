/**
 * The blocklist tab: keyword groups, one collapsible section each.
 *
 * Every group carries two textareas and a reply list, so laying them all out
 * at once buried both the summary and the global default under a page of
 * editors. Collapsed, a group states what an operator checks day to day —
 * whether it is on, how many keywords bite, how it answers — and opens only
 * to be changed.
 *
 * The editor is dumb by design: it renders out of the draft it is given and
 * hands every change straight back up through `patch`. Splitting state out of
 * it would mean two places to look when a setting fails to save.
 */

import { el, icon } from '../../driver/dom.js'
import { banner, button, field, input, select, tag, textarea, toggle } from '../../ui/controls.js'
import { emptyState } from '../../ui/feedback.js'
import { ICONS } from '../../ui/icons.js'
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_BYTES,
  MAX_REPLIES,
  MAX_REPLY_BYTES,
  MAX_RULES,
  MAX_RULE_NAME,
  STATUS_OPTIONS,
  blocklistStats,
  keptPerRule,
  nonEmpty,
} from './shared.js'

/**
 * Renders the tab into a fresh container and returns it.
 *
 * `open` is the set of expanded group indices, owned by the caller so it
 * survives the repaint that every keystroke triggers. Index-keyed, which holds
 * because the caller remaps it on removal.
 */
export function renderBlocklist({ draft, patch, open }) {
  const rules = draft.block_rules ?? []
  const kept = keptPerRule(rules)
  const stats = blocklistStats(draft)

  const setRules = (next) => patch({ block_rules: next })
  const updateRule = (index, rulePatch) =>
    setRules(rules.map((rule, i) => (i === index ? { ...rule, ...rulePatch } : rule)))

  const addRule = () => {
    // A group added closed would be a row of counters with nowhere to type.
    open.add(rules.length)
    setRules([...rules, { name: '', enabled: true, keywords: [], replies: [''], status: 0 }])
  }

  const removeRule = (index) => {
    // Indices above the hole shift down by one; without this the wrong group
    // would be left standing open.
    const next = new Set()
    for (const key of open) {
      if (key === index) continue
      next.add(key > index ? key - 1 : key)
    }
    open.clear()
    for (const key of next) open.add(key)
    setRules(rules.filter((_, i) => i !== index))
  }

  // ---- global default --------------------------------------------------

  const statusSelect = select({
    id: 'blocked-status',
    value: draft.blocked_status,
    options: STATUS_OPTIONS,
    ariaLabel: '命中后默认返回的状态码',
    onChange: (value) => patch({ blocked_status: Number(value) }),
  })

  const head = el('div', { class: 'settings-form' }, [
    settingsRow({
      label: '默认状态码',
      control: statusSelect,
      help: '命中后返回什么，每个规则组都可以单独覆盖。2xx 会把命中组的回复当作模型回复正常返回，调用方察觉不到被拦截；4xx / 5xx 则作为错误消息返回。',
    }),
  ])

  // ---- groups ------------------------------------------------------------

  const addButton = button({
    label: '添加规则组',
    glyph: ICONS.plus,
    disabled: rules.length >= MAX_RULES,
    onClick: addRule,
  })

  const summary =
    rules.length > 0
      ? el('span', { class: 'text-muted text-small' }, `${rules.length} 组 · 生效 ${stats.activeKeywords} 个关键词`)
      : null

  const groupsHead = el('div', { class: 'settings-rules__head' }, [
    el('div', { class: 'settings-section__title' }, ['规则组', summary]),
    addButton,
  ])

  let groups
  if (rules.length === 0) {
    groups = emptyState({
      compact: true,
      title: '还没有任何屏蔽规则',
      description:
        '按类别建组，例如「测活探测」和「破甲越狱」各一组：命中哪一组，就从那一组的预设回复里随机选一条返回。',
    })
  } else {
    groups = el(
      'div',
      { class: 'settings-rules__list' },
      rules.map((rule, index) =>
        ruleGroup({
          rule,
          index,
          kept: kept[index] ?? 0,
          inherited: draft.blocked_status,
          expanded: open.has(index),
          onToggle: () => {
            if (open.has(index)) open.delete(index)
            else open.add(index)
            // Only the disclosure changed; the draft did not, so the caller
            // is asked to repaint without touching the dirty state.
            patch({})
          },
          onChange: (rulePatch) => updateRule(index, rulePatch),
          onRemove: () => removeRule(index),
        }),
      ),
    )
  }

  // ---- notices -----------------------------------------------------------

  const problems = []
  if (stats.oversizedReplies > 0) {
    problems.push(`有 ${stats.oversizedReplies} 条回复超过 ${MAX_REPLY_BYTES} 字节，保存会被服务端拒绝。`)
  }
  if (stats.droppedLines > 0) {
    problems.push(
      `有 ${stats.droppedLines} 行关键词不会生效：同组内重复的词只算一次，超过 ${MAX_KEYWORD_BYTES} 字节的词会被忽略，所有组加起来最多取前 ${MAX_KEYWORDS} 个。`,
    )
  }

  const notices = []
  if (problems.length > 0) {
    const list = banner({
      type: stats.oversizedReplies > 0 ? 'warning' : 'info',
      title: '有配置不会按预期生效',
    })
    list.lastElementChild.append(
      el('ul', { class: 'settings-problems' }, problems.map((text) => el('li', {}, text))),
    )
    notices.push(list)
  }

  if (stats.activeKeywords > 0) {
    const masked = stats.anyMasked
      ? '嵌入、音频、图像等接口例外，它们期待向量或二进制，没有地方放一段文字，仍然返回 401。'
      : ''
    notices.push(
      banner({
        title: '调用方不会知道自己被拦截',
        description: `命中的是请求正文原文的子串，一个词被两组共用时算靠前那一组。调用方看到的是一次正常回复，看不到命中了哪个词；完整命中记录只在管理员的调用日志里。${masked}`,
      }),
    )
  }

  return el('div', {}, [head, el('div', { class: 'settings-rules' }, [groupsHead, groups, ...notices])])
}

/** One collapsible group: a summary row, and the editor beneath it when open. */
function ruleGroup({ rule, index, kept, inherited, expanded, onToggle, onChange, onRemove }) {
  const name = rule.name || `规则组 ${index + 1}`

  const enabledSwitch = toggle({
    checked: rule.enabled,
    ariaLabel: `启用${name}`,
    onChange: (checked, control) => {
      control.setChecked(checked)
      onChange({ enabled: checked })
    },
  })

  const removeButton = button({
    variant: 'icon',
    glyph: ICONS.delete,
    ariaLabel: `删除${name}`,
    onClick: onRemove,
  })
  removeButton.classList.add('btn--danger')

  // The header is one big disclosure button, so the two controls sitting on
  // it stop their clicks from reaching it.
  const controls = el(
    'div',
    { class: 'rule-group__controls', onclick: (event) => event.stopPropagation() },
    [enabledSwitch, removeButton],
  )

  const status = rule.status ? String(rule.status) : `${inherited}（继承）`

  const header = el(
    'button',
    {
      type: 'button',
      class: 'rule-group__head',
      'aria-expanded': expanded ? 'true' : 'false',
      onclick: onToggle,
    },
    [
      el('span', { class: 'rule-group__chevron' }, icon(ICONS.chevronRight, { size: 12 })),
      el(
        'span',
        { class: 'rule-group__summary', style: { opacity: rule.enabled ? '1' : '0.55' } },
        [
          el('strong', {}, name),
          tag(`关键词 ${kept}`),
          tag(`回复 ${nonEmpty(rule.replies)}`),
          el('span', { class: 'text-muted text-small' }, status),
        ],
      ),
    ],
  )

  return el('div', { class: `rule-group${expanded ? ' rule-group--open' : ''}` }, [
    el('div', { class: 'rule-group__bar' }, [header, controls]),
    expanded && ruleEditor({ rule, ordinal: index + 1, kept, inherited, onChange }),
  ])
}

/**
 * The body of one open group: what it is called, what it matches, what it
 * answers with, and how.
 *
 * Two columns. Keywords and replies are read against each other — a pool of
 * one reply against forty keywords is the kind of thing you only notice with
 * both in view.
 */
function ruleEditor({ rule, ordinal, kept, inherited, onChange }) {
  const fallbackName = `规则组 ${ordinal}`

  const nameInput = input({
    value: rule.name,
    placeholder: fallbackName,
    maxlength: MAX_RULE_NAME,
    ariaLabel: `${fallbackName}名称`,
    onInput: (value) => onChange({ name: value }),
  })

  const keywords = textarea({
    value: rule.keywords.join('\n'),
    placeholder: '例如：\nping\n你是什么模型',
    rows: 8,
  })
  keywords.setAttribute('aria-label', `${fallbackName}的关键词`)
  keywords.addEventListener('input', () => onChange({ keywords: keywords.value.split('\n') }))

  const statusSelect = select({
    value: rule.status,
    ariaLabel: `${fallbackName}的状态码`,
    options: [{ value: 0, label: `继承默认（${inherited}）` }, ...STATUS_OPTIONS],
    onChange: (value) => onChange({ status: Number(value) }),
  })

  const replyCount = nonEmpty(rule.replies)
  const replies = el('div', { class: 'stack' }, [
    ...rule.replies.map((reply, replyIndex) => {
      const box = textarea({ value: reply, placeholder: '留空的条目不会保存', rows: 2 })
      box.setAttribute('aria-label', `${fallbackName}的第 ${replyIndex + 1} 条回复`)
      box.addEventListener('input', () =>
        onChange({ replies: rule.replies.map((r, i) => (i === replyIndex ? box.value : r)) }),
      )
      const remove = button({
        variant: 'icon',
        glyph: ICONS.delete,
        ariaLabel: `删除第 ${replyIndex + 1} 条回复`,
        onClick: () => onChange({ replies: rule.replies.filter((_, i) => i !== replyIndex) }),
      })
      remove.classList.add('btn--danger')
      return el('div', { class: 'settings-reply' }, [box, remove])
    }),
    button({
      label: '添加回复',
      glyph: ICONS.plus,
      disabled: rule.replies.length >= MAX_REPLIES,
      onClick: () => onChange({ replies: [...rule.replies, ''] }),
    }),
  ])

  return el('div', { class: 'rule-group__body settings-rule-form__cols' }, [
    el('div', {}, [
      field({ label: '组名', control: nameInput, hint: '只出现在管理员的日志里，不会发给调用方。' }),
      field({
        label: `关键词（生效 ${kept} 个）`,
        control: keywords,
        hint: '每行一个，不区分大小写，匹配请求正文原文的子串。过短或过于常见的词会误伤正常请求。',
      }),
      field({ label: '本组状态码', control: statusSelect }),
    ]),
    el('div', {}, [
      field({
        label: `预设回复（${replyCount} 条）`,
        control: replies,
        hint:
          replyCount > 1
            ? '每次命中从中随机选一条返回。'
            : '多填几条，命中时会随机选一条；一条不填则使用内置默认文本。',
      }),
    ]),
  ])
}

/**
 * The one form row every settings tab uses: label in a fixed column, control
 * and its explanation beside it. Fixed rather than fluid so the longest help
 * sentence cannot decide how wide the row is.
 */
export function settingsRow({ label, control, help = null, extra = null }) {
  return el('div', { class: 'settings-row' }, [
    el('div', { class: 'settings-row__label' }, label),
    el('div', { class: 'settings-row__body' }, [
      el('div', { class: 'settings-row__control' }, [control, extra]),
      help && el('div', { class: 'settings-row__help' }, help),
    ]),
  ])
}
