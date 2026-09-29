import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { formatCompact, formatNumber, formatUSDValue } from '../utils/format'

export interface ChartPoint {
  label: string
  /** Full timestamp for the tooltip; the axis keeps the short label. */
  fullLabel: string
  requests: number
  errors: number
  costUsd: number
}

interface Props {
  data: ChartPoint[]
  showErrors: boolean
}

interface TooltipItem {
  name?: string
  value?: number
  color?: string
  dataKey?: string | number
  payload?: ChartPoint
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: string
}) {
  if (!active || !payload?.length) return null

  return (
    <div
      style={{
        background: 'var(--app-surface)',
        border: '1px solid var(--app-border)',
        borderRadius: 10,
        boxShadow: 'var(--app-shadow)',
        fontSize: 12,
        minWidth: 152,
        padding: '8px 10px',
      }}
    >
      <div style={{ color: 'var(--app-text-muted)', marginBottom: 6 }}>
        {payload[0]?.payload?.fullLabel ?? label}
      </div>
      {payload.map((item) => (
        <div
          key={String(item.dataKey)}
          style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}
        >
          <span style={{ color: 'var(--app-text-muted)' }}>
            <span
              style={{
                background: item.color,
                borderRadius: 999,
                display: 'inline-block',
                height: 7,
                marginInlineEnd: 6,
                width: 7,
              }}
            />
            {item.name}
          </span>
          <strong style={{ color: 'var(--app-text)' }}>
            {item.dataKey === 'costUsd'
              ? formatUSDValue(item.value ?? 0)
              : formatNumber(item.value ?? 0)}
          </strong>
        </div>
      ))}
    </div>
  )
}

/** Ticks scale their precision with the amount, so a $0.003 day is not a wall of "$0.00". */
const costTick = (value: number) => {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(0)}`
}

/**
 * Loaded lazily: recharts is by far the heaviest dependency and nothing above
 * the fold needs it. All colours come from the CSS variables, so the chart
 * follows a theme switch without a re-render.
 */
export default function UsageChart({ data, showErrors }: Props) {
  const axisColor = 'var(--app-text-faint)'
  const gridColor = 'var(--app-border)'
  // A single bucket cannot draw a line segment; a dot keeps it visible.
  const singlePoint = data.length === 1

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="requestsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--app-brand)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--app-brand)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: axisColor, fontSize: 12 }}
          axisLine={{ stroke: gridColor }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          yAxisId="left"
          allowDecimals={false}
          tick={{ fill: axisColor, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={formatCompact}
          width={56}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: axisColor, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={costTick}
          width={56}
        />
        <Tooltip cursor={{ stroke: gridColor }} content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="requests"
          name="调用次数"
          stroke="var(--app-brand)"
          strokeWidth={2}
          fill="url(#requestsFill)"
          dot={singlePoint ? { r: 3 } : false}
          activeDot={{ r: 4 }}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="costUsd"
          name="消费（右轴）"
          stroke="var(--app-accent)"
          strokeWidth={2}
          dot={singlePoint ? { r: 3 } : false}
          activeDot={{ r: 4 }}
        />
        {showErrors && (
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="errors"
            name="失败"
            stroke="var(--app-danger)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={singlePoint ? { r: 3 } : false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
