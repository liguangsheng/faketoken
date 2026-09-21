/**
 * What the redemption and invite pages have in common.
 *
 * The two are near-twins: a paged list of one-shot codes that can be disabled,
 * deleted in bulk, and generated a batch at a time. Only the columns and the
 * wording differ, so the list machinery lives here and each page supplies its
 * own columns, labels and endpoints.
 *
 * Deliberately not a generic "resource table": it encodes one rule that is
 * specific to these two — a code that has been used is a record of what
 * happened and is never selectable, disableable or deletable.
 */

import { el, icon, replace } from '../../driver/dom.js'
import { copyText } from '../../driver/clipboard.js'
import { defaultPageSize } from '../../core/settings.js'
import { formatDayTime, formatRelative, formatTime } from '../../core/format.js'
import {
  button,
  card,
  field,
  input,
  dateTimeInput,
  numberInput,
  pageHeader,
  searchInput,
  select,
  tag,
} from '../../ui/controls.js'
import { emptyState, skeleton } from '../../ui/feedback.js'
import { confirmModal, openModal } from '../../ui/modal.js'
import { pagination } from '../../ui/pagination.js'
import { cellStack, table } from '../../ui/table.js'
import { ICONS } from '../../ui/icons.js'
import { errorText, toast } from '../../ui/toast.js'

export const STATUS = { UNUSED: 1, USED: 2, DISABLED: 3 }

export const STATUS_OPTIONS = [
  { value: STATUS.UNUSED, label: '未使用' },
  { value: STATUS.USED, label: '已使用' },
  { value: STATUS.DISABLED, label: '已停用' },
]

const isExpired = (value) => Boolean(value) && new Date(value).getTime() < Date.now()

/**
 * Red is reserved for permanently dead — expired. Disabled is a reversible
 * holding state, so it is orange.
 */
export function statusTag(status, expiresAt) {
  if (status === STATUS.USED) return tag('已使用')
  if (status === STATUS.DISABLED) return tag('已停用', 'warning')
  if (isExpired(expiresAt)) return tag('已过期', 'danger')
  return tag('未使用', 'success')
}

/** The code itself, with a copy button that appears on hover. */
export function codeCell(code, label) {
  const copy = button({
    variant: 'icon',
    glyph: ICONS.copy,
    ariaLabel: `复制${label} ${code}`,
    onClick: async () => {
      if (await copyText(code)) toast.success('已复制')
      else toast.warning('浏览器拒绝了剪贴板访问，请手动复制')
    },
  })
  copy.classList.add('code-cell__copy')

  return el('div', { class: 'code-cell' }, [
    el('span', { class: 'mono truncate', title: code }, code),
    copy,
  ])
}

/** Never-expires reads as a word; a real deadline shows how far off it is. */
export function expiryCell(value) {
  if (!value) return el('span', { class: 'text-faint' }, '永久')

  const node = cellStack(formatDayTime(value), formatRelative(value))
  node.title = formatTime(value)
  if (isExpired(value)) node.firstElementChild.classList.add('text-danger')
  return node
}

export function relativeCell(value) {
  return el('span', { title: formatTime(value) }, formatRelative(value))
}

export function usedByCell(name, usedAt, verb) {
  if (!name) return el('span', { class: 'text-faint' }, '-')
  return el('span', { title: usedAt ? `${verb}于 ${formatTime(usedAt)}` : null }, name)
}

/** Today at midnight, in the local wall-clock format datetime-local wants. */
export function minExpiry() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00`
}

/**
 * Renders a code list page.
 *
 * `config` supplies everything that differs between the two:
 *   { title, description, unit, codeLabel, usedVerb, notice?,
 *     fetch(params), setStatus(id, status), remove(ids),
 *     columns(row), createFields(), create(values), createTitle, createHint }
 */
export function renderCodeList(container, config) {
  let rows = []
  let total = 0
  let page = 1
  let pageSize = defaultPageSize()
  let keyword = ''
  let statusFilter = ''
  let selected = new Set()
  let loading = true
  let disposed = false

  // Overlapping fetches race: a slow keyword query must not land after the
  // fast one that replaced it.
  let requestSeq = 0

  const listSlot = el('div')
  const pagerSlot = el('div')
  const bulkSlot = el('span')

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const createButton = button({
    label: config.createTitle,
    variant: 'primary',
    glyph: ICONS.plus,
    onClick: () => openCreate(),
  })

  const search = searchInput({
    placeholder: config.searchPlaceholder,
    onSearch: (value) => {
      keyword = value
      page = 1
      void load()
    },
  })

  const statusSelect = select({
    placeholder: '全部状态',
    options: STATUS_OPTIONS,
    ariaLabel: '按状态筛选',
    onChange: (value) => {
      statusFilter = value
      page = 1
      void load()
    },
  })

  const resetButton = button({
    label: '重置',
    variant: 'link',
    onClick: () => {
      search.clear()
      statusSelect.value = ''
      keyword = ''
      statusFilter = ''
      page = 1
      void load()
    },
  })

  const filterBar = el('div', { class: 'filter-bar' }, [
    search,
    statusSelect,
    resetButton,
    el('span', { class: 'filter-bar__spacer' }),
    bulkSlot,
  ])

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: config.title,
        description: config.description,
        extra: [refreshButton, createButton],
      }),
      config.notice ?? null,
      filterBar,
      listSlot,
      pagerSlot,
    ]),
  )

  async function load() {
    const seq = ++requestSeq
    loading = true
    refreshButton.setBusy(true)
    paint()

    try {
      const result = await config.fetch({
        page,
        page_size: pageSize,
        keyword,
        status: statusFilter === '' ? undefined : Number(statusFilter),
      })
      if (seq !== requestSeq || disposed) return

      rows = result.data ?? []
      total = result.total ?? 0

      // Drop selections that scrolled out of the current result set, so a bulk
      // action can never touch a row the operator can no longer see.
      const visible = new Set(rows.map((row) => row.id))
      selected = new Set([...selected].filter((id) => visible.has(id)))

      // A deletion can strand a deep page past the end; walk back to the last
      // real one rather than showing an empty table with rows behind it.
      const pages = Math.max(1, Math.ceil(total / pageSize))
      if (page > pages) {
        page = pages
        void load()
        return
      }
    } catch (error) {
      if (seq !== requestSeq || disposed) return
      toast.error(errorText(error, '加载失败'))
    } finally {
      if (seq === requestSeq && !disposed) {
        loading = false
        refreshButton.setBusy(false)
        paint()
      }
    }
  }

  async function setStatus(row, status) {
    try {
      await config.setStatus(row.id, status)
      toast.success(status === STATUS.DISABLED ? '已停用' : '已启用')
      await load()
    } catch (error) {
      toast.error(errorText(error, '操作失败'))
    }
  }

  async function removeOne(row) {
    const confirmed = await confirmModal({
      title: `删除这个${config.codeLabel}？`,
      description: `该${config.codeLabel}尚未被使用，删除后无法恢复。`,
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return

    try {
      const result = await config.remove([row.id])
      // The row can move to "used" between the listing and the click; the
      // server keeps it, and the count is how that becomes visible.
      if (result.deleted === 0) toast.warning(config.keptHint)
      else toast.success('已删除')
      selected.delete(row.id)
      await load()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    }
  }

  async function removeSelected() {
    const ids = [...selected]
    const confirmed = await confirmModal({
      title: `删除选中的 ${ids.length} 个${config.codeLabel}？`,
      description: config.bulkKeptHint,
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return

    try {
      const result = await config.remove(ids)
      toast.success(`已删除 ${result.deleted} 个${config.codeLabel}`)
      selected = new Set()
      await load()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    }
  }

  /**
   * The generate dialog.
   *
   * Two states in one modal: the form, then the codes it produced. The result
   * is shown here because handing them out is the point of the action, and
   * hunting for them in the table afterwards is needless work. The backdrop
   * does not close it — a stray click would take the whole batch with it.
   */
  function openCreate() {
    const fields = config.createFields()
    const bodySlot = el('div')
    const footSlot = el('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } })

    const dialog = openModal({
      title: config.createTitle,
      width: 560,
      dismissOnBackdrop: false,
      body: bodySlot,
      footer: () => footSlot,
    })

    const showForm = () => {
      replace(
        bodySlot,
        el('form', {
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault()
            submit.click()
          },
        }, [...fields.nodes, el('button', { type: 'submit', hidden: true })]),
      )
      replace(footSlot, [
        button({ label: '取消', onClick: () => dialog.close() }),
        submit,
      ])
    }

    const showResult = (codes) => {
      replace(bodySlot, [
        el('p', { class: 'text-muted' }, config.resultHint(codes.length, fields.read())),
        el('pre', { class: 'code-block', style: { maxHeight: '40vh' } }, codes.join('\n')),
      ])
      replace(footSlot, [
        button({ label: '完成', onClick: () => dialog.close() }),
        // The only thing worth doing at this moment, so it is the main action.
        button({
          label: '复制全部',
          variant: 'primary',
          onClick: async () => {
            if (await copyText(codes.join('\n'))) {
              toast.success(`已复制 ${codes.length} 个${config.codeLabel}`)
            } else {
              toast.warning('浏览器拒绝了剪贴板访问，请手动复制')
            }
          },
        }),
      ])
    }

    const submit = button({
      label: '生成',
      variant: 'primary',
      onClick: async () => {
        if (!fields.validate()) return
        try {
          const created = await config.create(fields.read())
          showResult(created.data.map((item) => item.code))
          await load()
        } catch (error) {
          toast.error(errorText(error, '生成失败'))
        }
      },
    })

    showForm()
  }

  /**
   * A used code is the only record of what happened, so it offers neither
   * action; the server refuses both regardless.
   */
  function rowActions(row) {
    if (row.status === STATUS.USED) {
      return el('span', { class: 'text-faint', title: config.keptHint }, '-')
    }

    const disabled = row.status === STATUS.DISABLED
    return el('div', { class: 'table__actions' }, [
      button({
        label: disabled ? '启用' : '停用',
        variant: 'link',
        onClick: () => setStatus(row, disabled ? STATUS.UNUSED : STATUS.DISABLED),
      }),
      button({ label: '删除', variant: 'link danger', onClick: () => removeOne(row) }),
    ])
  }

  function paint() {
    // The bulk action only exists while something is selected.
    replace(
      bulkSlot,
      selected.size > 0
        ? button({
            label: `删除选中 ${selected.size} 个`,
            variant: 'danger',
            onClick: removeSelected,
          })
        : null,
    )
    resetButton.style.display = keyword || statusFilter !== '' ? '' : 'none'

    if (loading && rows.length === 0) {
      replace(listSlot, card({ body: skeleton(6) }))
      replace(pagerSlot, null)
      return
    }

    replace(
      listSlot,
      table({
        caption: `${config.title}列表`,
        rowKey: (row) => row.id,
        rows,
        selection: {
          selected,
          rowId: (row) => row.id,
          disabled: (row) => row.status === STATUS.USED,
          disabledHint: config.keptHint,
          onChange: (next) => {
            selected = next
            paint()
          },
        },
        empty: emptyState({
          title: config.emptyTitle,
          description: config.emptyDescription,
          action: button({
            label: config.createTitle,
            variant: 'primary',
            glyph: ICONS.plus,
            onClick: () => openCreate(),
          }),
        }),
        columns: [
          ...config.columns(),
          {
            key: 'actions',
            title: '操作',
            width: 120,
            render: (row) => rowActions(row),
          },
        ],
      }),
    )

    replace(
      pagerSlot,
      pagination({
        page,
        pageSize,
        total,
        unit: config.unit,
        onChange: (nextPage, nextSize) => {
          page = nextPage
          pageSize = nextSize
          void load()
        },
      }),
    )
  }

  paint()
  void load()

  return () => {
    disposed = true
    search.stop()
  }
}

/**
 * The fields both generate dialogs share, plus whatever the caller adds.
 *
 * Returns { nodes, read, validate } so the dialog stays ignorant of which
 * fields it is showing.
 */
export function commonCreateFields({ countHint, noteHint, notePlaceholder }) {
  const count = numberInput({ id: 'code-count', value: 1, min: 1, max: 200, step: 1 })
  const note = input({ id: 'code-note', placeholder: notePlaceholder, maxlength: 64 })
  const expires = dateTimeInput({ id: 'code-expires', min: minExpiry() })

  const countField = field({
    label: '数量',
    control: count,
    htmlFor: 'code-count',
    hint: countHint,
  })
  const noteField = field({ label: '备注', control: note, htmlFor: 'code-note', hint: noteHint })
  const expiresField = field({
    label: '有效期',
    control: expires,
    htmlFor: 'code-expires',
    hint: '留空表示永久有效。',
  })

  return {
    countField,
    noteField,
    expiresField,
    read: () => ({
      count: count.read() ?? 0,
      name: note.value.trim(),
      expires_at: expires.readISO(),
    }),
    validate: () => {
      countField.setError(null)
      const value = count.read()
      if (value === null || !Number.isInteger(value) || value < 1 || value > 200) {
        countField.setError('请输入 1 到 200 之间的整数')
        return false
      }
      return true
    },
  }
}
