import { Form, InputNumber } from 'antd'

import SettingsForm from './SettingsForm'
import type { PanelProps } from './shared'

/** How hard a failed request is retried, how long it waits between tries,
 *  and how long one try may take. */
export default function RelayPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <Form.Item
        label="最大重试次数"
        help="单次请求最多访问多少个渠道。渠道自己配的重试次数会先用完，然后才换下一个渠道。"
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
        help="换到下一个渠道重试前的停顿基数，按尝试次数递增，上限 2 秒。设为 0 则不等待。渠道自己配了重试间隔时以渠道为准；上游返回 Retry-After 时，该渠道的熔断冷却直接采用上游给定的时间。"
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

      <Form.Item
        label="请求超时"
        help="单次上游请求从发出到响应结束（含流式输出）的最长时间。超时即断开，还没开始响应的会换渠道重试。设为 0 表示不限制。渠道自己设了超时时以渠道为准。流式响应另有保护：连续 120 秒收不到数据就断开。"
        className="settings-form__last"
      >
        <InputNumber
          aria-label="请求超时"
          className="settings-control"
          min={0}
          max={86400}
          step={60}
          precision={0}
          addonAfter="秒"
          value={draft.relay_timeout_secs}
          onChange={(value) => patch({ relay_timeout_secs: value ?? 0 })}
        />
      </Form.Item>
    </SettingsForm>
  )
}
