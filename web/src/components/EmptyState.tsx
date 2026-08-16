import type { ReactNode } from 'react'
import { Empty, Typography } from 'antd'

interface Props {
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
}

/** A friendlier default than antd's bare "暂无数据". */
export default function EmptyState({ title, description, action, compact }: Props) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      style={{ padding: compact ? '12px 0' : '36px 0' }}
      description={
        <div style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
          <Typography.Text strong>{title}</Typography.Text>
          {description && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {description}
            </Typography.Text>
          )}
        </div>
      }
    >
      {action}
    </Empty>
  )
}
