import { Alert, InputNumber, Select } from 'antd'

import SettingsForm, { SettingsRow, SettingsSection } from './SettingsForm'
import { BODY_LIMIT_OPTIONS, type PanelProps } from './shared'

export default function LoggingPanel({ draft, saved, patch }: PanelProps) {
  const reducing = draft.log_detail_keep < saved.log_detail_keep

  return (
    <SettingsForm>
      <SettingsSection
        title="正文留存"
        description="保留请求和响应原文，供调用日志详情查看。"
      >
        <SettingsRow
          label="保留最近调用"
          description="超出条数的旧正文自动删除。设为 0 会停止记录，并清空已有正文。"
          details={{
            title: '正文如何占用存储',
            content:
              '重复的对话历史只存一份，实际占用通常远小于条数乘以单条大小。此处控制正文，不是调用日志的基本记录。',
          }}
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={0}
              max={100000}
              step={1000}
              precision={0}
              addonAfter="次"
              value={draft.log_detail_keep}
              onChange={(value) => patch({ log_detail_keep: value ?? 0 })}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label="失败正文额外保留"
          description="失败调用超出上述条数后，正文再保留这些天；0 表示不额外保留。"
          details={{
            title: '额外留存的数量上限',
            content: '额外保留的失败正文，最多与上面的保留条数相同。停止记录正文后，不再额外保留失败正文。',
          }}
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={0}
              max={365}
              precision={0}
              addonAfter="天"
              value={draft.log_failed_keep_days}
              onChange={(value) => patch({ log_failed_keep_days: value ?? 0 })}
            />
          )}
        </SettingsRow>
        {reducing && (
          <Alert
            type="warning"
            showIcon
            message={
              draft.log_detail_keep === 0
                ? '保存后将停止记录，并清空已保留的全部正文'
                : `保留量将从 ${saved.log_detail_keep.toLocaleString()} 降至 ${draft.log_detail_keep.toLocaleString()} 次`
            }
            description="超出保留范围的正文会立即删除，无法恢复。保存时需再次确认。"
          />
        )}
      </SettingsSection>

      <SettingsSection title="正文捕获" description="控制每条请求或响应最多保存多少内容。">
        <SettingsRow
          label="单条正文上限"
          description="超限时，JSON 正文整条不保存，流式与文本正文截断。"
          details={{
            title: '与请求大小限制的区别',
            content: '此值只影响日志捕获。网关入口对请求本身另有 100 MiB 上限。',
          }}
        >
          {(control) => (
            <Select
              {...control}
              className="settings-control"
              value={draft.log_body_limit}
              onChange={(value) => patch({ log_body_limit: value })}
              options={BODY_LIMIT_OPTIONS.map((option) => ({
                ...option,
                label: option.label.split('（')[0],
              }))}
              optionRender={(option) => (
                <span>{BODY_LIMIT_OPTIONS.find((item) => item.value === option.value)?.label}</span>
              )}
              popupMatchSelectWidth={300}
            />
          )}
        </SettingsRow>
      </SettingsSection>
    </SettingsForm>
  )
}
