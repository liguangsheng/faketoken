import type { ReactNode } from 'react'
import { Card, Skeleton, Tooltip } from 'antd'

export type StatTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral'

const TONES: Record<StatTone, { bg: string; color: string }> = {
  brand: { bg: 'var(--app-brand-soft)', color: 'var(--app-brand)' },
  success: { bg: 'var(--app-success-soft)', color: 'var(--app-success)' },
  warning: { bg: 'var(--app-warning-soft)', color: 'var(--app-warning)' },
  danger: { bg: 'var(--app-danger-soft)', color: 'var(--app-danger)' },
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
        // Same height as the real body, so the grid doesn't jump when data lands.
        <div style={{ minHeight: 92, display: 'flex', alignItems: 'center' }}>
          <Skeleton active paragraph={{ rows: 1, width: '60%' }} title={{ width: '40%' }} />
        </div>
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
