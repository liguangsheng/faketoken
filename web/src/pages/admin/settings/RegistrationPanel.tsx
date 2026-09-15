import { Alert, Form, InputNumber, Space, Switch, Typography } from 'antd'

import SettingsForm from './SettingsForm'
import type { PanelProps } from './shared'

/**
 * Who may create an account, and what they get for it.
 *
 * The three fields form one chain — registration gates the invite requirement,
 * which gates whether the grant is reachable by a stranger — so they are read
 * top to bottom, and the two dependants say plainly when they are inert.
 */
export default function RegistrationPanel({ draft, patch }: PanelProps) {
  // Reachable by anyone with the URL, and paid for out of the operator's
  // upstream spend. Worth one warning while both are true.
  const openGrant = draft.allow_register && !draft.require_invite_code && draft.init_quota_usd > 0

  return (
    <SettingsForm>
      <Form.Item
        label="开放注册"
        help="关闭后访客无法自助注册，登录页也不再显示注册入口；管理员仍可手动创建账号。"
      >
        <Space size={10}>
          <Switch
            aria-label="开放注册"
            checked={draft.allow_register}
            onChange={(checked) => patch({ allow_register: checked })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {draft.allow_register ? '任何人都可以注册' : '仅管理员可创建账号'}
          </Typography.Text>
        </Space>
      </Form.Item>

      <Form.Item
        label="注册需要邀请码"
        help="开启后，访客必须填写管理员生成的邀请码才能注册。一个邀请码只能注册一个账号。"
      >
        <Space size={10}>
          <Switch
            aria-label="注册需要邀请码"
            checked={draft.require_invite_code}
            disabled={!draft.allow_register}
            onChange={(checked) => patch({ require_invite_code: checked })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {!draft.allow_register
              ? '注册已关闭，此项无效'
              : draft.require_invite_code
                ? '需要邀请码'
                : '任何人都可以直接注册'}
          </Typography.Text>
        </Space>
      </Form.Item>

      <Form.Item
        label="注册赠送额度"
        help={
          draft.allow_register
            ? '用户自助注册后获得的初始余额；管理员手动创建的账号不受影响。'
            : '注册已关闭，此项无效。'
        }
        className={openGrant ? undefined : 'settings-form__last'}
      >
        <InputNumber
          aria-label="注册赠送额度"
          className="settings-control"
          min={0}
          step={1}
          precision={2}
          addonBefore="$"
          disabled={!draft.allow_register}
          value={draft.init_quota_usd}
          onChange={(value) => patch({ init_quota_usd: value ?? 0 })}
        />
      </Form.Item>

      {openGrant && (
        <Alert
          type="warning"
          showIcon
          message={`开放注册且每个新账号赠送 $${draft.init_quota_usd}`}
          description="若本服务可从公网访问，任何人都能反复注册领取额度，消耗的是你的上游支出。"
        />
      )}
    </SettingsForm>
  )
}
