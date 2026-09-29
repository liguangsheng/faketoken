import { Form, InputNumber, Select } from 'antd'

import SettingsForm, { SettingsSection } from './SettingsForm'
import { PAGE_SIZE_OPTIONS, type PanelProps } from './shared'

/**
 * The two things that only shape what the console itself shows: how long a
 * table's first page is, and what a quick import prefills. Neither changes how
 * a request is served.
 */
export default function GeneralPanel({ draft, patch }: PanelProps) {
  return (
    <SettingsForm>
      <SettingsSection title="列表显示">
        <Form.Item
          label="默认每页条数"
          help="渠道、用户、日志等列表首次打开时的每页条数；每个列表仍可临时切换。"
        >
          <Select
            aria-label="默认每页条数"
            className="settings-control"
            value={draft.default_page_size}
            onChange={(value) => patch({ default_page_size: value })}
            options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} 条` }))}
          />
        </Form.Item>
      </SettingsSection>

      <SettingsSection title="渠道快速导入">
        <Form.Item
          label="默认优先级"
          help="快速导入新建渠道时预填的优先级，数值越大越优先。导入到已存在的渠道时不会覆盖它原有的值。"
        >
          <InputNumber
            aria-label="默认优先级"
            className="settings-control"
            step={1}
            precision={0}
            min={-1000000}
            max={1000000}
            value={draft.import_priority}
            onChange={(value) => patch({ import_priority: value ?? 0 })}
          />
        </Form.Item>

        <Form.Item
          label="默认权重"
          help="同优先级的渠道之间按权重随机分配流量。至少为 1，为 0 的渠道永远不会被选中。"
          className="settings-form__last"
        >
          <InputNumber
            aria-label="默认权重"
            className="settings-control"
            step={1}
            precision={0}
            min={1}
            max={1000000}
            value={draft.import_weight}
            onChange={(value) => patch({ import_weight: value ?? 1 })}
          />
        </Form.Item>
      </SettingsSection>
    </SettingsForm>
  )
}
