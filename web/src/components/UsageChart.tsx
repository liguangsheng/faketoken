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

import { formatCompact, formatNumber } from '../utils/format'

export interface ChartPoint {
  label: string
  requests: number
  errors: number
  costUsd: number
}

interface Props {
  data: ChartPoint[]
  dark: boolean
  showErrors: boolean
}

interface TooltipItem {
  name?: string
  value?: number
  color?: string
  dataKey?: string | number
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
      <div style={{ color: 'var(--app-text-muted)', marginBottom: 6 }}>{label}</div>
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
              ? `$${(item.value ?? 0).toFixed(4)}`
              : formatNumber(item.value ?? 0)}
          </strong>
        </div>
      ))}
    </div>
  )
}

/**
 * Loaded lazily: recharts is by far the heaviest dependency and nothing above
 * the fold needs it.
 */
export default function UsageChart({ data, dark, showErrors }: Props) {
  const axisColor = dark ? '#6b7385' : '#9ca3af'
  const gridColor = dark ? '#242833' : '#eef0f4'
  const brand = dark ? '#8b87f5' : '#4f46e5'

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="requestsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={brand} stopOpacity={0.28} />
            <stop offset="100%" stopColor={brand} stopOpacity={0.02} />
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
          tickFormatter={(value: number) => `$${value < 1 ? value.toFixed(2) : value.toFixed(0)}`}
          width={56}
        />
        <Tooltip cursor={{ stroke: gridColor }} content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="requests"
          name="调用次数"
          stroke={brand}
          strokeWidth={2}
          fill="url(#requestsFill)"
          activeDot={{ r: 4 }}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="costUsd"
          name="消费"
          stroke="#0ea5e9"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
        {showErrors && (
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="errors"
            name="失败"
            stroke="#ef4444"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
