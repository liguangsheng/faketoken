/**
 * Form and action controls.
 *
 * Thin builders over the DOM driver: each returns a real element, so a page
 * composes markup by calling functions rather than by describing a tree that
 * something else has to reconcile. Where a control owns state (a switch, a
 * busy button), it exposes the setter instead of re-rendering the page.
 */

import { el, icon } from '../driver/dom.js'
import { ICONS } from './icons.js'

/**
 * A button.
 *
 * `onClick` may return a promise: while it settles the button shows a spinner
 * and stops taking clicks, which is what keeps a double-press from redeeming a
 * code twice or submitting a form again.
 */
export function button({
  label,
  onClick,
  variant = 'default',
  glyph = null,
  block = false,
  size = null,
  type = 'button',
  disabled = false,
  title = null,
  ariaLabel = null,
} = {}) {
  const classes = ['btn']
  // Space-separated, so a button can be both a link and dangerous: the two
  // are independent axes and the stylesheet expects .btn--link.btn--danger.
  for (const name of variant.split(/\s+/).filter((part) => part && part !== 'default')) {
    classes.push(`btn--${name}`)
  }
  if (block) classes.push('btn--block')
  if (size) classes.push(`btn--${size}`)

  const node = el(
    'button',
    {
      type,
      class: classes.join(' '),
      disabled,
      title,
      'aria-label': ariaLabel,
    },
    [glyph && icon(glyph, { size: 15 }), label && el('span', {}, label)],
  )

  let busy = false
  const setBusy = (value) => {
    busy = value
    node.classList.toggle('btn--busy', value)
    node.disabled = value || disabled
  }

  if (onClick) {
    node.addEventListener('click', async (event) => {
      if (busy) return
      const result = onClick(event)
      if (result && typeof result.then === 'function') {
        setBusy(true)
        try {
          await result
        } finally {
          // The node may already be gone if the handler navigated away.
          if (node.isConnected) setBusy(false)
          else busy = false
        }
      }
    })
  }

  node.setBusy = setBusy
  return node
}

/** A labelled field wrapper with room for a hint and a validation message. */
export function field({ label, control, hint = null, htmlFor = null } = {}) {
  const error = el('div', { class: 'field__error' })
  const node = el('div', { class: 'field' }, [
    label && el('label', { class: 'field__label', for: htmlFor }, label),
    control,
    hint && el('div', { class: 'field__hint' }, hint),
    error,
  ])

  node.setError = (message) => {
    error.textContent = message ?? ''
    control.classList?.toggle('input--invalid', Boolean(message))
    // The control announces its own invalidity, not just its colour.
    if (control.setAttribute) {
      if (message) control.setAttribute('aria-invalid', 'true')
      else control.removeAttribute('aria-invalid')
    }
  }
  node.control = control
  return node
}

export function input({
  id = null,
  value = '',
  placeholder = '',
  type = 'text',
  autocomplete = null,
  maxlength = null,
  disabled = false,
  ariaLabel = null,
  onInput = null,
  onEnter = null,
} = {}) {
  const node = el('input', {
    id,
    type,
    value,
    placeholder,
    disabled,
    class: 'input',
    autocomplete,
    maxlength,
    'aria-label': ariaLabel,
  })

  if (onInput) node.addEventListener('input', () => onInput(node.value))
  if (onEnter) {
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onEnter(node.value)
      }
    })
  }
  return node
}

export function textarea({ id = null, value = '', placeholder = '', rows = 2 } = {}) {
  return el('textarea', { id, value, placeholder, rows, class: 'input' })
}

/**
 * A number input.
 *
 * Kept as a real <input type="number"> so the browser supplies the spinner and
 * the numeric keypad on a phone. `read()` returns a number or null, because an
 * empty box and a zero are different answers.
 */
export function numberInput({
  id = null,
  value = null,
  min = null,
  max = null,
  step = null,
  placeholder = '',
} = {}) {
  const node = el('input', {
    id,
    type: 'number',
    class: 'input',
    placeholder,
    value: value === null || value === undefined ? '' : String(value),
  })
  if (min !== null) node.min = String(min)
  if (max !== null) node.max = String(max)
  if (step !== null) node.step = String(step)

  node.read = () => (node.value.trim() === '' ? null : Number(node.value))
  return node
}

/**
 * A local date-and-time field.
 *
 * datetime-local gives a real picker with no dependency. Its value is local
 * wall-clock text, so `readISO()` is what converts it to the instant the API
 * expects — reading `.value` directly would send the operator's clock as UTC.
 */
export function dateTimeInput({ id = null, min = null } = {}) {
  const node = el('input', { id, type: 'datetime-local', class: 'input' })
  if (min) node.min = min

  node.readISO = () => {
    if (!node.value) return undefined
    const date = new Date(node.value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return node
}

/**
 * A dropdown backed by a real <select>.
 *
 * Native on purpose: it is keyboard- and screen-reader-correct for free, and
 * on a phone it opens the system picker instead of a list that has to be
 * scrolled inside a table.
 */
export function select({
  id = null,
  value = '',
  options,
  placeholder = null,
  ariaLabel = null,
  onChange = null,
} = {}) {
  const node = el('select', { id, class: 'input select', 'aria-label': ariaLabel })

  // An empty first option is how "no filter" is expressed; without it the
  // select would silently apply its first real value.
  if (placeholder !== null) node.append(el('option', { value: '' }, placeholder))
  for (const option of options) {
    node.append(el('option', { value: String(option.value) }, option.label))
  }

  node.value = value === null || value === undefined ? '' : String(value)
  if (onChange) node.addEventListener('change', () => onChange(node.value))
  return node
}

/**
 * A set of checkboxes sharing one value.
 *
 *   checkboxGroup({ options: [{ value, label }], value: [...] })
 *
 * `read()` returns the checked values in option order, so the caller never
 * has to walk the DOM.
 */
export function checkboxGroup({ options, value = [], ariaLabel = null } = {}) {
  const chosen = new Set(value)
  const node = el('div', { class: 'checkbox-group', role: 'group', 'aria-label': ariaLabel })

  for (const option of options) {
    const box = checkbox({
      checked: chosen.has(option.value),
      onChange: (checked) => {
        if (checked) chosen.add(option.value)
        else chosen.delete(option.value)
      },
    })
    node.append(el('label', { class: 'checkbox-group__item' }, [box, el('span', {}, option.label)]))
  }

  node.read = () => options.map((option) => option.value).filter((item) => chosen.has(item))
  return node
}

/**
 * A clock field, "HH:MM".
 *
 * A native <input type="time">: the platform picker for free, and the value
 * is already the string the server stores. `read()` returns '' for an empty
 * or unparsable box rather than whatever the browser left in .value.
 */
export function timeInput({ id = null, value = '', step = 300, disabled = false } = {}) {
  const node = el('input', { id, type: 'time', class: 'input', value, disabled })
  node.step = String(step)
  node.read = () => (/^\d{2}:\d{2}$/.test(node.value) ? node.value : '')
  return node
}

/**
 * A list of short strings as chips, with a box to add more.
 *
 * Built for model names and group names, which arrive by paste as often as
 * by typing: the box splits on commas, whitespace and newlines, so a list
 * lifted from a provider's docs lands as one chip per name. `options` feeds a
 * datalist for suggestions; values outside it are accepted, because a key or
 * channel may name a model the console has not seen yet.
 */
export function tagInput({
  value = [],
  options = [],
  placeholder = '输入后回车添加',
  ariaLabel = null,
  onChange = null,
} = {}) {
  const chosen = [...value]
  const listId = `tags-${Math.random().toString(36).slice(2, 8)}`

  const chips = el('div', { class: 'tag-list' })
  const entry = input({ placeholder, ariaLabel })
  entry.setAttribute('list', listId)
  entry.autocomplete = 'off'

  const datalist = el('datalist', { id: listId }, options.map((item) => el('option', { value: item })))

  const paint = () => {
    chips.replaceChildren(
      ...chosen.map((item) =>
        el('span', { class: 'tag mono chip--removable' }, [
          item,
          el(
            'button',
            {
              type: 'button',
              class: 'chip__remove',
              'aria-label': `移除 ${item}`,
              onclick: () => {
                chosen.splice(chosen.indexOf(item), 1)
                paint()
                onChange?.([...chosen])
              },
            },
            icon(ICONS.close, { size: 10 }),
          ),
        ]),
      ),
    )
    chips.style.display = chosen.length > 0 ? '' : 'none'
  }

  const add = (text) => {
    let changed = false
    for (const raw of text.split(/[\s,]+/)) {
      const item = raw.trim()
      if (item && !chosen.includes(item)) {
        chosen.push(item)
        changed = true
      }
    }
    entry.value = ''
    if (changed) {
      paint()
      onChange?.([...chosen])
    }
  }

  entry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      add(entry.value)
    }
  })
  // Picking from the datalist fires change without a keypress.
  entry.addEventListener('change', () => add(entry.value))
  // A paste that contains a separator is a list; commit it as one.
  entry.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? ''
    if (/[\s,]/.test(text.trim())) {
      event.preventDefault()
      add(text)
    }
  })

  paint()

  const node = el('div', { class: 'stack' }, [chips, entry, datalist])
  node.read = () => [...chosen]
  node.setValue = (next) => {
    chosen.splice(0, chosen.length, ...next)
    paint()
  }
  node.setOptions = (next) => {
    datalist.replaceChildren(...next.map((item) => el('option', { value: item })))
  }
  return node
}

/** A checkbox. `indeterminate` is a property, not an attribute, so it is set here. */
export function checkbox({
  checked = false,
  indeterminate = false,
  disabled = false,
  ariaLabel = null,
  title = null,
  onChange = null,
} = {}) {
  const node = el('input', {
    type: 'checkbox',
    class: 'checkbox',
    checked,
    disabled,
    title,
    'aria-label': ariaLabel,
  })
  node.indeterminate = indeterminate
  if (onChange) node.addEventListener('change', () => onChange(node.checked))
  return node
}

/**
 * A search box that waits for typing to stop.
 *
 * The delay lives here rather than in each page: every list on this console
 * filters server-side, and a request per keystroke is how a keyword search
 * turns into a queue of stale answers racing each other.
 */
export function searchInput({ placeholder, ariaLabel = null, delay = 300, onSearch } = {}) {
  const control = input({ placeholder, ariaLabel: ariaLabel ?? placeholder })
  const wrap = el('div', { class: 'input-affix' }, [
    el('span', { class: 'input-affix__icon' }, icon(ICONS.search, { size: 15 })),
    control,
  ])

  let timer = null
  control.addEventListener('input', () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => onSearch(control.value.trim()), delay)
  })

  wrap.control = control
  wrap.clear = () => {
    window.clearTimeout(timer)
    control.value = ''
  }
  wrap.stop = () => window.clearTimeout(timer)
  return wrap
}

/** An input with a leading icon, and for passwords a reveal toggle. */
export function affixInput({ glyph, reveal = false, ...options }) {
  const control = input(options)
  const children = [el('span', { class: 'input-affix__icon' }, icon(glyph, { size: 15 })), control]

  if (reveal) {
    // The glyph stays put; the accessible name is what changes, because that
    // is the part a screen reader announces when the state flips.
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'input-affix__action',
        'aria-label': '显示密码',
        onclick: () => {
          const shown = control.type === 'text'
          control.type = shown ? 'password' : 'text'
          toggle.setAttribute('aria-label', shown ? '显示密码' : '隐藏密码')
        },
      },
      icon(ICONS.lock, { size: 14 }),
    )
    children.push(toggle)
  }

  const wrap = el('div', { class: 'input-affix' }, children)
  wrap.control = control
  return wrap
}

/**
 * A two-state toggle. Returns the button; read `.checked` to get its state.
 *
 * `disabled` is a real button property, not just a style: a switch that is
 * only greyed out still fires on click, and the rules these switches guard —
 * an administrator disabling their own account, for one — are exactly the
 * ones that must not depend on the caller remembering to re-check.
 */
export function toggle({
  checked = false,
  onChange = null,
  ariaLabel = null,
  disabled = false,
  title = null,
} = {}) {
  const node = el('button', {
    type: 'button',
    role: 'switch',
    class: 'switch',
    disabled,
    title,
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': ariaLabel,
  })

  node.checked = checked
  node.setChecked = (value) => {
    node.checked = value
    node.setAttribute('aria-checked', value ? 'true' : 'false')
  }
  node.setBusy = (value) => {
    node.disabled = value
  }

  node.addEventListener('click', () => {
    if (node.disabled) return
    onChange?.(!node.checked, node)
  })
  return node
}

/** A row of mutually exclusive options. */
export function segmented({ options, value, onChange, block = false } = {}) {
  const node = el('div', {
    class: `segmented${block ? ' segmented--block' : ''}`,
    role: 'tablist',
  })
  let current = value

  const paint = () => {
    for (const item of node.children) {
      const active = String(item.dataset.value) === String(current)
      item.classList.toggle('segmented__item--active', active)
      item.setAttribute('aria-selected', active ? 'true' : 'false')
    }
  }

  for (const option of options) {
    node.append(
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'segmented__item',
          dataset: { value: String(option.value) },
          onclick: () => {
            if (String(current) === String(option.value)) return
            current = option.value
            paint()
            onChange?.(option.value)
          },
        },
        option.label,
      ),
    )
  }

  paint()
  node.setValue = (next) => {
    current = next
    paint()
  }
  return node
}

export function tag(label, variant = null) {
  return el('span', { class: `tag${variant ? ` tag--${variant}` : ''}` }, label)
}

/** A standing notice inside a page. Named `banner` so it never reads as the
 *  global alert(), which it has nothing to do with. */
export function banner({ title, description = null, type = 'info' } = {}) {
  return el('div', { class: `alert alert--${type}` }, [
    el('span', { class: 'alert__icon' }, icon(type === 'warning' ? ICONS.warning : ICONS.info, { size: 16 })),
    el('div', {}, [
      el('div', { class: 'alert__title' }, title),
      description && el('div', { class: 'alert__description' }, description),
    ]),
  ])
}

export function card({ title = null, extra = null, body, tight = false } = {}) {
  return el('section', { class: 'card' }, [
    title &&
      el('div', { class: 'card__head' }, [
        el('div', { class: 'card__title' }, title),
        extra && el('div', { class: 'card__extra' }, extra),
      ]),
    el('div', { class: `card__body${tight ? ' card__body--tight' : ''}` }, body),
  ])
}

export function pageHeader({ title, description = null, extra = null } = {}) {
  return el('header', { class: 'page-header' }, [
    el('div', { class: 'page-header__text' }, [
      el('h1', { class: 'page-header__title' }, title),
      description && el('p', { class: 'page-header__description' }, description),
    ]),
    extra && el('div', { class: 'page-header__extra' }, extra),
  ])
}
