import { Alert, Form, InputNumber, Select } from 'antd'

import { formatBytes } from '../../../utils/format'
import SettingsForm, { SettingsSection } from './SettingsForm'
import { BODY_LIMIT_OPTIONS, type PanelProps } from './shared'

const estimateFootprint = (keep: number, bodyLimit: number) => formatBytes(keep * bodyLimit * 2)

/**
 * How much of a call is kept, and for how many calls. The two are multiplied
 * together into the disk estimate, which is why they share a tab: raising one
 * without seeing the other is how a log directory fills up.
 */
export default function LoggingPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <SettingsSection title="完整正文留存">
        <Form.Item
          label="保留条数"
          help="在「调用日志 → 点开某一行」中查看请求和响应原文。超出条数的旧记录会自动删除；设为 0 表示不记录，并清空已有正文。"
        >
          <InputNumber
            aria-label="保留最近多少次调用的完整正文"
            className="settings-control"
            min={0}
            max={20000}
            step={100}
            precision={0}
            addonAfter="次"
            value={draft.log_detail_keep}
            onChange={(value) => patch({ log_detail_keep: value ?? 0 })}
          />
        </Form.Item>

        <Form.Item
          label="单条上限"
          help="单条请求或响应保留的最大字节数，超出部分截断。"
          className={draft.log_detail_keep > 0 ? undefined : 'settings-form__last'}
        >
          <Select
            aria-label="正文保留上限"
            className="settings-control"
            value={draft.log_body_limit}
            onChange={(value) => patch({ log_body_limit: value })}
            options={BODY_LIMIT_OPTIONS}
          />
        </Form.Item>

        {draft.log_detail_keep > 0 && (
          <Alert
            type="info"
            showIcon
            message={`最多约占用 ${estimateFootprint(draft.log_detail_keep, draft.log_body_limit)}`}
            description="按每次调用的请求与响应各达到单条上限估算；实际正文通常远小于上限。"
          />
        )}
      </SettingsSection>
    </SettingsForm>
  )
}
