import type { ReactNode } from 'react'
import { Card, Skeleton, Tooltip } from 'antd'

export type StatTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral'

const TONES: Record<StatTone, { bg: string; color: string }> = {
  brand: { bg: 'var(--app-brand-soft)', color: 'var(--app-brand)' },
  success: { bg: 'rgba(22, 163, 74, 0.12)', color: 'var(--app-success)' },
  warning: { bg: 'rgba(217, 119, 6, 0.12)', color: 'var(--app-warning)' },
  danger: { bg: 'rgba(220, 38, 38, 0.12)', color: 'var(--app-danger)' },
  neutral: { bg: 'var(--app-surface-sunken)', color: 'var(--app-text-muted)' },
}

interface Props {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: StatTone
  loading?: boolean
  tooltip?: string
}

export default function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'brand',
  loading,
  tooltip,
}: Props) {
  const palette = TONES[tone]

  const body = (
    <>
      <div className="stat-card__head">
        <span className="stat-card__label">{label}</span>
        {icon && (
          <span
            className="stat-card__icon"
            style={{ background: palette.bg, color: palette.color }}
            aria-hidden
          >
            {icon}
          </span>
        )}
      </div>
      <div className="stat-card__value">{value}</div>
      <div className="stat-card__hint">{hint}</div>
    </>
  )

  return (
    <Card size="small" styles={{ body: { padding: 16 } }}>
      {loading ? (
        <Skeleton active paragraph={{ rows: 1, width: '60%' }} title={{ width: '40%' }} />
      ) : tooltip ? (
        <Tooltip title={tooltip}>
          <div>{body}</div>
        </Tooltip>
      ) : (
        body
      )}
    </Card>
  )
}
