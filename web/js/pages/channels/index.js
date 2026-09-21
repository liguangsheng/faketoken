/**
 * Channels: the upstreams a request can be routed to.
 *
 * Two lists on one page. The listing is what serves traffic; the archive is a
 * shelf below it, fetched separately because its count sits in a collapsed
 * header that has to be right before anyone expands it.
 */

import { el, icon, replace } from '../../driver/dom.js'
import { copyText } from '../../driver/clipboard.js'
import { api } from '../../core/api.js'
import { defaultPageSize } from '../../core/settings.js'
import {
  STATUS,
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
  stringifyEffortRules,
  stringifyMapping,
} from '../../core/format.js'
import { button, card, input, pageHeader, searchInput, select, tag, toggle } from '../../ui/controls.js'
import { dropdown, menuItem } from '../../ui/dropdown.js'
import { emptyState, skeleton } from '../../ui/feedback.js'
import { confirmModal, openModal } from '../../ui/modal.js'
import { pagination } from '../../ui/pagination.js'
import { table } from '../../ui/table.js'
import { ICONS } from '../../ui/icons.js'
import { errorText, toast } from '../../ui/toast.js'
import { openChannelDrawer } from './drawer.js'
import { openModelPicker } from './modelPicker.js'
import { openQuickImport } from './quickImport.js'
import { openTestDialog } from './testDialog.js'
import {
  AUTH_STYLES,
  MAX_PRIORITY,
  MAX_WEIGHT,
  MIN_PRIORITY,
  MIN_WEIGHT,
  keepaliveTag,
  modelsSummary,
  protocolLabel,
  statusHint,
  withConfigured,
  TEST_PROTOCOLS,
} from './shared.js'

// The archive is a shelf, not a working list: ten rows at a time is enough to
// find something in it without the panel taking over the page once expanded.
const ARCHIVED_PAGE_SIZE = 10

export function renderChannels(container) {
  let rows = []
  let total = 0
  let page = 1
  let pageSize = defaultPageSize()
  let keyword = ''
  let statusFilter = ''
  let groupFilter = ''
  let modelFilter = ''
  let groups = []
  let selected = new Set()
  let loading = true
  let disposed = false
  let requestSeq = 0
  let menus = []
  const expanded = new Set()

  let archivedRows = []
  let archivedTotal = 0
  let archivedPage = 1
  let archivedOpen = false
  let archivedLoading = false

  const listSlot = el('div')
  const pagerSlot = el('div')
  const bulkSlot = el('div')
  const archiveSlot = el('div')

  // ---- header ------------------------------------------------------------

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const rebuildButton = button({
    label: '重建路由',
    title: '按当前渠道配置重建 (分组 × 模型) 路由表',
    onClick: async () => {
      try {
        await api.admin.rebuild()
        toast.success('路由表已重建')
      } catch (error) {
        toast.error(errorText(error, '重建失败'))
      }
    },
  })
  const importButton = button({
    label: '快速导入',
    glyph: ICONS.import,
    onClick: () =>
      openQuickImport({ onApply: (channel, overrides) => openDrawer(channel, overrides) }),
  })
  const createButton = button({
    label: '新建渠道',
    variant: 'primary',
    glyph: ICONS.plus,
    onClick: () => openDrawer(),
  })

  // ---- filters -----------------------------------------------------------

  const search = searchInput({
    placeholder: '搜索名称、地址、模型、映射、分组、备注',
    onSearch: (value) => {
      keyword = value
      page = 1
      void load()
    },
  })
  search.style.width = '300px'

  const statusSelect = select({
    placeholder: '状态',
    ariaLabel: '按状态筛选',
    options: [
      { value: STATUS.ENABLED, label: '已启用' },
      { value: STATUS.DISABLED, label: '已禁用' },
    ],
    onChange: (value) => {
      statusFilter = value
      page = 1
      void load()
    },
  })
  statusSelect.style.width = '120px'

  const groupSelect = select({ placeholder: '分组', ariaLabel: '按分组筛选', options: [] })
  groupSelect.style.width = '150px'
  groupSelect.addEventListener('change', () => {
    groupFilter = groupSelect.value
    page = 1
    void load()
  })

  let modelTimer = null
  const modelBox = input({ placeholder: '按模型搜索，支持片段', ariaLabel: '按模型搜索' })
  modelBox.style.width = '180px'
  modelBox.addEventListener('input', () => {
    window.clearTimeout(modelTimer)
    modelTimer = window.setTimeout(() => {
      modelFilter = modelBox.value.trim()
      page = 1
      void load()
    }, 300)
  })

  const resetButton = button({
    label: '重置',
    variant: 'link',
    onClick: () => {
      search.clear()
      statusSelect.value = ''
      groupSelect.value = ''
      modelBox.value = ''
      keyword = ''
      statusFilter = ''
      groupFilter = ''
      modelFilter = ''
      page = 1
      void load()
    },
  })

  const isFiltered = () => Boolean(keyword || statusFilter || groupFilter || modelFilter)

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '渠道管理',
        description: '优先级高的渠道先被选中，同优先级内按权重随机；失败会自动切换到下一个渠道。',
        extra: [refreshButton, rebuildButton, importButton, createButton],
      }),
      el('div', { class: 'filter-bar' }, [search, statusSelect, groupSelect, modelBox, resetButton]),
      bulkSlot,
      listSlot,
      pagerSlot,
      archiveSlot,
    ]),
  )

  // ---- loading -----------------------------------------------------------

  async function load() {
    const seq = ++requestSeq
    loading = true
    refreshButton.setBusy(true)
    paint()

    try {
      const result = await api.admin.listChannels({
        page,
        page_size: pageSize,
        keyword,
        status: statusFilter === '' ? undefined : Number(statusFilter),
        group: groupFilter || undefined,
        model: modelFilter || undefined,
        // The listing is what serves traffic; the archive is folded away
        // below it. Asking for one side explicitly is also what makes the
        // reported total match the rows actually shown.
        archived: false,
      })
      if (seq !== requestSeq || disposed) return
      rows = result.data ?? []
      total = result.total ?? 0

      // Drop selections that scrolled out of the current result set, so a
      // bulk action can never touch a channel the operator can no longer see.
      const visible = new Set(rows.map((row) => row.id))
      selected = new Set([...selected].filter((id) => visible.has(id)))

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

  // Deliberately unfiltered: the boxes above narrow what currently serves
  // traffic, and an archived channel is by definition not that.
  async function loadArchived() {
    archivedLoading = true
    paintArchive()
    try {
      const result = await api.admin.listChannels({
        page: archivedPage,
        page_size: ARCHIVED_PAGE_SIZE,
        archived: true,
      })
      if (disposed) return
      archivedRows = result.data ?? []
      archivedTotal = result.total ?? 0

      // Taking the last row off a page would otherwise strand the panel on an
      // empty one, with no control visible to get back.
      const pages = Math.max(1, Math.ceil(archivedTotal / ARCHIVED_PAGE_SIZE))
      if (archivedPage > pages) {
        archivedPage = pages
        void loadArchived()
        return
      }
    } catch (error) {
      if (disposed) return
      toast.error(errorText(error, '加载已归档渠道失败'))
    } finally {
      if (!disposed) {
        archivedLoading = false
        paintArchive()
      }
    }
  }

  // Anything that can move a channel across the fold has to refresh both
  // sides, or one of the two lists keeps showing a row that is no longer its.
  const reloadAll = () => Promise.all([load(), loadArchived()])

  /** One row changed in place; the listing keeps its order and its scroll. */
  const patchRow = (updated) => {
    rows = rows.map((row) => (row.id === updated.id ? updated : row))
    paintList()
  }

  // ---- row actions -------------------------------------------------------

  function openDrawer(channel, overrides) {
    openChannelDrawer({
      channel,
      overrides,
      groupOptions: groups.map((group) => ({ value: group.name, label: group.name })),
      // Both sides: this form is also reachable from the archived panel.
      onSaved: reloadAll,
      onPatched: patchRow,
    })
  }

  async function fetchModels(channel) {
    const hide = toast.info(`正在从「${channel.name}」拉取模型列表…`, 60_000)
    try {
      const result = await api.admin.fetchModels(channel.id, false)
      hide()
      if (!result.count) {
        toast.warning('上游返回了空的模型列表')
        return
      }
      // Preselect exactly what the channel serves today — never everything
      // upstream offers. A blanket selection turns one stray click on 保存
      // into a hundred newly routed models.
      openModelPicker({
        channelName: channel.name,
        models: withConfigured(result.models, channel.models),
        upstream: result.models,
        initial: channel.models,
        verb: '保存',
        onApply: async (models, close) => {
          try {
            await api.admin.setChannelModels(channel.id, models)
            toast.success(`已为「${channel.name}」配置 ${models.length} 个模型`)
            close()
            await load()
          } catch (error) {
            toast.error(errorText(error, '保存失败'))
          }
        },
      })
    } catch (error) {
      hide()
      toast.error(errorText(error, '拉取失败'))
    }
  }

  async function setStatus(channel, status, control) {
    control?.setBusy(true)
    try {
      await api.admin.setChannelStatus(channel.id, status)
      toast.success(status === STATUS.ENABLED ? '渠道已启用' : '渠道已禁用')
      await load()
    } catch (error) {
      toast.error(errorText(error, '操作失败'))
      control?.setChecked(channel.status === STATUS.ENABLED)
    } finally {
      control?.setBusy(false)
    }
  }

  async function clearUserAgent(channel, protocol) {
    try {
      const updated = await api.admin.clearChannelUserAgent(channel.id, protocol)
      patchRow(updated)
      toast.success(`${channel.name} 的 ${protocolLabel(protocol)} UA 已清除`)
    } catch (error) {
      toast.error(errorText(error, '清除 UA 失败'))
    }
  }

  /**
   * Backs the two editable numbers in the table. Patches the one row instead
   * of reloading: the listing is ordered by priority, and a reload would move
   * the row out from under the cursor mid-edit.
   */
  async function saveRouting(channel, priority, weight) {
    try {
      const updated = await api.admin.setChannelRouting(channel.id, priority, weight)
      patchRow(updated)
      toast.success(`「${updated.name}」优先级 ${updated.priority}、权重 ${updated.weight}`)
    } catch (error) {
      toast.error(errorText(error, '保存失败'))
    }
  }

  /**
   * Retires a channel into the shelf below. The server disables it in the
   * same transaction, so the confirmation says so outright: archiving a
   * channel that is carrying traffic takes it out of rotation.
   */
  async function archiveChannel(channel) {
    const live = channel.status === STATUS.ENABLED
    const confirmed = await confirmModal({
      title: `归档渠道「${channel.name}」？`,
      description: live
        ? '该渠道当前已启用，归档会同时停用它，指向它的路由立即失效。配置与历史保留，可随时取消归档。'
        : '归档后从上方列表收起到「已归档」，配置与历史保留，可随时取消归档。',
      okText: '归档',
    })
    if (!confirmed) return
    try {
      await api.admin.setChannelArchived(channel.id, true)
      toast.success(`「${channel.name}」已归档`)
      await reloadAll()
    } catch (error) {
      toast.error(errorText(error, '归档失败'))
    }
  }

  // No confirmation: unarchiving restores a row and nothing else. The channel
  // comes back disabled, which the message states — otherwise the next thing
  // to happen is someone wondering why traffic never moved.
  async function unarchiveChannel(channel) {
    try {
      await api.admin.setChannelArchived(channel.id, false)
      toast.success(`「${channel.name}」已取消归档，状态仍为禁用`)
      await reloadAll()
    } catch (error) {
      toast.error(errorText(error, '取消归档失败'))
    }
  }

  async function removeChannel(channel) {
    const confirmed = await confirmModal({
      title: `删除渠道「${channel.name}」？`,
      description: '删除后指向该渠道的路由会立即失效，历史日志保留。',
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return
    try {
      await api.admin.deleteChannel(channel.id)
      toast.success('已删除')
      // Reachable from either table, so refresh both.
      await reloadAll()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    }
  }

  async function cloneChannel(channel) {
    try {
      const clone = await api.admin.cloneChannel(channel.id)
      // The copy points at the same upstream credential, so it is created
      // disabled: enabling it silently would double that upstream's share.
      toast.success(`已复制为「${clone.name}」，确认配置后再启用`)
      await load()
      openDrawer(clone)
    } catch (error) {
      toast.error(errorText(error, '复制失败'))
    }
  }

  /**
   * Puts the upstream connection on the clipboard, in the shape the quick
   * import box on this same page understands: address first, key second.
   * Fetched on demand — the listing only ever holds a masked key.
   */
  async function copyCredential(channel) {
    try {
      const cred = await api.admin.channelCredential(channel.id)
      const text = `${cred.base_url}\n${cred.api_key}`
      if (await copyText(text)) {
        toast.success(`已复制「${channel.name}」的地址与密钥`)
        return
      }
      // The clipboard refused (plain HTTP). Show the text rather than leaving
      // the operator with nothing.
      openModal({
        title: `「${channel.name}」的地址与密钥`,
        width: 560,
        body: el('pre', { class: 'code-block', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, text),
        footer: (close) => [button({ label: '关闭', variant: 'primary', onClick: close })],
      })
    } catch (error) {
      toast.error(errorText(error, '读取渠道信息失败'))
    }
  }

  async function showBalance(channel, kind) {
    const hide = toast.info(`正在通过 ${kind} 查询「${channel.name}」的余额…`, 60_000)
    try {
      const balance =
        kind === 'new-api'
          ? await api.admin.channelBalance(channel.id)
          : await api.admin.channelSub2APIBalance(channel.id)
      hide()
      if (!balance.ok) {
        toast.warning(balance.message || '该上游未提供余额接口')
        return
      }
      const money = (value) => (value === null ? '未提供' : `${balance.currency} ${value.toFixed(2)}`)
      const rows = [
        ['接口类型', balance.provider],
        ['剩余', money(balance.remaining_usd)],
        ['已用', money(balance.used_usd)],
        ['总额度', money(balance.total_usd)],
      ]
      if (balance.plan_name) rows.push(['套餐', balance.plan_name])
      openModal({
        title: `「${channel.name}」余额`,
        width: 440,
        body: el('dl', { class: 'desc' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
        footer: (close) => [button({ label: '关闭', variant: 'primary', onClick: close })],
      })
    } catch (error) {
      hide()
      toast.error(errorText(error, '查询失败'))
    }
  }

  // ---- bulk --------------------------------------------------------------

  async function runBulk(label, action) {
    try {
      toast.success(await action())
      selected = new Set()
      await load()
    } catch (error) {
      toast.error(errorText(error, `${label}失败`))
    }
  }

  const bulkStatus = (status) =>
    runBulk(status === STATUS.ENABLED ? '批量启用' : '批量禁用', async () => {
      const result = await api.admin.batchChannelStatus([...selected], status)
      return `${status === STATUS.ENABLED ? '已启用' : '已禁用'} ${result.updated} 个渠道`
    })

  async function bulkDelete() {
    const confirmed = await confirmModal({
      title: `删除选中的 ${selected.size} 个渠道？`,
      description: '删除后指向这些渠道的路由会立即失效，历史日志保留。',
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return
    await runBulk('批量删除', async () => {
      const result = await api.admin.batchDeleteChannels([...selected])
      return `已删除 ${result.deleted} 个渠道`
    })
  }

  // Not routed through runBulk: testing is read-only, and keeping the
  // selection lets "test, then disable the failures" happen in one pass.
  async function bulkTest() {
    const ids = [...selected]
    const hide = toast.info(`正在测试 ${ids.length} 个渠道…`, 120_000)
    try {
      const result = await api.admin.batchTestChannels(ids)
      hide()
      const failed = result.data.filter((item) => !item.ok)
      if (failed.length > 0) {
        openModal({
          title: `${result.passed}/${result.total} 个渠道通过`,
          width: 640,
          body: el(
            'pre',
            { class: 'code-block', style: { maxHeight: '360px' } },
            failed.map((item) => `${item.name || item.channel_id}: ${item.message || `HTTP ${item.status}`}`).join('\n'),
          ),
          footer: (close) => [button({ label: '关闭', variant: 'primary', onClick: close })],
        })
      }
      toast.success(`${result.passed}/${result.total} 个渠道测试通过`)
      await load()
    } catch (error) {
      hide()
      toast.error(errorText(error, '批量测试失败'))
    }
  }

  // ---- cells -------------------------------------------------------------

  function nameCell(row) {
    return el('div', { class: 'cell-stack' }, [
      el('strong', { class: 'truncate', title: row.name }, row.name),
      el('span', { class: 'mono text-muted text-small truncate', title: row.base_url }, row.base_url),
    ])
  }

  /**
   * Both counts lead, then the samples: the numbers are what the column is
   * scanned for and they sit at a fixed spot on every row, while the sample
   * chips are ragged and variable.
   */
  function modelsCell(row) {
    const list = row.models ?? []
    const mapped = Object.keys(row.model_mapping ?? {}).length
    const chips = [Object.assign(tag(`模型 ${list.length}`, 'brand'), { title: modelsSummary(list) })]
    if (mapped > 0) {
      chips.push(Object.assign(tag(`映射 ${mapped}`, 'brand'), { title: stringifyMapping(row.model_mapping) }))
    }
    for (const item of list.slice(0, 2)) {
      const chip = tag(item)
      chip.classList.add('mono', 'truncate')
      chip.title = item
      chips.push(chip)
    }
    return el('div', { class: 'tag-list' }, chips)
  }

  /**
   * A number read from the table that can also be changed there: a tag until
   * clicked, then a box. Commits on Enter or blur, reverts on Escape, and an
   * unchanged value never reaches the server — which is what stops merely
   * tabbing through the table from writing to every row it passes.
   */
  function inlineNumber({ value, prefix, label, hint, tone, min, max, onCommit }) {
    const holder = el('span')

    const showTag = () => {
      const chip = tag(`${prefix}${value}`, tone)
      chip.classList.add('tag--clickable')
      chip.setAttribute('role', 'button')
      chip.setAttribute('tabindex', '0')
      chip.setAttribute('aria-label', `${label} ${value}，点击修改`)
      chip.title = hint
      const open = () => showBox()
      chip.addEventListener('click', open)
      chip.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          // Space would otherwise scroll the page instead of opening the box.
          event.preventDefault()
          open()
        }
      })
      replace(holder, chip)
    }

    const showBox = () => {
      // Marks the edit as resolved. Escape has to win over the blur that
      // follows it, and disabling a focused input while it saves blurs it too
      // — without this, either would commit a second time.
      let done = false
      const box = el('input', { type: 'number', class: 'input inline-number', value: String(value), 'aria-label': label })
      box.min = String(min)
      box.max = String(max)

      const commit = async () => {
        if (done) return
        done = true
        // An emptied box is not a value: it means "leave this number alone".
        const typed = box.value.trim() === '' ? value : Number(box.value)
        const next = Math.round(Math.min(Math.max(Number.isNaN(typed) ? value : typed, min), max))
        if (next === value) {
          showTag()
          return
        }
        box.disabled = true
        try {
          await onCommit(next)
        } finally {
          // Back to the tag either way: on failure the row still holds the
          // server's value, and leaving an unfocused input open would strand
          // the cell with a number that was never saved.
          if (holder.isConnected) showTag()
        }
      }

      box.addEventListener('blur', () => void commit())
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void commit()
        else if (event.key === 'Escape') {
          done = true
          showTag()
        }
      })
      replace(holder, box)
      box.focus()
      box.select()
    }

    showTag()
    return holder
  }

  function routingCell(row) {
    return el('div', { class: 'cell-stack', style: { gap: '4px' } }, [
      inlineNumber({
        value: row.priority,
        prefix: 'P',
        label: '优先级',
        hint: '优先级：数值越大越先被选中。点击可直接修改',
        tone: 'brand',
        min: MIN_PRIORITY,
        max: MAX_PRIORITY,
        onCommit: (next) => saveRouting(row, next, row.weight),
      }),
      inlineNumber({
        value: row.weight,
        prefix: 'W',
        label: '权重',
        hint: '权重：同优先级内按权重随机分配。点击可直接修改',
        tone: null,
        min: MIN_WEIGHT,
        max: MAX_WEIGHT,
        onCommit: (next) => saveRouting(row, row.priority, next),
      }),
    ])
  }

  function healthCell(row) {
    const rate = row.request_count ? row.error_count / row.request_count : 0
    const node = el('span', { class: 'row', style: { gap: '4px', justifyContent: 'flex-end' } }, [
      rate > 0.2 && row.request_count > 5 && el('span', { class: 'text-danger', 'aria-label': '高失败率' }, icon(ICONS.alert, { size: 13 })),
      el('span', {}, formatNumber(row.request_count)),
      el('span', { class: 'text-faint' }, '/'),
      el('span', { class: row.error_count ? 'text-danger' : 'text-muted' }, formatNumber(row.error_count)),
    ])
    node.title = row.last_error
      ? `最近错误：${row.last_error}（${formatRelative(row.last_error_at)}）`
      : '暂无错误记录'
    return node
  }

  function statusCell(row) {
    const keep = keepaliveTag(row)
    return el('div', { class: 'stack', style: { gap: '4px', justifyItems: 'start' } }, [
      Object.assign(
        toggle({
          checked: row.status === STATUS.ENABLED,
          ariaLabel: `启用或禁用渠道 ${row.name}`,
          onChange: (checked, control) => {
            control.setChecked(checked)
            void setStatus(row, checked ? STATUS.ENABLED : STATUS.DISABLED, control)
          },
        }),
        { title: statusHint(row) },
      ),
      // Under the switch on purpose: this channel's status changes on its
      // own, and without a marker the next operator assumes a colleague did.
      keep && Object.assign(tag(keep.text, keep.tone), { title: keep.hint }),
    ])
  }

  function actionsCell(row) {
    const more = el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': `更多操作 ${row.name}`,
      'aria-haspopup': 'menu',
    })
    replace(more, icon(ICONS.more, { size: 16 }))

    const divider = () => el('div', { class: 'dropdown__divider' })
    // Editing first, then probes, copies, billing, with deletion at the end.
    const menu = dropdown(more, () => [
      menuItem({ label: '编辑渠道', glyph: ICONS.edit, onSelect: () => openDrawer(row) }),
      divider(),
      menuItem({ label: '模型测试', glyph: ICONS.bolt, onSelect: () => openTestDialog(row, { onTested: load }) }),
      menuItem({ label: '拉取模型', glyph: ICONS.download, onSelect: () => fetchModels(row) }),
      divider(),
      menuItem({ label: '复制地址与密钥', glyph: ICONS.copy, onSelect: () => copyCredential(row) }),
      menuItem({ label: '克隆渠道', glyph: ICONS.block, onSelect: () => cloneChannel(row) }),
      divider(),
      menuItem({ label: 'new-api 余额', glyph: ICONS.wallet, onSelect: () => showBalance(row, 'new-api') }),
      menuItem({ label: 'sub2api 余额', glyph: ICONS.wallet, onSelect: () => showBalance(row, 'sub2api') }),
      divider(),
      // Its own group next to deletion: both retire a channel, but only one
      // of them is irreversible.
      menuItem({ label: '归档渠道', glyph: ICONS.inbox, onSelect: () => archiveChannel(row) }),
      divider(),
      menuItem({ label: '删除渠道', glyph: ICONS.delete, danger: true, onSelect: () => removeChannel(row) }),
    ])
    menus.push(menu.destroy)
    return menu.node
  }

  // ---- expanded detail ---------------------------------------------------

  function detailRow(row) {
    const detailCard = (title, body, extra = null) =>
      el('div', { class: 'detail-card' }, [
        el('div', { class: 'detail-card__title' }, [title, extra]),
        el('div', { class: 'detail-card__body' }, body),
      ])

    const line = (text, cls = 'text-muted') => el('span', { class: cls }, text)

    const connection = [
      el('span', { class: 'mono' }, row.base_url),
      line(`密钥 ${row.api_key || '未设置'}`, 'mono text-muted'),
      row.proxy_url && line(`代理 ${row.proxy_url}`, 'mono text-muted'),
      line(`超时 ${row.timeout_secs ? `${row.timeout_secs}s` : '全局默认'} · 计费倍率 ×${row.price_ratio}`),
      line(`渠道重试 ${row.retry_count ? `${row.retry_count} 次` : '关闭'} · 间隔 ${row.retry_backoff_ms ? `${row.retry_backoff_ms}ms` : '全局默认'}`),
      line(`鉴权 ${AUTH_STYLES.find((item) => item.value === row.auth_style)?.label ?? row.auth_style}`),
      row.supported_protocols &&
        row.supported_protocols.length < 3 &&
        line(`协议 ${row.supported_protocols.map(protocolLabel).join(' / ')}`),
    ]

    const modelList = row.models.length
      ? el('pre', { class: 'code-block', style: { maxHeight: '120px', userSelect: 'text' } }, row.models.join('\n'))
      : line('未配置，仅按前缀匹配')
    const copyModels = row.models.length
      ? button({
          variant: 'icon',
          glyph: ICONS.copy,
          ariaLabel: '复制全部模型',
          onClick: async () => {
            if (await copyText(row.models.join('\n'))) toast.success('已复制全部模型')
          },
        })
      : null

    const uaRows = TEST_PROTOCOLS.map((protocol) => {
      const value = row.locked_user_agents?.[protocol.value] ?? ''
      return el('div', { class: 'row', style: { alignItems: 'flex-start' } }, [
        el('span', { class: 'text-muted', style: { minWidth: '92px' } }, protocol.label),
        el('span', { class: `mono truncate${value ? '' : ' text-faint'}`, style: { flex: '1' }, title: value || '尚未锁定' }, value || '尚未锁定'),
        Object.assign(
          button({
            variant: 'icon',
            glyph: ICONS.delete,
            disabled: !value,
            ariaLabel: `清除 ${protocol.label} User-Agent`,
            title: value ? '清除该协议的 UA 配置' : '当前没有可清除的 UA',
            onClick: () => clearUserAgent(row, protocol.value),
          }),
          { className: 'btn btn--icon btn--danger' },
        ),
      ])
    })
    const uaState = Object.values(row.locked_user_agents ?? {}).some(Boolean)

    return el('div', { class: 'detail-grid' }, [
      detailCard('连接', connection),
      detailCard(`模型（${row.models.length}）`, [modelList], copyModels),
      el('div', { class: 'stack', style: { gap: '12px' } }, [
        detailCard('模型映射', [
          el('pre', { class: 'code-block' }, stringifyMapping(row.model_mapping) || '未配置'),
        ]),
        detailCard('思考强度映射', [
          el('pre', { class: 'code-block' }, stringifyEffortRules(row.reasoning_effort_mapping) || '未配置'),
        ]),
      ]),
      detailCard('运行状态', [
        line(`最近测试：${row.tested_at ? formatTime(row.tested_at) : '从未测试'}`),
        line(`模型同步：${row.models_synced_at ? formatTime(row.models_synced_at) : '从未同步'}`),
        line(row.last_error || '无错误记录', row.last_error ? 'text-danger' : 'text-muted'),
        row.note && line(`备注：${row.note}`),
      ]),
      detailCard(
        'User-Agent 锁定',
        uaRows,
        el('span', { class: 'row', style: { gap: '4px', marginInlineStart: 'auto' } }, [
          row.lock_user_agent && tag('自动锁定', 'success'),
          uaState ? tag('已有配置', 'brand') : tag('暂无配置'),
        ]),
      ),
    ])
  }

  // ---- painting ----------------------------------------------------------

  function paintBulk() {
    if (selected.size === 0) {
      replace(bulkSlot, null)
      return
    }
    replace(
      bulkSlot,
      el('div', { class: 'row row--wrap', style: { marginBottom: '12px' } }, [
        // Paging or filtering drops invisible rows from the selection, so it
        // never covers more than the current page.
        el('span', { class: 'text-muted text-small' }, `已选 ${selected.size} 个渠道（仅当前页）`),
        button({ label: '批量启用', onClick: () => bulkStatus(STATUS.ENABLED) }),
        button({ label: '批量禁用', onClick: () => bulkStatus(STATUS.DISABLED) }),
        button({ label: '批量测试', glyph: ICONS.bolt, onClick: bulkTest }),
        button({ label: '批量删除', variant: 'danger', onClick: bulkDelete }),
        button({
          label: '取消选择',
          variant: 'link',
          onClick: () => {
            selected = new Set()
            paint()
          },
        }),
      ]),
    )
  }

  function emptyCopy() {
    if (isFiltered()) {
      return {
        title: '没有匹配的渠道',
        description:
          archivedTotal > 0
            ? `换个筛选条件试试。另有 ${archivedTotal} 个已归档渠道不参与筛选，展开下方「已归档」查看。`
            : '换个筛选条件试试。',
      }
    }
    if (archivedTotal > 0) {
      return { title: '没有在用的渠道', description: `${archivedTotal} 个渠道都已归档，展开下方「已归档」可恢复。` }
    }
    return { title: '还没有配置渠道', description: '至少需要一个启用的渠道，请求才能被转发出去。' }
  }

  function paintList() {
    for (const destroy of menus) destroy()
    menus = []
    resetButton.style.display = isFiltered() ? '' : 'none'

    if (loading && rows.length === 0) {
      replace(listSlot, card({ body: skeleton(6) }))
      replace(pagerSlot, null)
      return
    }

    const empty = emptyCopy()
    replace(
      listSlot,
      table({
        caption: '渠道列表',
        rowKey: (row) => row.id,
        rows,
        rowClass: (row) => (row.status !== STATUS.ENABLED ? 'row-disabled' : null),
        selection: {
          selected,
          rowId: (row) => row.id,
          onChange: (next) => {
            selected = next
            paint()
          },
        },
        expand: {
          opened: expanded,
          rowId: (row) => row.id,
          onToggle: (id) => {
            if (expanded.has(id)) expanded.delete(id)
            else expanded.add(id)
            paintList()
          },
          render: detailRow,
        },
        empty: emptyState({
          title: empty.title,
          description: empty.description,
          action: isFiltered()
            ? null
            : button({ label: '新建渠道', variant: 'primary', glyph: ICONS.plus, onClick: () => openDrawer() }),
        }),
        columns: [
          // The id is what the logs show, so it has to be findable here too.
          { key: 'id', title: 'ID', width: 72, render: (row) => Object.assign(tag(`#${row.id}`), { className: 'tag mono' }) },
          { key: 'name', title: '渠道', width: 300, render: nameCell },
          { key: 'models', title: '模型', width: 260, at: 'md', render: modelsCell },
          { key: 'routing', title: '优先 / 权重', width: 80, at: 'md', render: routingCell },
          {
            key: 'groups',
            title: '分组',
            width: 100,
            at: 'lg',
            render: (row) => el('div', { class: 'tag-list' }, (row.groups ?? []).map((group) => tag(group))),
          },
          { key: 'health', title: '调用 / 失败', width: 120, at: 'lg', align: 'right', render: healthCell },
          { key: 'usedQuota', title: '消费', width: 90, at: 'lg', align: 'right', render: (row) => formatMoney(row.used_quota) },
          // No breakpoint: this is a control, and taking a bad channel out of
          // rotation should not require widening the window first.
          { key: 'status', title: '状态', width: 104, render: statusCell },
          { key: 'actions', title: '操作', width: 72, render: actionsCell },
        ],
      }),
    )

    replace(
      pagerSlot,
      pagination({
        page,
        pageSize,
        total,
        unit: '个渠道',
        onChange: (nextPage, nextSize) => {
          page = nextPage
          pageSize = nextSize
          void load()
        },
      }),
    )
  }

  /**
   * Archived channels are configuration worth keeping, not part of what
   * serves traffic, so they should not cost listing space. The panel is
   * absent entirely until something is in it.
   */
  function paintArchive() {
    if (archivedTotal === 0 && !archivedLoading) {
      replace(archiveSlot, null)
      return
    }

    const head = el(
      'button',
      {
        type: 'button',
        class: 'disclosure__head',
        'aria-expanded': archivedOpen ? 'true' : 'false',
        onclick: () => {
          archivedOpen = !archivedOpen
          paintArchive()
        },
      },
      [
        Object.assign(el('span', { class: `expand-toggle${archivedOpen ? ' expand-toggle--open' : ''}` }, icon(ICONS.chevronRight, { size: 12 }))),
        el('strong', {}, '已归档'),
        tag(String(archivedTotal)),
        el('span', { class: 'text-muted text-small' }, '均已停用、不参与路由；配置与历史保留'),
      ],
    )

    let body = null
    if (archivedOpen) {
      body = el('div', { class: 'disclosure__body' }, [
        archivedLoading && archivedRows.length === 0
          ? skeleton(3)
          : table({
              caption: '已归档渠道',
              rowKey: (row) => row.id,
              rows: archivedRows,
              empty: emptyState({ title: '没有已归档的渠道', compact: true }),
              columns: [
                { key: 'id', title: 'ID', width: 72, render: (row) => Object.assign(tag(`#${row.id}`), { className: 'tag mono' }) },
                { key: 'name', title: '渠道', render: nameCell },
                { key: 'models', title: '模型', width: 84, at: 'md', render: (row) => tag(`模型 ${row.models.length}`, 'brand') },
                { key: 'usedQuota', title: '消费', width: 90, at: 'lg', align: 'right', render: (row) => formatMoney(row.used_quota) },
                {
                  key: 'actions',
                  title: '操作',
                  width: 200,
                  // Plain buttons rather than the listing's ⋯ menu: three
                  // actions on a short list are better shown than hidden.
                  render: (row) =>
                    el('div', { class: 'table__actions' }, [
                      button({ label: '取消归档', variant: 'text', glyph: ICONS.rollback, title: '恢复到上方列表，状态仍为禁用', onClick: () => unarchiveChannel(row) }),
                      button({ variant: 'icon', glyph: ICONS.edit, ariaLabel: `编辑渠道 ${row.name}`, title: '编辑渠道', onClick: () => openDrawer(row) }),
                      Object.assign(
                        button({ variant: 'icon', glyph: ICONS.delete, ariaLabel: `删除渠道 ${row.name}`, title: '删除渠道', onClick: () => removeChannel(row) }),
                        { className: 'btn btn--icon btn--danger' },
                      ),
                    ]),
                },
              ],
            }),
        archivedTotal > ARCHIVED_PAGE_SIZE &&
          pagination({
            page: archivedPage,
            pageSize: ARCHIVED_PAGE_SIZE,
            total: archivedTotal,
            unit: '个已归档渠道',
            onChange: (next) => {
              archivedPage = next
              void loadArchived()
            },
          }),
      ])
    }

    replace(archiveSlot, el('div', { class: 'disclosure', style: { marginTop: '12px' } }, [head, body]))
  }

  function paint() {
    paintBulk()
    paintList()
  }

  api.admin
    .listGroups()
    .then((result) => {
      groups = result.data ?? []
      groupSelect.replaceChildren(
        el('option', { value: '' }, '分组'),
        ...groups.map((group) => el('option', { value: group.name }, `${group.name}（×${group.rate}）`)),
      )
    })
    .catch(() => {
      groups = []
    })

  paint()
  void load()
  void loadArchived()

  return () => {
    disposed = true
    search.stop()
    window.clearTimeout(modelTimer)
    for (const destroy of menus) destroy()
    menus = []
  }
}
