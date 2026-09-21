/**
 * The call log: every relayed request, newest first, with a live feed on top.
 *
 * One component for two pages. A regular user sees their own calls; an
 * administrator sees everyone's, plus what is running right now, the bodies
 * each call carried, and a way to stop one that is stuck.
 *
 * The feed only makes sense on the first page of a newest-first list: on any
 * other page every arrival would shift the rows being read. Nothing is lost —
 * a counter says how many piled up, and page one is a click away.
 */

import { el, icon, on, replace, watchMedia } from '../../driver/dom.js'
import { openStream } from '../../driver/stream.js'
import { api } from '../../core/api.js'
import { defaultPageSize } from '../../core/settings.js'
import { formatCompact, formatNumber } from '../../core/format.js'
import { button, card, dateTimeInput, input, pageHeader, searchInput, select, toggle } from '../../ui/controls.js'
import { dropdown, menuItem } from '../../ui/dropdown.js'
import { emptyState, skeleton } from '../../ui/feedback.js'
import { confirmModal } from '../../ui/modal.js'
import { pagination } from '../../ui/pagination.js'
import { ICONS } from '../../ui/icons.js'
import { errorText, toast } from '../../ui/toast.js'
import { openLogDetail } from './detail.js'
import { createInflight } from './inflight.js'
import { createLiveRate } from './liveRate.js'
import { createLogTable } from './table.js'

const DEBOUNCE_MS = 300
const PHONE_QUERY = '(max-width: 768px)'

const PURGE_OPTIONS = [7, 30, 90]

// ---- entry points ---------------------------------------------------------

export function renderLogs(container) {
  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '调用日志',
        description: '每一行都是一次真实转发，点击可查看渠道、用量、耗时与错误详情。',
      }),
    ]),
  )
  return renderLogTable(container.firstElementChild, { admin: false, fetcher: api.logs })
}

export function renderAdminLogs(container) {
  let reload = null

  const trigger = el('button', { type: 'button', class: 'btn btn--danger', 'aria-haspopup': 'menu' }, [
    icon(ICONS.delete, { size: 15 }),
    el('span', {}, '清理历史日志'),
    icon(ICONS.down, { size: 10 }),
  ])
  const purgeMenu = dropdown(trigger, () =>
    PURGE_OPTIONS.map((days) =>
      menuItem({
        label: `清理 ${days} 天前`,
        danger: true,
        onSelect: async () => {
          const confirmed = await confirmModal({
            title: `清理 ${days} 天前的日志？`,
            description:
              '调用记录和随之保留的请求正文都会被删除，无法恢复，统计图表中的历史数据也会一并消失。',
            okText: '确认清理',
            danger: true,
          })
          if (!confirmed) return
          try {
            const result = await api.admin.purgeLogs(days)
            toast.success(`已清理 ${result.deleted} 条记录`)
            // A data-only reload: the operator's filters and page survive.
            reload?.()
          } catch (error) {
            toast.error(errorText(error, '清理失败'))
          }
        },
      }),
    ),
  )

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '全局日志',
        description: '全部用户的逐次调用记录与完整正文。',
        extra: purgeMenu.node,
      }),
    ]),
  )

  const dispose = renderLogTable(container.firstElementChild, {
    admin: true,
    showRate: true,
    fetcher: api.admin.logs,
    onReady: (api) => {
      reload = api.reload
    },
  })

  return () => {
    purgeMenu.destroy()
    dispose()
  }
}

// ---- the table page -------------------------------------------------------

function renderLogTable(container, { admin, showRate = false, fetcher, onReady = null }) {
  let rows = []
  let total = 0
  let page = 1
  let pageSize = defaultPageSize()
  let loadError = null
  let disposed = false
  // Overlapping fetches race (slow filter query vs fast one); only the newest
  // request may write state.
  let requestSeq = 0

  // filters
  let keyword = ''
  let model = ''
  let tokenName = ''
  let username = ''
  let channelID = ''
  let onlyError = false
  let range = null

  // stream
  let live = true
  let streamState = 'offline'
  let stopStream = null
  let currentStreamURL = null
  // Settled rows that arrived while not on page one.
  let pending = 0
  // While the pointer is over the table, live arrivals are parked instead of
  // inserted: rows that keep sliding away from the cursor cannot be clicked.
  let hovering = false
  let hoverBuffer = []
  let tickTimer = null

  const phone = watchMedia(PHONE_QUERY, () => {
    // The two layouts are different tables; rebuild on crossing the line.
    rebuildTable()
  })

  // ---- derived ------------------------------------------------------------

  const canStream = () => live && page === 1 && !range
  const streamEnabled = () => live && !range
  // Reserved for the global board. On one account's page nearly every row
  // would flicker through a placeholder without telling anyone anything.
  const showLive = () => admin && canStream()
  const rateActive = () => Boolean(showRate && admin && page === 1 && live && !range)
  const isFiltered = () => Boolean(keyword || model || tokenName || username || channelID || onlyError || range)

  // The stream carries the same filters as the list, so what arrives live is
  // what a reload would show. A time range is the exception: it bounds
  // history, while the feed is always "now".
  const streamURL = () => {
    const params = new URLSearchParams()
    if (keyword) params.set('keyword', keyword)
    if (model) params.set('model', model)
    if (tokenName) params.set('token_name', tokenName)
    if (admin && username) params.set('username', username)
    if (Number(channelID) > 0) params.set('channel_id', channelID)
    if (onlyError) params.set('only_error', 'true')
    const query = params.toString()
    return `${admin ? '/api/admin/logs/stream' : '/api/logs/stream'}${query ? `?${query}` : ''}`
  }

  // ---- pieces -------------------------------------------------------------

  const rate = createLiveRate({ onTick: paintRate })

  const inflight = createInflight({
    isFrozen: () => hovering,
    onChange: () => {
      if (showLive()) table.setLive(inflight.rows())
      paintRate()
      syncTick()
    },
  })

  let table = null
  const tableSlot = el('div')
  const pagerSlot = el('div')
  const rateSlot = el('div')
  const noticeSlot = el('span', { class: 'row', style: { gap: '8px' } })

  function rebuildTable() {
    table?.destroy()
    table = createLogTable({
      admin,
      phone: phone.matches(),
      onOpen: (row) => openLogDetail(row, { admin }),
      onCancel: cancelCall,
      empty: emptyBody,
    })
    table.setPageSize(pageSize)
    table.paint(rows)
    if (showLive()) table.setLive(inflight.rows())

    // Pointer events, filtered to mice: a touch tap synthesizes mouseenter
    // with no matching leave, which would park the stream forever.
    table.node.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') hovering = true
    })
    table.node.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse') return
      hovering = false
      flushHoverBuffer()
    })
    replace(tableSlot, table.node)
  }

  function emptyBody() {
    if (loadError) {
      return emptyState({
        title: '加载失败',
        description: loadError,
        action: button({ label: '重试', variant: 'primary', glyph: ICONS.reload, onClick: () => load() }),
      })
    }
    return emptyState({
      title: '没有匹配的调用记录',
      description: isFiltered() ? '试试放宽筛选条件或时间范围。' : '发起一次请求后这里就会有记录。',
    })
  }

  async function cancelCall(key) {
    try {
      await api.admin.cancelInflight(key)
      // "发出" rather than "已取消": the row settles when the request
      // goroutine unwinds, which is the event worth believing.
      toast.success('已发出取消')
    } catch (error) {
      const text = errorText(error, '取消失败')
      // Losing the race with a call that finished on its own is the ordinary
      // outcome of pressing cancel late, not a fault to alarm anyone with.
      if (text.includes('已经结束')) toast.info(text)
      else toast.error(text)
    }
  }

  // ---- loading ------------------------------------------------------------

  /** silent: refresh without the loading veil — used by stream reconnects. */
  async function load(silent = false) {
    const seq = ++requestSeq
    if (!silent) {
      refreshButton.setBusy(true)
      if (rows.length === 0) replace(tableSlot, card({ body: skeleton(8) }))
    }

    try {
      const result = await fetcher({
        page,
        page_size: pageSize,
        keyword: keyword || undefined,
        model: model || undefined,
        token_name: tokenName || undefined,
        username: admin && username ? username : undefined,
        channel_id: Number(channelID) > 0 ? Number(channelID) : undefined,
        only_error: onlyError || undefined,
        start: range?.[0],
        end: range?.[1],
      })
      if (seq !== requestSeq || disposed) return

      rows = result.data ?? []
      total = result.total ?? 0
      loadError = null
      // Anything parked during a hover is part of the truth just fetched;
      // flushing it later would push stale rows into the fresh page.
      hoverBuffer = []

      // A purge can strand a deep page past the end; walk back.
      if (rows.length === 0 && total > 0 && page > 1) {
        page = Math.max(1, Math.ceil(total / pageSize))
        void load()
        return
      }

      if (page === 1 && rateActive()) rate.seed(rows)
    } catch (error) {
      if (seq !== requestSeq || disposed) return
      // Both surfaces on purpose: the empty-state branch is invisible while
      // stale rows are still on screen, and the toast alone evaporates.
      loadError = errorText(error, '加载失败')
      toast.error(loadError)
    } finally {
      if (seq === requestSeq && !disposed) {
        refreshButton.setBusy(false)
        if (!table || !table.node.isConnected) rebuildTable()
        else {
          table.paint(rows)
          if (showLive()) table.setLive(inflight.rows())
        }
        paintPager()
        paintNotices()
        paintRate()
      }
    }
  }

  // ---- stream -------------------------------------------------------------

  function flushHoverBuffer() {
    inflight.publish()
    if (hoverBuffer.length === 0) return
    const buffered = hoverBuffer
    hoverBuffer = []
    // Live entries only belong at the top of the first page.
    if (page !== 1) return
    for (const entry of buffered) table.prepend(entry)
    paintNotices()
  }

  function onEntry(entry, key) {
    // Retire the placeholder first, and on every page: the settled row is the
    // same call, and listing it twice is the one outcome worth ruling out.
    if (key) inflight.retire(key)
    if (page !== 1) {
      pending += 1
      paintNotices()
      return
    }
    // The list request may already have returned this row; the stream and
    // the initial fetch race by design.
    if (table.hasRow(entry.id)) return
    total += 1
    rate.add(entry)
    if (admin && hovering) {
      if (!hoverBuffer.some((row) => row.id === entry.id)) hoverBuffer.push(entry)
      paintNotices()
      return
    }
    rows = [entry, ...rows].slice(0, pageSize)
    table.prepend(entry)
    paintPager()
    paintRate()
  }

  function restartStream() {
    const url = streamURL()
    const enabled = streamEnabled()
    if (stopStream && currentStreamURL === url && enabled) return

    stopStream?.()
    stopStream = null
    currentStreamURL = null
    // A new stream is a new set: the filters it was opened with decide what
    // gets announced, so rows admitted by the previous ones are no longer
    // news. The server states whatever is still running on connect.
    inflight.reset()

    if (!enabled) {
      streamState = 'offline'
      paintLiveBadge()
      return
    }

    currentStreamURL = url
    stopStream = openStream({
      url,
      onState: (state) => {
        streamState = state
        paintLiveBadge()
      },
      onEvent: (name, payload) => {
        if (disposed) return
        if (name === 'inflight_sync') {
          const calls = payload?.calls
          if (Array.isArray(calls) && admin) inflight.sync(calls.filter((call) => call?.entry))
          return
        }
        const { key = '', entry } = payload ?? {}
        if (!entry) return
        if (name === 'inflight') {
          if (admin) inflight.announce(key, entry)
        } else {
          onEntry(entry, key)
        }
      },
      onReconnect: () => {
        // Quietly reload the first page to recover entries published while
        // the connection was down. Whatever was running then may well have
        // finished; the reconnect is answered with a fresh set.
        if (page === 1) void load(true)
        inflight.reset()
      },
    })
  }

  /** A running call's only moving part is how long it has been running. */
  function syncTick() {
    const wanted = showLive() && inflight.rows().length > 0
    if (wanted && !tickTimer) {
      tickTimer = window.setInterval(() => table?.tick(), 1000)
    } else if (!wanted && tickTimer) {
      window.clearInterval(tickTimer)
      tickTimer = null
    }
  }

  // ---- filters ------------------------------------------------------------

  const debounced = (apply) => {
    let timer = null
    return (value) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        apply(value)
        page = 1
        void load()
        restartStream()
      }, DEBOUNCE_MS)
    }
  }

  const search = searchInput({
    placeholder: admin ? '搜索 ID、用户、密钥、模型、渠道、IP、错误' : '搜索 ID、密钥、模型、接口、错误',
    ariaLabel: '搜索日志',
    onSearch: (value) => {
      keyword = value
      page = 1
      void load()
      restartStream()
    },
  })
  search.style.width = '300px'

  const prefixed = (glyph, options) => {
    const control = input(options)
    const wrap = el('div', { class: 'input-affix' }, [
      el('span', { class: 'input-affix__icon' }, glyph ? icon(glyph, { size: 14 }) : el('span', { class: 'text-muted' }, '#')),
      control,
    ])
    wrap.control = control
    return wrap
  }

  const modelBox = prefixed(ICONS.robot, { placeholder: '模型', ariaLabel: '按模型过滤' })
  modelBox.style.width = '160px'
  modelBox.control.addEventListener('input', debounced(() => { model = modelBox.control.value.trim() }))

  const tokenBox = prefixed(ICONS.key, { placeholder: '令牌', ariaLabel: '按令牌名过滤' })
  tokenBox.style.width = '140px'
  tokenBox.control.addEventListener('input', debounced(() => { tokenName = tokenBox.control.value.trim() }))

  const userBox = admin ? prefixed(ICONS.user, { placeholder: '用户名', ariaLabel: '按用户名过滤' }) : null
  if (userBox) {
    userBox.style.width = '150px'
    userBox.control.addEventListener('input', debounced(() => { username = userBox.control.value.trim() }))
  }

  const channelBox = prefixed(null, { placeholder: '渠道 ID', ariaLabel: '按渠道 ID 过滤，仅支持数字' })
  channelBox.style.width = '110px'
  channelBox.control.addEventListener('input', () => {
    channelBox.control.value = channelBox.control.value.replace(/\D/g, '')
  })
  channelBox.control.addEventListener('input', debounced(() => { channelID = channelBox.control.value }))

  const resultSelect = select({
    value: 'all',
    ariaLabel: '按结果过滤',
    options: [
      { value: 'all', label: '全部请求' },
      { value: 'error', label: '仅失败' },
    ],
    onChange: (value) => {
      onlyError = value === 'error'
      page = 1
      void load()
      restartStream()
    },
  })
  resultSelect.style.width = '110px'

  const rangeBox = rangePicker({
    onChange: (next) => {
      range = next
      page = 1
      void load()
      restartStream()
      paintLiveBadge()
    },
  })

  const resetButton = button({
    label: '重置',
    variant: 'link',
    onClick: () => {
      search.clear()
      modelBox.control.value = ''
      tokenBox.control.value = ''
      if (userBox) userBox.control.value = ''
      channelBox.control.value = ''
      resultSelect.value = 'all'
      rangeBox.clear()
      keyword = ''
      model = ''
      tokenName = ''
      username = ''
      channelID = ''
      onlyError = false
      range = null
      page = 1
      void load()
      restartStream()
      paintLiveBadge()
    },
  })

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })

  // ---- live toggle --------------------------------------------------------

  const liveSwitch = toggle({
    checked: live,
    ariaLabel: '实时推送',
    onChange: (checked, control) => {
      control.setChecked(checked)
      live = checked
      // Re-enabling reconnects a fresh stream, which cannot know what it
      // missed; reload the first page to close the gap.
      if (checked && page === 1) void load()
      restartStream()
      paintLiveBadge()
      paintRate()
      syncTick()
    },
  })
  const liveDot = el('span', { class: 'live-dot' })
  const liveText = el('span', { class: 'text-muted text-small' })
  const liveToggle = el('label', { class: 'live-toggle' }, [liveSwitch, liveDot, liveText])

  function paintLiveBadge() {
    liveSwitch.disabled = Boolean(range)
    liveToggle.title = range ? '选择了时间范围，实时推送已暂停' : '由服务端推送新记录，无需轮询'
    liveToggle.style.cursor = range ? 'not-allowed' : 'pointer'

    let state = 'idle'
    let text = '实时推送'
    if (live && !range) {
      if (streamState === 'live') {
        state = 'live'
        text = canStream() ? '实时推送中' : '已暂停（非首页）'
      } else if (streamState === 'connecting') {
        state = 'connecting'
        text = '连接中…'
      } else {
        state = 'offline'
        text = '已断开，重试中'
      }
    }
    liveDot.className = `live-dot live-dot--${state}`
    liveText.textContent = text
  }

  // ---- rate chips ---------------------------------------------------------

  const rpmChip = showRate && admin ? rateChip({ label: 'RPM' }) : null
  const tpmChip = showRate && admin ? rateChip({ label: 'TPM', format: formatCompact }) : null
  const concurrencyChip = showRate && admin ? rateChip({ label: '并发' }) : null

  function paintRate() {
    if (!rpmChip) return
    const active = rateActive()
    let idle = '实时推送已关闭'
    if (live) idle = range ? '已选时间范围' : '非首页'
    rpmChip.set(rate.rpm(), active, idle)
    tpmChip.set(rate.tpm(), active, idle)
    // Not a sample of the page like the two beside it: the feed states the
    // whole running set, so this stays right on page four. Hence its own
    // active condition — the feed being connected, not the first page.
    concurrencyChip.set(
      inflight.size(),
      admin && streamEnabled(),
      live ? '已选时间范围' : '实时推送已关闭',
      '此刻已转发给上游、尚未结束的调用数 · 跟随筛选条件',
    )
  }

  // ---- layout -------------------------------------------------------------

  const filterBar = el('div', { class: 'filter-bar' }, [
    search,
    modelBox,
    tokenBox,
    userBox,
    channelBox,
    resultSelect,
    rangeBox.node,
    resetButton,
    refreshButton,
    !(showRate && admin) && liveToggle,
    noticeSlot,
  ])

  if (showRate && admin) {
    replace(rateSlot, el('div', { class: 'row row--wrap', style: { marginBottom: '12px' } }, [
      rpmChip.node,
      tpmChip.node,
      concurrencyChip.node,
      liveToggle,
    ]))
  }

  container.append(rateSlot, filterBar, tableSlot, pagerSlot)

  function paintNotices() {
    resetButton.style.display = isFiltered() ? '' : 'none'
    replace(noticeSlot, [
      pending > 0 &&
        button({
          label: `有 ${pending} 条新记录`,
          variant: 'link',
          onClick: () => {
            page = 1
            pending = 0
            void load()
            restartStream()
          },
        }),
      hoverBuffer.length > 0 &&
        el('span', { class: 'text-muted text-small' }, `${hoverBuffer.length} 条新记录待插入（悬停时暂停）`),
    ])
  }

  function paintPager() {
    replace(
      pagerSlot,
      pagination({
        page,
        pageSize,
        total,
        unit: '条',
        onChange: (nextPage, nextSize) => {
          page = nextPage
          pageSize = nextSize
          table.setPageSize(nextSize)
          // Returning to the first page adopts whatever accumulated while
          // away.
          if (page === 1) pending = 0
          void load()
          // Paging on or off page one changes whether placeholders are drawn.
          if (showLive()) table.setLive(inflight.rows())
          else table.setLive([])
          paintLiveBadge()
          paintRate()
          syncTick()
        },
      }),
    )
  }

  // ---- start --------------------------------------------------------------

  rebuildTable()
  paintNotices()
  paintLiveBadge()
  paintRate()
  if (rpmChip) rate.start()
  void load()
  restartStream()

  const offVisibility = on(document, 'visibilitychange', () => {
    // A tab that was hidden for a while has a stale first page; the stream
    // reconnect handles the gap, but only if it dropped.
    if (document.visibilityState === 'visible' && page === 1 && streamEnabled()) void load(true)
  })

  onReady?.({ reload: () => load(true) })

  return () => {
    disposed = true
    stopStream?.()
    rate.stop()
    phone.stop()
    offVisibility()
    if (tickTimer) window.clearInterval(tickTimer)
    table?.destroy()
    rangeBox.destroy()
  }
}

// ---- pieces ---------------------------------------------------------------

/**
 * One live meter, sized to sit in a toolbar. The number eases toward each
 * new reading and kicks when it changes, so the chip reads as alive at a
 * glance without taking space from the table it describes.
 */
function rateChip({ label, format = formatNumber }) {
  const value = el('span', { class: 'rate-chip__value' }, '0')
  const node = el('div', { class: 'rate-chip' }, [
    el('span', { class: 'rate-chip__dot' }),
    el('span', { class: 'rate-chip__label' }, label),
    value,
  ])

  let shown = 0
  let target = 0
  let frame = 0
  let bumpTimer = null
  const WINDOW_HINT = '滚动 60 秒窗口 · 仅统计当前首页可见记录'

  const tween = () => {
    cancelAnimationFrame(frame)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown = target
      value.textContent = format(shown)
      return
    }
    const from = shown
    const start = performance.now()
    const step = (now) => {
      const progress = Math.min(1, (now - start) / 520)
      // easeOutCubic: quick off the mark, soft landing.
      const eased = 1 - (1 - progress) ** 3
      shown = Math.round(from + (target - from) * eased)
      value.textContent = format(shown)
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }

  return {
    node,
    set(next, active, idleHint, activeHint = WINDOW_HINT) {
      const wanted = active ? next : 0
      node.classList.toggle('rate-chip--live', active)
      node.title = active ? activeHint : idleHint
      if (wanted === target) return
      target = wanted
      tween()
      if (!active) return
      value.classList.add('rate-chip__value--bump')
      window.clearTimeout(bumpTimer)
      bumpTimer = window.setTimeout(() => value.classList.remove('rate-chip__value--bump'), 460)
    },
  }
}

/**
 * A time range: two clock fields and a preset menu.
 *
 * `onChange` receives [startISO, endISO] or null. Presets fill the two boxes
 * rather than replacing them, so what gets sent is always what is visible.
 */
function rangePicker({ onChange }) {
  const start = dateTimeInput({})
  const end = dateTimeInput({})
  start.setAttribute('aria-label', '开始时间')
  end.setAttribute('aria-label', '结束时间')
  start.style.width = end.style.width = '175px'

  const local = (date) => {
    const pad = (v) => String(v).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const PRESETS = [
    { value: '', label: '时间范围' },
    { value: '1h', label: '最近 1 小时' },
    { value: 'today', label: '今天' },
    { value: '7d', label: '最近 7 天' },
    { value: '30d', label: '最近 30 天' },
  ]

  const emit = () => onChange(start.readISO() && end.readISO() ? [start.readISO(), end.readISO()] : null)

  const preset = select({
    value: '',
    ariaLabel: '时间范围预设',
    options: PRESETS,
    onChange: (key) => {
      const now = new Date()
      let from = null
      if (key === '1h') from = new Date(now.getTime() - 3600_000)
      else if (key === 'today') {
        from = new Date(now)
        from.setHours(0, 0, 0, 0)
      } else if (key === '7d') from = new Date(now.getTime() - 7 * 86400_000)
      else if (key === '30d') from = new Date(now.getTime() - 30 * 86400_000)

      if (!from) {
        start.value = ''
        end.value = ''
      } else {
        start.value = local(from)
        end.value = local(now)
      }
      emit()
    },
  })
  preset.style.width = '130px'

  // Typing a bound by hand detaches it from whichever preset filled it.
  const manual = () => {
    preset.value = ''
    emit()
  }
  start.addEventListener('change', manual)
  end.addEventListener('change', manual)

  const node = el('div', { class: 'row', style: { gap: '4px' } }, [preset, start, el('span', { class: 'text-faint' }, '–'), end])

  return {
    node,
    clear() {
      preset.value = ''
      start.value = ''
      end.value = ''
    },
    destroy() {},
  }
}
