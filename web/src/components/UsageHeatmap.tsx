import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { Button, Card, Segmented, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'

import { api, type UsageDay } from '../api/client'
import { formatCompact, formatNumber, formatUSD } from '../utils/format'
import EmptyState from './EmptyState'

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

/**
 * A year of usage by day, GitHub style. Reads its own rollup rather than the
 * logs, so a log purge leaves it intact.
 */
export default function UsageHeatmap({ admin, version }: { admin: boolean; version: number }) {
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

  return (
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
