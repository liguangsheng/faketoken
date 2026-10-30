import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { Button, Card, Col, Row, Segmented, Typography } from 'antd'
import {
  BarChartOutlined,
  CalendarOutlined,
  DollarOutlined,
  FireOutlined,
  ReloadOutlined,
  RiseOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'

import { api, type UsageDay } from '../api/client'
import { formatCompact, formatNumber, formatPercent, formatUSD } from '../utils/format'
import EmptyState from './EmptyState'
import StatCard from './StatCard'

type Metric = 'total_tokens' | 'requests' | 'cost'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'total_tokens', label: 'Token' },
  { value: 'requests', label: '调用次数' },
  { value: 'cost', label: '消费' },
]

/** Short form for the summary and the legend. */
const SHORT: Record<Metric, (value: number) => string> = {
  total_tokens: (value) => `${formatCompact(value)} tokens`,
  requests: (value) => `${formatNumber(value)} 次`,
  cost: (value) => formatUSD(value, 2),
}

// 52 whole weeks plus the current one; matches the server's span.
const WEEKS = 53
const LEVELS = [0, 1, 2, 3, 4]
// Rows are Monday..Sunday; label every other one, as GitHub does.
const WEEKDAY_LABELS = [
  { row: 0, text: '一' },
  { row: 2, text: '三' },
  { row: 4, text: '五' },
]

interface Cell {
  date: Dayjs
  key: string
  col: number
  row: number
}

// Monday = 0 … Sunday = 6; dayjs counts from Sunday.
const weekday = (date: Dayjs) => (date.day() + 6) % 7

/** Every day from the Monday 52 weeks back through today, one column per week. */
function buildCells(today: Dayjs): Cell[] {
  const count = (WEEKS - 1) * 7 + weekday(today) + 1
  const start = today.subtract(count - 1, 'day')
  return Array.from({ length: count }, (_, i) => {
    const date = start.add(i, 'day')
    return { date, key: date.format('YYYY-MM-DD'), col: Math.floor(i / 7), row: i % 7 }
  })
}

/** "10月" over the first week of each month, dropped where it would crowd the next. */
function monthLabels(cells: Cell[]) {
  const labels: { col: number; text: string }[] = []
  for (let col = 0; col * 7 < cells.length; col++) {
    const monday = cells[col * 7].date
    if (col === 0 || monday.month() !== cells[(col - 1) * 7].date.month()) {
      labels.push({ col, text: monday.format('M月') })
    }
  }
  return labels.filter((label, i) => {
    const next = labels[i + 1]
    return (!next || next.col - label.col >= 3) && label.col <= WEEKS - 2
  })
}

/**
 * Level 1–4 by percentile among days with traffic, so one heavy day does not
 * wash every other day out to the palest step. 0 is reserved for no traffic.
 * E.g. 8 active days: the lightest two get 1, the heaviest two get 4.
 */
function levelScale(values: number[]) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b)
  return (value: number) => {
    if (value <= 0 || !sorted.length) return 0

    // Days at or below value.
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] <= value) lo = mid + 1
      else hi = mid
    }
    return Math.ceil((4 * lo) / sorted.length)
  }
}

interface Summary {
  /** Sum of the metric. */
  total: number
  /** Days with calls. */
  activeDays: number
  /** Days counted. */
  span: number
  /** The heaviest day by the metric; a tie goes to the later day. */
  peak: { date: Dayjs; value: number } | null
  /** Active days running up to the last day; a quiet today does not end it yet. */
  streak: number
  /** The longest such run; a tie goes to the later one. */
  longest: { days: number; start: Dayjs; end: Dayjs } | null
}

/**
 * Consecutive days, oldest first, in a few numbers. A day is active when it
 * had calls, whatever the metric: a day of free calls still keeps a streak going.
 */
function summarize(
  dates: Pick<Cell, 'date' | 'key'>[],
  byDay: Map<string, UsageDay>,
  values: number[],
): Summary {
  const active = dates.map((day) => (byDay.get(day.key)?.requests ?? 0) > 0)
  let total = 0
  let peak: Summary['peak'] = null
  let longest: Summary['longest'] = null

  for (let i = 0, run = 0; i < dates.length; i++) {
    total += values[i]
    if (values[i] > 0 && values[i] >= (peak?.value ?? 0)) {
      peak = { date: dates[i].date, value: values[i] }
    }

    run = active[i] ? run + 1 : 0
    if (run > 0 && run >= (longest?.days ?? 0)) {
      longest = { days: run, start: dates[i - run + 1].date, end: dates[i].date }
    }
  }

  // A quiet today has not broken the streak yet; a quiet yesterday has, and
  // so has a quiet last day of a range in the past.
  let end = dates.length - 1
  if (!active[end] && dates[end].date.isSame(dayjs(), 'day')) end--
  let streak = 0
  while (end - streak >= 0 && active[end - streak]) streak++

  const activeDays = active.filter(Boolean).length
  return { total, activeDays, span: dates.length, peak, streak, longest }
}

/**
 * A year of usage by day, GitHub style. Reads its own rollup rather than the
 * logs, so a log purge leaves it intact. The row of cards above it opens with
 * the page's own, then reads the same days over the page's range.
 */
export default function UsageHeatmap({
  admin,
  version,
  period,
  lead = [],
}: {
  admin: boolean
  version: number
  /** The calendar days the page's numbers cover, YYYY-MM-DD, both included. */
  period: { first: string; last: string } | null
  /** The page's cards, first in the row above the grid. */
  lead?: ReactNode[]
}) {
  const [days, setDays] = useState<UsageDay[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<Metric>('total_tokens')
  const [active, setActive] = useState<number | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Same race guard as the dashboard: a slow answer must not land last.
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      // The server cuts days in this zone, so they line up with the cells.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const result = admin ? await api.admin.heatmap(tz) : await api.heatmap(tz)
      if (seq !== requestSeq.current) return
      setDays(result.days)
      setError(null)
    } catch (err) {
      if (seq !== requestSeq.current) return
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [admin])

  useEffect(() => {
    void load()
  }, [load, version])

  // Rebuilt with each answer, so a refresh after midnight gains the new day.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- days is the trigger, not an input
  const cells = useMemo(() => buildCells(dayjs().startOf('day')), [days])
  const months = useMemo(() => monthLabels(cells), [cells])
  const byDay = useMemo(() => new Map((days ?? []).map((day) => [day.day, day])), [days])

  const values = useMemo(
    () => cells.map((cell) => byDay.get(cell.key)?.[metric] ?? 0),
    [cells, byDay, metric],
  )
  const level = useMemo(() => levelScale(values), [values])
  const total = values.reduce((sum, value) => sum + value, 0)
  const activeDays = values.filter((value) => value > 0).length

  // Under three days there is no peak or streak worth a card: 今日 and 24 小时
  // go without.
  const summary = useMemo(() => {
    if (!period) return null
    const first = dayjs(period.first)
    const count = dayjs(period.last).diff(first, 'day') + 1
    if (count < 3) return null

    const dates = Array.from({ length: count }, (_, i) => {
      const date = first.add(i, 'day')
      return { date, key: date.format('YYYY-MM-DD') }
    })
    return summarize(dates, byDay, dates.map((day) => byDay.get(day.key)?.[metric] ?? 0))
  }, [period, byDay, metric])

  // Each swatch's native tooltip names the range it stands for.
  const legendTitles = useMemo(() => {
    const ranges = LEVELS.map(() => ({ min: Infinity, max: 0 }))
    for (const value of values) {
      const range = ranges[level(value)]
      range.min = Math.min(range.min, value)
      range.max = Math.max(range.max, value)
    }
    return ranges.map((range, lv) => {
      if (lv === 0) return '无调用'
      if (range.max === 0) return '—'
      const fmt = SHORT[metric]
      return range.min === range.max ? fmt(range.max) : `${fmt(range.min)} – ${fmt(range.max)}`
    })
  }, [values, level, metric])

  // Most recent weeks first on a narrow screen.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [cells, days])

  // Placed against the wrapper, outside the scroll box, so it is never
  // clipped; re-placed when the box scrolls under it.
  const placeTip = useCallback(() => {
    const wrap = wrapRef.current
    const cell = active === null ? null : wrap?.querySelector(`[data-index="${active}"]`)
    if (!wrap || !cell) {
      setTipPos(null)
      return
    }
    const box = wrap.getBoundingClientRect()
    const rect = cell.getBoundingClientRect()
    const half = 90
    const center = rect.left - box.left + rect.width / 2
    const above = rect.top > 160
    setTipPos({
      left: Math.min(Math.max(center, half), Math.max(box.width - half, half)),
      top: above ? rect.top - box.top - 8 : rect.bottom - box.top + 8,
      above,
    })
  }, [active])

  useLayoutEffect(placeTip, [placeTip])

  const onPointerOver = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
    if (el) setActive(Number(el.dataset.index))
  }

  // Touch has no hover: a tapped cell keeps its tooltip until the next tap.
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') setActive(null)
  }

  // Arrows walk the grid: left/right by week, up/down by day.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[e.key]
    if (step === undefined) return
    e.preventDefault()
    const next = Math.min(Math.max((active ?? cells.length - 1) + step, 0), cells.length - 1)
    scrollRef.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    setActive(next)
  }

  const activeCell = active === null ? null : cells[active]
  const activeDay = activeCell ? byDay.get(activeCell.key) : undefined

  const card = (
    <Card
      title="用量热力图"
      style={{ marginTop: 12 }}
      loading={loading && !days}
      extra={
        <Segmented
          size="small"
          value={metric}
          onChange={(value) => setMetric(value as Metric)}
          options={METRICS}
        />
      }
    >
      {error && !days ? (
        <EmptyState
          title="加载失败"
          description={error}
          action={
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : (
        <div ref={wrapRef} className="heatmap">
          <div
            ref={scrollRef}
            className="heatmap__scroll"
            tabIndex={0}
            role="img"
            aria-label={`用量热力图：近一年共 ${SHORT[metric](total)}，活跃 ${activeDays} 天`}
            onScroll={placeTip}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              // Keyboard focus starts on today; a click already picked a cell.
              if (e.currentTarget.matches(':focus-visible')) setActive(cells.length - 1)
            }}
            onBlur={() => setActive(null)}
          >
            <div
              className="heatmap__grid"
              // One label column, then one column per week.
              style={{ gridTemplateColumns: `auto repeat(${WEEKS}, minmax(10px, 1fr))` }}
              onPointerOver={onPointerOver}
              onPointerLeave={onPointerLeave}
            >
              {months.map((month) => (
                <span key={month.col} className="heatmap__month" style={{ gridColumn: month.col + 2 }}>
                  {month.text}
                </span>
              ))}
              {WEEKDAY_LABELS.map((label) => (
                <span key={label.row} className="heatmap__weekday" style={{ gridRow: label.row + 2 }}>
                  {label.text}
                </span>
              ))}
              {cells.map((cell, i) => (
                <span
                  key={cell.key}
                  data-index={i}
                  data-level={level(values[i])}
                  className={`heatmap__cell${i === active ? ' is-active' : ''}`}
                  style={{ gridColumn: cell.col + 2, gridRow: cell.row + 2 }}
                />
              ))}
            </div>
          </div>

          <div className="heatmap__footer">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              近一年共 {SHORT[metric](total)} · 活跃 {activeDays} 天 · 单独存储，不受日志清理影响
            </Typography.Text>
            <span className="heatmap__legend">
              少
              {LEVELS.map((lv) => (
                <span key={lv} className="heatmap__cell" data-level={lv} title={legendTitles[lv]} />
              ))}
              多
            </span>
          </div>

          {activeCell && tipPos && (
            <div
              className="heatmap__tip"
              style={{
                left: tipPos.left,
                top: tipPos.top,
                transform: tipPos.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
              }}
            >
              <div className="heatmap__tip-date">{activeCell.date.format('YYYY-MM-DD ddd')}</div>
              {activeDay ? (
                <>
                  <TipRow label="Token" value={formatNumber(activeDay.total_tokens)} />
                  <TipRow label="调用" value={`${formatNumber(activeDay.requests)} 次`} />
                  {activeDay.errors > 0 && (
                    <TipRow label="失败" value={`${formatNumber(activeDay.errors)} 次`} danger />
                  )}
                  <TipRow label="消费" value={formatUSD(activeDay.cost)} />
                </>
              ) : (
                <span className="text-muted">无调用</span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )

  return (
    <>
      <StatsRow
        cards={
          // A failed first load leaves the card to say why.
          summary && !(error && !days)
            ? [...lead, ...rangeCards(summary, metric, loading && !days)]
            : lead
        }
      />
      {card}
    </>
  )
}

// Value leads, label follows: the reader already knows which day it is.
function TipRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="heatmap__tip-row">
      <span className="text-muted">{label}</span>
      <strong style={danger ? { color: 'var(--app-danger)' } : undefined}>{value}</strong>
    </div>
  )
}

const AVERAGE_LABEL: Record<Metric, string> = {
  total_tokens: '活跃日均 Token',
  requests: '活跃日均调用',
  cost: '活跃日均消费',
}

// The icons the dashboard's top cards use for the same quantity.
const METRIC_ICON: Record<Metric, ReactNode> = {
  total_tokens: <BarChartOutlined />,
  requests: <ThunderboltOutlined />,
  cost: <DollarOutlined />,
}

/** A card's figure. The label names the metric, so no unit: "1.2B", not "1.2B tokens". */
const FIGURE: Record<Metric, (value: number) => string> = {
  total_tokens: formatCompact,
  requests: (value) => formatNumber(Math.round(value)),
  cost: (value) => formatUSD(value),
}

/**
 * The page's range by calendar day: 30 天 is today and the 29 before it, while
 * the page's own cards count back from this hour, so the edges can differ by up
 * to a day; 自定义 is whole days on both. Figures follow the grid's metric;
 * active days and streaks count calls, so they hold still when it switches.
 */
function rangeCards(summary: Summary, metric: Metric, loading: boolean): ReactNode[] {
  const { total, activeDays, span, peak, streak, longest } = summary
  const figure = FIGURE[metric]
  // A token count is shown rounded; the exact one is a hover away.
  const exact = (value: number) =>
    metric === 'total_tokens' ? `${formatNumber(Math.round(value))} tokens` : undefined
  // Idle days left out: 3 active days of 10M in a week average 10M, not 4.3M.
  const average = activeDays ? total / activeDays : 0

  // "2026-09-01 至 2026-09-21"; a run of one day is just its date.
  const date = (day: Dayjs) => day.format('YYYY-MM-DD')
  const run = longest
    ? longest.days > 1
      ? `${date(longest.start)} 至 ${date(longest.end)}`
      : date(longest.end)
    : null

  return [
    <StatCard
      key="average"
      label={AVERAGE_LABEL[metric]}
      value={activeDays ? figure(average) : '—'}
      hint={activeDays ? `按 ${span} 天平均 ${figure(total / span)}` : '暂无调用'}
      tooltip={activeDays ? exact(average) : undefined}
      icon={METRIC_ICON[metric]}
      loading={loading}
    />,
    <StatCard
      key="peak"
      label="最高单日"
      value={peak ? figure(peak.value) : '—'}
      hint={peak ? peak.date.format('YYYY-MM-DD ddd') : '暂无调用'}
      tooltip={peak ? exact(peak.value) : undefined}
      icon={<RiseOutlined />}
      loading={loading}
    />,
    <StatCard
      key="active"
      label="活跃天数"
      value={formatNumber(activeDays)}
      hint={`共 ${span} 天 · ${formatPercent(activeDays / span, 0)}`}
      icon={<CalendarOutlined />}
      loading={loading}
    />,
    <StatCard
      key="streak"
      label="连续使用"
      value={`${streak} 天`}
      hint={longest ? `最长 ${longest.days} 天` : '暂无调用'}
      tooltip={run ? `最长一段：${run}` : undefined}
      icon={<FireOutlined />}
      loading={loading}
    />,
  ]
}

/**
 * One row in even shares: two cards a half each; six a sixth each on a wide
 * screen and a third on a narrower one.
 */
function StatsRow({ cards }: { cards: ReactNode[] }) {
  if (!cards.length) return null
  const span = cards.length > 4 ? { xs: 12, md: 8, xl: 4 } : { xs: 12, xl: 24 / cards.length }

  return (
    <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
      {cards.map((card, i) => (
        // The order never changes, so the place is a stable key.
        <Col key={i} {...span}>
          {card}
        </Col>
      ))}
    </Row>
  )
}
