import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, ConfigProvider, Skeleton, Space, Tabs, Typography } from 'antd'
import { SaveOutlined } from '@ant-design/icons'

import { api, type ConsoleSettings } from '../../api/client'
import PageHeader from '../../components/PageHeader'
import { useSettings } from '../../settings/SettingsContext'
import BlocklistPanel from './settings/BlocklistPanel'
import GeneralPanel from './settings/GeneralPanel'
import LoggingPanel from './settings/LoggingPanel'
import RegistrationPanel from './settings/RegistrationPanel'
import RelayPanel from './settings/RelayPanel'
import SettingsChanges from './settings/SettingsChanges'
import { blocklistStats, type PanelProps } from './settings/shared'

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
    fields: ['max_retries', 'retry_backoff_ms', 'relay_timeout_secs', 'stream_idle_secs'],
    Panel: RelayPanel,
  },
  {
    key: 'logging',
    label: '日志留存',
    fields: ['log_detail_keep', 'log_failed_keep_days', 'log_body_limit'],
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
  Panel: (props: PanelProps) => JSX.Element
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
  // What the draft was seeded from, which is not always the current settings:
  // a refresh can land while the form is being edited.
  //
  // Dirty is measured against this rather than against the live settings, and
  // that is load-bearing. Measured against the live settings, the render that
  // first sees a newly arrived value computes dirty from the stale draft, so
  // the guard below is already true by the time the effect runs and the draft
  // is never adopted — leaving the form on the old values while claiming
  // unsaved changes, and saving those old values back over the new ones.
  const [baseline, setBaseline] = useState<ConsoleSettings>(settings)
  const [tab, setTab] = useState<string>(TABS[0].key as string)
  const [saving, setSaving] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const savingRef = useRef(false)
  // Guards the sync below: a refresh landing mid-edit must not eat the edit.
  const dirtyRef = useRef(false)

  const dirtyFields = TABS.flatMap((entry) =>
    entry.fields.filter((field) => changed(draft, baseline, field)),
  )
  const dirtyTabs = new Set(
    TABS.filter((entry) => entry.fields.some((field) => dirtyFields.includes(field))).map(
      (entry) => entry.key,
    ),
  )
  const dirty = dirtyFields.length > 0
  dirtyRef.current = dirty

  useEffect(() => {
    if (dirtyRef.current) return
    setDraft(settings)
    setBaseline(settings)
  }, [settings])

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
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const saved = await api.admin.updateSettings(draft)
      apply(saved)
      // Adopted as the new draft, not only as the new settings: the server
      // normalises the rule groups, and leaving the pre-normalisation draft in
      // place would leave "unsaved changes" showing over a saved form.
      setDraft(saved)
      setBaseline(saved)
      message.success('设置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      savingRef.current = false
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

  const patch = (next: Partial<ConsoleSettings>) => {
    if (savingRef.current || !loaded) return
    setDraft((current) => ({ ...current, ...next }))
  }

  return (
    <div className="settings-page">
      <PageHeader
        title="全局设置"
        description="保存后对所有用户和浏览器生效，无需重启服务。"
      />

      {/* 首次加载中不渲染表单：可编辑的默认值配上红色告警是在把「加载中」演成「加载失败」 */}
      {!ready ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
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

          <Tabs
            className="settings-tabs"
            activeKey={tab}
            onChange={setTab}
            destroyOnHidden
            items={TABS.map((entry) => ({
              key: entry.key,
              label: (
                <span className="settings-tab">
                  {entry.label}
                  {dirtyTabs.has(entry.key) && (
                    <span className="settings-tab__dot" aria-label="有未保存的修改" />
                  )}
                </span>
              ),
              children: (
                <ConfigProvider componentDisabled={saving || !loaded}>
                  <div className="settings-panel">
                    <entry.Panel
                      draft={draft}
                      saved={settings}
                      disabled={saving || !loaded}
                      patch={patch}
                    />
                  </div>
                </ConfigProvider>
              ),
            }))}
          />

          <div className="settings-savebar">
            <div className="settings-savebar__status" aria-live="polite">
              <Typography.Text type="secondary">
                {!loaded
                  ? '配置尚未加载'
                  : dirty
                    ? `已修改 ${dirtyFields.length} 项`
                    : '没有未保存的修改'}
              </Typography.Text>
              {dirty && (
                <Button type="link" size="small" onClick={() => setReviewing(true)}>
                  查看变更
                </Button>
              )}
            </div>
            <Space size={8}>
              <Button
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(settings)
                  setBaseline(settings)
                }}
              >
                放弃修改
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!loaded || !dirty}
                onClick={() => void save()}
              >
                保存全部
              </Button>
            </Space>
          </div>
          <SettingsChanges
            open={reviewing}
            onClose={() => setReviewing(false)}
            before={baseline}
            after={draft}
            fields={dirtyFields}
          />
        </>
      )}
    </div>
  )
}
