import { Drawer } from 'antd'

import type { ConsoleSettings } from '../../../api/types'
import { SettingsDetails } from './SettingsForm'
import { STATUS_OPTIONS } from './shared'

const LABELS: Record<keyof ConsoleSettings, string> = {
  default_page_size: '默认每页条数',
  import_priority: '导入默认优先级',
  import_weight: '导入默认权重',
  allow_register: '开放注册',
  require_invite_code: '注册需要邀请码',
  init_quota_usd: '注册赠送额度',
  max_retries: '最大尝试渠道数',
  retry_backoff_ms: '重试间隔',
  relay_timeout_secs: '请求超时',
  stream_idle_secs: '流式空闲超时',
  log_detail_keep: '保留最近调用',
  log_failed_keep_days: '失败正文额外保留',
  log_body_limit: '单条正文上限',
  blocked_status: '屏蔽默认状态码',
  block_rules: '屏蔽规则',
}

function formatValue(settings: ConsoleSettings, field: keyof ConsoleSettings): string {
  const value = settings[field]
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (Array.isArray(value)) {
    return `${value.length} 组，${value.filter((rule) => rule.enabled).length} 组启用`
  }
  const number = value.toLocaleString()
  switch (field) {
    case 'init_quota_usd':
      return `$${number}`
    case 'log_body_limit':
      return value >= 1024 * 1024 ? `${value / (1024 * 1024)} MiB` : `${value / 1024} KiB`
    case 'relay_timeout_secs':
    case 'stream_idle_secs':
      return value === 0 ? '不限制' : `${number} 秒`
    case 'retry_backoff_ms':
      return value === 0 ? '不等待' : `${number} 毫秒`
    case 'log_detail_keep':
      return value === 0 ? '停止记录并清空正文' : `${number} 次`
    case 'log_failed_keep_days':
      return value === 0 ? '不额外保留' : `${number} 天`
    case 'default_page_size':
      return `${number} 条`
    case 'max_retries':
      return `${number} 个`
    case 'blocked_status':
      return STATUS_OPTIONS.find((option) => option.value === value)?.label ?? String(value)
    default:
      return number
  }
}

interface Props {
  open: boolean
  onClose: () => void
  before: ConsoleSettings
  after: ConsoleSettings
  fields: (keyof ConsoleSettings)[]
}

export default function SettingsChanges({ open, onClose, before, after, fields }: Props) {
  return (
    <Drawer
      title={`待保存的修改 · ${fields.length} 项`}
      open={open}
      onClose={onClose}
      width={600}
      rootClassName="settings-changes-drawer"
    >
      <p className="settings-drawer-note">
        相对本次编辑起点的修改。保存全部会提交所有分区的当前草稿。
      </p>
      <div className="settings-changes">
        {fields.map((field) => (
          <section className="settings-change" key={field}>
            <h3>{LABELS[field]}</h3>
            <div className="settings-change__values">
              <div>
                <span className="settings-change__label">修改前</span>
                <div>{formatValue(before, field)}</div>
              </div>
              <span className="settings-change__arrow" aria-hidden="true">→</span>
              <div>
                <span className="settings-change__label">当前草稿</span>
                <div>{formatValue(after, field)}</div>
              </div>
            </div>
            {field === 'block_rules' && (
              <div className="settings-change__rules">
                <SettingsDetails title="查看修改前的完整规则">
                  <pre>{JSON.stringify(before.block_rules, null, 2)}</pre>
                </SettingsDetails>
                <SettingsDetails title="查看当前草稿的完整规则">
                  <pre>{JSON.stringify(after.block_rules, null, 2)}</pre>
                </SettingsDetails>
              </div>
            )}
          </section>
        ))}
      </div>
    </Drawer>
  )
}
