import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Card, Skeleton, Space, Typography } from 'antd'
import { SaveOutlined } from '@ant-design/icons'

import { api, type ConsoleSettings } from '../../api/client'
import PageHeader from '../../components/PageHeader'
import { useSettings } from '../../settings/SettingsContext'
import BlocklistPanel from './settings/BlocklistPanel'
import GeneralPanel from './settings/GeneralPanel'
import LoggingPanel from './settings/LoggingPanel'
import RegistrationPanel from './settings/RegistrationPanel'
import RelayPanel from './settings/RelayPanel'
import { blocklistStats } from './settings/shared'

/**
 * Which tab owns which field.
 *
 * This is the only list of that mapping: the tab strip, the per-tab unsaved
 * marker and the overall dirty check are all derived from it, so a field added
 * to a panel without being named here would edit fine and then quietly fail to
 * register as a change. The type below makes that a compile error instead.
 */
const TABS = [
  {
    key: 'general',
    label: '通用',
    fields: ['default_page_size', 'import_priority', 'import_weight'],
    Panel: GeneralPanel,
  },
  {
    key: 'registration',
    label: '注册与邀请',
    fields: ['allow_register', 'require_invite_code', 'init_quota_usd'],
    Panel: RegistrationPanel,
  },
  {
    key: 'relay',
    label: '转发与重试',
    fields: ['max_retries', 'retry_backoff_ms'],
    Panel: RelayPanel,
  },
  {
    key: 'logging',
    label: '日志留存',
    fields: ['log_detail_keep', 'log_body_limit'],
    Panel: LoggingPanel,
  },
  {
    key: 'blocklist',
    label: '屏蔽规则',
    fields: ['blocked_status', 'block_rules'],
    Panel: BlocklistPanel,
  },
] as const satisfies readonly {
  key: string
  label: string
  fields: readonly (keyof ConsoleSettings)[]
  Panel: (props: {
    draft: ConsoleSettings
    patch: (patch: Partial<ConsoleSettings>) => void
  }) => JSX.Element
}[]

/** Fails to compile if a settings field is claimed by no tab at all. */
type Claimed = (typeof TABS)[number]['fields'][number]
const _exhaustive: Record<keyof ConsoleSettings, Claimed> = {} as Record<Claimed, Claimed>
void _exhaustive

/** block_rules is the only non-primitive, so one deep compare covers it. */
const changed = (a: ConsoleSettings, b: ConsoleSettings, field: keyof ConsoleSettings) =>
  field === 'block_rules'
    ? JSON.stringify(a.block_rules) !== JSON.stringify(b.block_rules)
    : a[field] !== b[field]

export default function Settings() {
  const { message, modal } = App.useApp()
  const { settings, apply, ready, loaded, refresh } = useSettings()
  const [draft, setDraft] = useState<ConsoleSettings>(settings)
  const [tab, setTab] = useState<string>(TABS[0].key as string)
  const [saving, setSaving] = useState(false)
  // Guards the sync below: a refresh landing mid-edit must not eat the edit.
  const dirtyRef = useRef(false)

  useEffect(() => {
    if (!dirtyRef.current) setDraft(settings)
  }, [settings])

  const dirtyTabs = new Set(
    TABS.filter((entry) => entry.fields.some((field) => changed(draft, settings, field))).map(
      (entry) => entry.key,
    ),
  )
  const dirty = dirtyTabs.size > 0
  dirtyRef.current = dirty

  // Closing the tab with unsaved global settings deserves one browser prompt.
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older Chromium ignores a bare preventDefault for this event.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const persist = async () => {
    setSaving(true)
    try {
      const saved = await api.admin.updateSettings(draft)
      apply(saved)
      // Adopted as the new draft, not only as the new settings: the server
      // normalises the rule groups, and leaving the pre-normalisation draft in
      // place would leave "unsaved changes" showing over a saved form.
      setDraft(saved)
      message.success('设置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    if (!loaded) {
      message.error('设置尚未加载成功，保存会覆盖服务端已有配置')
      return
    }
    // The server rejects the whole document over this, and the reason is two
    // tabs away from the button — better to name it here than to round-trip.
    const { oversizedReplies } = blocklistStats(draft)
    if (oversizedReplies > 0) {
      message.error(`屏蔽规则里有 ${oversizedReplies} 条回复超长，服务端会拒绝保存`)
      setTab('blocklist')
      return
    }
    // Lowering the keep-count deletes captured bodies immediately and
    // irreversibly; that is worth one explicit confirmation.
    if (draft.log_detail_keep < settings.log_detail_keep) {
      modal.confirm({
        title:
          draft.log_detail_keep === 0
            ? '停止记录并清空全部已保留的调用正文？'
            : `把保留条数降到 ${draft.log_detail_keep}？`,
        content: '超出条数的请求 / 响应正文会被立即删除，且无法恢复。',
        okText: '确认保存',
        okButtonProps: { danger: true },
        onOk: persist,
      })
      return
    }
    await persist()
  }

  const active = TABS.find((entry) => entry.key === tab) ?? TABS[0]
  const patch = (next: Partial<ConsoleSettings>) => setDraft({ ...draft, ...next })

  return (
    <>
      <PageHeader
        title="全局设置"
        description="这里的配置存放在服务端，对所有用户和所有浏览器生效。"
      />

      {/* 首次加载中不渲染表单：可编辑的默认值配上红色告警是在把「加载中」演成「加载失败」 */}
      {!ready ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <Space direction="vertical" size={12} className="settings-page">
          {!loaded && (
            <Alert
              type="error"
              showIcon
              message="没能读取到服务端设置"
              description="下面显示的是默认值，不是当前配置。保存已被禁用，以免覆盖服务端已有的设置。"
              action={
                <Button size="small" onClick={() => void refresh()}>
                  重试
                </Button>
              }
            />
          )}

          <Card
            activeTabKey={active.key}
            onTabChange={setTab}
            tabList={TABS.map((entry) => ({
              key: entry.key,
              label: (
                <span className="settings-tab">
                  {entry.label}
                  {/* 改动在别的页签里也要看得见，否则切回去才发现自己漏了一处 */}
                  {dirtyTabs.has(entry.key) && (
                    <span className="settings-tab__dot" aria-label="有未保存的修改" />
                  )}
                </span>
              ),
            }))}
          >
            <active.Panel draft={draft} patch={patch} />
          </Card>

          {dirty && (
            <div className="settings-savebar">
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                有未保存的修改
              </Typography.Text>
              <Space size={8}>
                <Button onClick={() => setDraft(settings)}>放弃修改</Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  disabled={!loaded}
                  onClick={() => void save()}
                >
                  保存
                </Button>
              </Space>
            </div>
          )}
        </Space>
      )}
    </>
  )
}
