import { Alert, InputNumber, Radio } from 'antd'

import SettingsForm, { SettingsRow, SettingsSection } from './SettingsForm'
import type { PanelProps } from './shared'

type RegistrationMode = 'closed' | 'invite' | 'open'

export default function RegistrationPanel({ draft, disabled, patch }: PanelProps) {
  const mode: RegistrationMode = !draft.allow_register
    ? 'closed'
    : draft.require_invite_code
      ? 'invite'
      : 'open'
  const openGrant = mode === 'open' && draft.init_quota_usd > 0

  const setMode = (next: RegistrationMode) => {
    // 关闭注册时保留邀请码偏好，避免顺带修改不生效的配置。
    patch({
      allow_register: next !== 'closed',
      ...(next !== 'closed' ? { require_invite_code: next === 'invite' } : {}),
    })
  }

  return (
    <SettingsForm>
      <SettingsSection title="注册方式" description="控制访客能否自助创建账号。">
        <SettingsRow
          label="访客注册"
          wide
          description={
            mode === 'closed'
              ? '不显示注册入口，仅管理员可创建账号。'
              : mode === 'invite'
                ? '必须填写管理员生成的邀请码；每个邀请码只能注册一个账号。'
                : '任何能访问本服务的人都可以注册。'
          }
        >
          {(control) => (
            <Radio.Group
              {...control}
              className="settings-registration-modes"
              optionType="button"
              buttonStyle="solid"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              options={[
                { value: 'closed', label: '关闭注册' },
                { value: 'invite', label: '仅限邀请码' },
                { value: 'open', label: '开放注册' },
              ]}
            />
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="注册赠送" description="仅适用于自助注册，不影响管理员手动创建的账号。">
        <SettingsRow
          label="赠送额度"
          description={
            draft.allow_register
              ? '新账号获得的初始余额；设为 0 则不赠送。'
              : '注册已关闭，此值保留但不生效。'
          }
        >
          {(control) => (
            <InputNumber
              {...control}
              className="settings-control"
              min={0}
              step={1}
              precision={2}
              addonBefore="$"
              disabled={disabled || !draft.allow_register}
              value={draft.init_quota_usd}
              onChange={(value) => patch({ init_quota_usd: value ?? 0 })}
            />
          )}
        </SettingsRow>
        {openGrant && (
          <Alert
            type="warning"
            showIcon
            message={`开放注册且每个新账号赠送 $${draft.init_quota_usd}`}
            description="若服务可从公网访问，访客可以反复注册领取额度，消耗你的上游支出。"
          />
        )}
      </SettingsSection>
    </SettingsForm>
  )
}
