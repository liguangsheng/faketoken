import { Form, InputNumber } from 'antd'

import SettingsForm from './SettingsForm'
import type { PanelProps } from './shared'

/** How hard a failed request is retried, and how long it waits between tries. */
export default function RelayPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <Form.Item
        label="最大重试次数"
        help="单次请求最多尝试多少个渠道。每次重试都会重新匹配一个不同的渠道，而不是盯着同一个渠道重试。"
      >
        <InputNumber
          aria-label="最大重试次数"
          className="settings-control"
          min={1}
          max={20}
          step={1}
          precision={0}
          addonAfter="次"
          value={draft.max_retries}
          onChange={(value) => patch({ max_retries: value ?? 1 })}
        />
      </Form.Item>

      <Form.Item
        label="重试间隔"
        help="换到下一个渠道重试前的停顿基数，按尝试次数递增，上限 2 秒。设为 0 则不等待。上游返回 Retry-After 时，该渠道的熔断冷却直接采用上游给定的时间。"
        className="settings-form__last"
      >
        <InputNumber
          aria-label="重试间隔"
          className="settings-control"
          min={0}
          max={10000}
          step={50}
          precision={0}
          addonAfter="毫秒"
          value={draft.retry_backoff_ms}
          onChange={(value) => patch({ retry_backoff_ms: value ?? 0 })}
        />
      </Form.Item>
    </SettingsForm>
  )
}
