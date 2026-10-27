import { InputNumber } from 'antd'

import SettingsForm, { SettingsRow, SettingsSection } from './SettingsForm'
import type { PanelProps } from './shared'

export default function RelayPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <SettingsSection title="重试策略" description="上游失败时，如何尝试其他渠道。">
        <SettingsRow
          label="最大尝试渠道数"
          description="包含首次尝试。渠道自身的重试次数用完后，才换下一个渠道。"
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={1}
              max={20}
              step={1}
              precision={0}
              addonAfter="个"
              value={draft.max_retries}
              onChange={(value) => patch({ max_retries: value ?? 1 })}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label="重试间隔"
          description="切换渠道前的等待基数；设为 0 则不等待。"
          details={{
            title: '退避规则与渠道配置',
            content:
              '等待时间按尝试次数递增，上限 2 秒。渠道配置了重试间隔时以渠道为准；上游返回 Retry-After 时，该渠道的熔断冷却采用上游给定的时间。',
          }}
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={0}
              max={10000}
              step={50}
              precision={0}
              addonAfter="毫秒"
              value={draft.retry_backoff_ms}
              onChange={(value) => patch({ retry_backoff_ms: value ?? 0 })}
            />
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="超时控制" description="限制单次上游请求的总时长和静默时长。">
        <SettingsRow
          label="请求超时"
          description="从发出请求到响应结束，包含流式输出；设为 0 表示不限制。"
          details={{
            title: '超时后的处理与渠道覆盖',
            content:
              '超时即断开；尚未开始响应时会换渠道重试。渠道单独设置了超时时，以渠道为准。',
          }}
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={0}
              max={86400}
              step={60}
              precision={0}
              addonAfter="秒"
              value={draft.relay_timeout_secs}
              onChange={(value) => patch({ relay_timeout_secs: value ?? 0 })}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label="流式空闲超时"
          description="连续没有数据时断开；设为 0 则只受请求超时约束。"
          details={{
            title: '为什么不宜设得太短',
            content:
              '部分上游会生成完整个工具调用才一次发出。写大文件时可能静默几分钟，过短的空闲时限会误断仍在工作的请求。',
          }}
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={0}
              max={86400}
              step={60}
              precision={0}
              addonAfter="秒"
              value={draft.stream_idle_secs}
              onChange={(value) => patch({ stream_idle_secs: value ?? 0 })}
            />
          )}
        </SettingsRow>
      </SettingsSection>
    </SettingsForm>
  )
}
