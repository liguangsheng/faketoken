import { InputNumber, Select } from 'antd'

import SettingsForm, { SettingsRow, SettingsSection } from './SettingsForm'
import { PAGE_SIZE_OPTIONS, type PanelProps } from './shared'

export default function GeneralPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <SettingsSection title="列表显示" description="统一列表的初始显示方式，不影响请求转发。">
        <SettingsRow
          label="默认每页条数"
          description="渠道、用户、日志等列表首次打开时使用；各列表仍可临时切换。"
        >
          {(control) => (
            <Select
              {...control}
              className="settings-control"
              value={draft.default_page_size}
              onChange={(value) => patch({ default_page_size: value })}
              options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} 条` }))}
            />
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="渠道快速导入"
        description="仅预填新建渠道，不会修改已有渠道的配置。"
      >
        <SettingsRow label="默认优先级" description="数值越大，渠道越先被尝试。">
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              step={1}
              precision={0}
              min={-1000000}
              max={1000000}
              value={draft.import_priority}
              onChange={(value) => patch({ import_priority: value ?? 0 })}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label="默认权重"
          description="同优先级的渠道按权重随机分配流量，最小为 1。"
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              step={1}
              precision={0}
              min={1}
              max={1000000}
              value={draft.import_weight}
              onChange={(value) => patch({ import_weight: value ?? 1 })}
            />
          )}
        </SettingsRow>
      </SettingsSection>
    </SettingsForm>
  )
}
