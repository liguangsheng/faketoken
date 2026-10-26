import { Form, InputNumber, Select } from 'antd'

import SettingsForm, { SettingsSection } from './SettingsForm'
import { BODY_LIMIT_OPTIONS, type PanelProps } from './shared'

/**
 * How much of a call is kept, and for how many calls. Bodies are stored as
 * shared chunks, so a resent conversation costs only its new turn and there is
 * no per-call size to multiply out into an estimate.
 */
export default function LoggingPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <SettingsSection title="完整正文留存">
        <Form.Item
          label="保留条数"
          help="在「调用日志 → 点开某一行」中查看请求和响应原文。超出条数的旧记录会自动删除；设为 0 表示不记录，并清空已有正文。重复的对话历史只存一份，实际占用远小于条数乘以单条大小。"
        >
          <InputNumber
            aria-label="保留最近多少次调用的完整正文"
            className="settings-control"
            min={0}
            max={100000}
            step={1000}
            precision={0}
            addonAfter="次"
            value={draft.log_detail_keep}
            onChange={(value) => patch({ log_detail_keep: value ?? 0 })}
          />
        </Form.Item>

        <Form.Item
          label="失败调用多留"
          help="失败的调用滚出上面的条数后，正文再保留这么多天，最多再留同样多条。设为 0 表示和其他调用一样按条数删除。"
        >
          <InputNumber
            aria-label="失败调用的正文额外保留天数"
            className="settings-control"
            min={0}
            max={365}
            precision={0}
            addonAfter="天"
            value={draft.log_failed_keep_days}
            onChange={(value) => patch({ log_failed_keep_days: value ?? 0 })}
          />
        </Form.Item>

        <Form.Item
          label="单条上限"
          help="单条请求或响应保留的最大字节数。超过时 JSON 正文整条不保存，流式和文本正文截断。请求在网关入口另有 100 MiB 上限。"
          className="settings-form__last"
        >
          <Select
            aria-label="正文保留上限"
            className="settings-control"
            value={draft.log_body_limit}
            onChange={(value) => patch({ log_body_limit: value })}
            options={BODY_LIMIT_OPTIONS}
          />
        </Form.Item>
      </SettingsSection>
    </SettingsForm>
  )
}
