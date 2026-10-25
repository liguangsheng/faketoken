import { ReloadOutlined } from '@ant-design/icons'
import { Button } from 'antd'

import EmptyState from './EmptyState'

interface Props {
  error: string
  onRetry: () => void
}

/**
 * A failed load is not an empty list. Without this the table drew "还没有…" over
 * a 500 and the page looked like a fresh install.
 */
export default function LoadError({ error, onRetry }: Props) {
  return (
    <EmptyState
      title="加载失败"
      description={error}
      action={
        <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
          重试
        </Button>
      }
    />
  )
}
