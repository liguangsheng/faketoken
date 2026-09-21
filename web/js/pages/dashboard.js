/**
 * The dashboard: usage, spend and account balance over a chosen window.
 */

import { el, icon, replace } from '../driver/dom.js'
import { api } from '../core/api.js'
import * as sessionStore from '../core/session.js'
import * as router from '../core/router.js'
import {
  formatCompact,
  formatDayTime,
  formatHour,
  formatMoney,
  formatNumber,
  formatPercent,
  formatUSD,
  toUSD,
} from '../core/format.js'
import { button, card, pageHeader, segmented } from '../ui/controls.js'
import { emptyState, skeletonCard } from '../ui/feedback.js'
import { usageChart } from '../ui/chart.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

// Zero represents today; the other values are rolling backend windows.
const RANGES = [
  { value: 0, label: '今日' },
  { value: 1, label: '24 小时' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

export function renderDashboard(container) {
  let days = 0
  let stats = null
  let error = null
  let loading = true
  let chart = null

  // Requests race: switching from a slow 90-day query to a fast one must not
  // let the stale answer land last and overwrite the fresh one.
  let requestSeq = 0
  let disposed = false

  const statsGrid = el('div', { class: 'grid grid--stats' })
  const chartSlot = el('div')
  const ranksGrid = el('div', { class: 'grid grid--ranks mt-12' })

  const refreshButton = button({
    label: '刷新',
    glyph: ICONS.reload,
    onClick: () => load(),
  })

  const rangeSwitch = segmented({
    options: RANGES,
    value: days,
    onChange: (value) => {
      days = Number(value)
      void load()
    },
  })

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '仪表盘',
        description: sessionStore.isAdmin()
          ? '全站的调用量、消费与渠道健康度'
          : '你的调用量、消费与账户余额',
        extra: [rangeSwitch, refreshButton],
      }),
      statsGrid,
      chartSlot,
      ranksGrid,
    ]),
  )

  /** Bucket boundaries follow the window: hours for a day or two, else days. */
  const params = () => {
    if (days === 0) {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      return { start: start.toISOString(), interval: 'hour' }
    }
    return { days, interval: days <= 2 ? 'hour' : 'day' }
  }

  async function load() {
    const seq = ++requestSeq
    loading = true
    paint()

    try {
      const result = sessionStore.isAdmin()
        ? await api.admin.stats(params())
        : await api.stats(params())
      if (seq !== requestSeq || disposed) return
      stats = result
      error = null
    } catch (caught) {
      if (seq !== requestSeq || disposed) return
      error = errorText(caught, '加载失败')
      toast.error(error)
    } finally {
      if (seq === requestSeq && !disposed) {
        loading = false
        paint()
      }
    }
  }

  function series() {
    const hourly = days <= 2
    return (stats?.series ?? []).map((point) => ({
      label: hourly ? formatHour(point.bucket) : formatDayTime(point.bucket, false),
      fullLabel: hourly ? formatDayTime(point.bucket) : formatDayTime(point.bucket, false),
      requests: point.requests,
      errors: point.errors,
      costUsd: toUSD(point.cost),
    }))
  }

  function paint() {
    const user = sessionStore.getUser()
    const admin = sessionStore.isAdmin()
    const summary = stats?.summary
    const requests = summary?.requests ?? 0
    const errors = summary?.errors ?? 0
    const cost = summary?.cost ?? 0
    const tokens = summary?.total_tokens ?? 0
    const successRate = requests ? (requests - errors) / requests : 1
    const firstLoad = loading && !stats
    const quota = user?.quota ?? 0
    const quotaEmpty = quota <= 0

    refreshButton.setBusy(loading)

    // ---- stat cards
    const cards = [
      statCard({
        label: admin ? '我的余额' : '账户余额',
        value: formatMoney(quota),
        hint: quotaEmpty
          ? el('span', { class: 'text-danger' }, '余额已用尽，请充值后再调用')
          : `累计消费 ${formatMoney(user?.used_quota ?? 0)}`,
        glyph: ICONS.wallet,
        tone: quotaEmpty ? 'danger' : 'brand',
        loading: firstLoad,
      }),
      statCard({
        label: '区间消费',
        value: formatUSD(cost),
        hint: requests ? `平均每次 ${formatUSD(cost / requests, 5)}` : '暂无调用',
        glyph: ICONS.dollar,
        tone: 'warning',
        loading: firstLoad,
      }),
      statCard({
        label: '调用次数',
        value: formatNumber(requests),
        hint: errorHint(requests, errors, successRate),
        glyph: ICONS.bolt,
        tone: errors ? 'danger' : 'success',
        loading: firstLoad,
      }),
      statCard({
        label: '消耗 Token',
        value: formatCompact(tokens),
        hint: requests ? `平均每次 ${formatCompact(tokens / requests)}` : '暂无调用',
        glyph: ICONS.chart,
        tone: 'neutral',
        title: formatNumber(tokens),
        loading: firstLoad,
      }),
    ]

    if (admin) {
      cards.push(
        statCard({
          label: '用户数',
          value: formatNumber(stats?.user_count ?? 0),
          hint: '全站注册账号',
          glyph: ICONS.team,
          tone: 'neutral',
          loading: firstLoad,
        }),
        statCard({
          label: '渠道数',
          value: formatNumber(stats?.channel_count ?? 0),
          hint: '已配置的上游渠道',
          glyph: ICONS.api,
          tone: 'neutral',
          loading: firstLoad,
        }),
      )
    }
    replace(statsGrid, cards)

    // ---- chart
    chart?.destroy?.()
    chart = null

    const points = series()
    const hasData = points.some((point) => point.requests > 0 || point.costUsd > 0)

    let chartBody
    if (firstLoad) {
      chartBody = skeletonCard(300)
    } else if (error) {
      chartBody = emptyState({
        title: '加载失败',
        description: error,
        action: button({ label: '重试', variant: 'primary', glyph: ICONS.reload, onClick: () => load() }),
      })
    } else if (hasData) {
      chart = usageChart({ points, showErrors: errors > 0 })
      chartBody = el(
        'div',
        {
          role: 'img',
          'aria-label': `用量趋势：共 ${formatNumber(requests)} 次调用，消费 ${formatUSD(cost)}`,
        },
        chart,
      )
    } else {
      chartBody = emptyState({
        title: '这段时间还没有调用记录',
        description: '创建一个 API 密钥并发起请求后，这里会显示用量曲线。',
        action: button({
          label: admin ? '去配置渠道' : '去创建密钥',
          variant: 'primary',
          onClick: () => router.navigate(admin ? '/admin/channels' : '/tokens'),
        }),
      })
    }

    replace(
      chartSlot,
      el('div', { class: 'mt-12' }, [
        card({
          title: '用量趋势',
          extra: days <= 2 ? '按小时聚合' : '按天聚合',
          body: chartBody,
        }),
      ]),
    )

    // ---- rankings
    const ranks = [rankCard('模型排行', stats?.by_model ?? [], firstLoad)]
    if (admin) {
      ranks.push(
        rankCard('渠道排行', stats?.by_channel ?? [], firstLoad),
        rankCard('用户排行', stats?.by_user ?? [], firstLoad),
      )
    }
    replace(ranksGrid, ranks)
  }

  // The balance card reads from the session, which the shell re-polls.
  const unsubscribe = sessionStore.subscribe(() => {
    if (!disposed && !loading) paint()
  })

  void load()

  return () => {
    disposed = true
    unsubscribe()
    chart?.destroy?.()
  }
}

function errorHint(requests, errors, successRate) {
  if (errors) {
    return el(
      'span',
      { class: 'text-danger' },
      `失败 ${formatNumber(errors)} 次 · 成功率 ${formatPercent(successRate)}`,
    )
  }
  return requests ? '全部成功' : '暂无调用'
}

function statCard({ label, value, hint, glyph, tone = 'brand', title = null, loading = false }) {
  if (loading) {
    return el('div', { class: 'stat-card' }, [
      el('div', { class: 'skeleton skeleton__line', style: { width: '40%' } }),
      el('div', { class: 'skeleton skeleton__line', style: { height: '26px', width: '70%' } }),
      el('div', { class: 'skeleton skeleton__line', style: { width: '55%', marginBottom: '0' } }),
    ])
  }

  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-card__head' }, [
      el('span', { class: 'stat-card__label' }, label),
      el('span', { class: `stat-card__icon stat-card__icon--${tone}` }, icon(glyph, { size: 15 })),
    ]),
    el('div', { class: 'stat-card__value', title }, value),
    el('div', { class: 'stat-card__hint' }, hint),
  ])
}

/**
 * A ranked list.
 *
 * Free traffic still deserves proportional bars: when nothing in the list has
 * cost anything, the bars and the headline number fall back to request counts
 * rather than showing a column of "$0.0000".
 */
function rankCard(title, rows, loading) {
  if (loading) return card({ title, body: skeletonCard(180) })

  const top = [...rows]
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
    .slice(0, 8)

  if (top.length === 0) {
    return card({ title, body: emptyState({ title: '所选时间范围内没有调用', compact: true }) })
  }

  const byCost = top.some((row) => row.cost > 0)
  const max = Math.max(...top.map((row) => (byCost ? row.cost : row.requests)), 1)

  return card({
    title,
    extra: byCost ? '按消费排序' : '按调用排序',
    tight: true,
    body: top.map((row) => {
      const weight = byCost ? row.cost : row.requests
      return el('div', { class: 'rank-row' }, [
        el('span', { class: 'rank-row__name', title: row.name }, row.name),
        el(
          'span',
          { class: 'rank-row__value' },
          byCost ? formatUSD(row.cost) : `${formatNumber(row.requests)} 次`,
        ),
        el(
          'span',
          { class: 'rank-row__bar' },
          el('span', { style: { width: `${Math.max((weight / max) * 100, 2)}%` } }),
        ),
        el(
          'span',
          { class: 'rank-row__meta' },
          byCost
            ? `${formatNumber(row.requests)} 次 · ${formatCompact(row.total_tokens)} tokens`
            : `${formatCompact(row.total_tokens)} tokens`,
        ),
      ])
    }),
  })
}
