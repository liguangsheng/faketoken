/**
 * Global settings.
 *
 * One draft, five tabs, one save. Every tab renders out of the same draft and
 * writes back through one `patch`, so "unsaved changes" is a single question
 * with a single answer — and the tab strip can mark which tabs hold them.
 */

import { el, on, replace } from '../../driver/dom.js'
import { api } from '../../core/api.js'
import * as consoleSettings from '../../core/settings.js'
import { formatBytes } from '../../core/format.js'
import {
  banner,
  button,
  card,
  numberInput,
  pageHeader,
  select,
  toggle,
} from '../../ui/controls.js'
import { skeleton } from '../../ui/feedback.js'
import { confirmModal } from '../../ui/modal.js'
import { tabs } from '../../ui/tabs.js'
import { ICONS } from '../../ui/icons.js'
import { errorText, toast } from '../../ui/toast.js'
import { renderBlocklist, settingsRow } from './blocklist.js'
import { BODY_LIMIT_OPTIONS, PAGE_SIZE_OPTIONS, blocklistStats, fieldChanged } from './shared.js'

/**
 * Which tab owns which field.
 *
 * This is the only list of that mapping: the tab strip, the per-tab unsaved
 * marker and the overall dirty check are all derived from it. A field added to
 * a panel without being named here would edit fine and then quietly fail to
 * register as a change.
 */
const TABS = [
  {
    key: 'general',
    label: '通用',
    fields: ['default_page_size', 'import_priority', 'import_weight'],
  },
  {
    key: 'registration',
    label: '注册与邀请',
    fields: ['allow_register', 'require_invite_code', 'init_quota_usd'],
  },
  { key: 'relay', label: '转发与重试', fields: ['max_retries', 'retry_backoff_ms'] },
  { key: 'logging', label: '日志留存', fields: ['log_detail_keep', 'log_body_limit'] },
  { key: 'blocklist', label: '屏蔽规则', fields: ['blocked_status', 'block_rules'] },
]

const clone = (value) => structuredClone(value)

export function renderSettings(container) {
  // What the draft was seeded from. Dirty is measured against this rather
  // than against the live settings: a refresh landing mid-edit must neither
  // eat the edit nor make the form claim changes it does not have.
  let baseline = clone(consoleSettings.get())
  let draft = clone(baseline)
  let tab = TABS[0].key
  let disposed = false
  // Which blocklist groups are expanded; owned here so it survives repaints.
  const openGroups = new Set()

  const tabsSlot = el('div')
  const panelSlot = el('div')
  const saveSlot = el('div')
  const noticeSlot = el('div')

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '全局设置',
        description: '这里的配置存放在服务端，对所有用户和所有浏览器生效。',
      }),
      noticeSlot,
      el('div', { class: 'settings-page' }, [tabsSlot, panelSlot, saveSlot]),
    ]),
  )

  // ---- state -------------------------------------------------------------

  const dirtyTabs = () =>
    new Set(
      TABS.filter((entry) => entry.fields.some((field) => fieldChanged(draft, baseline, field))).map(
        (entry) => entry.key,
      ),
    )
  const isDirty = () => dirtyTabs().size > 0

  const patch = (next) => {
    Object.assign(draft, next)
    paint()
  }

  const discard = () => {
    draft = clone(baseline)
    openGroups.clear()
    paint()
  }

  // Closing the tab with unsaved global settings deserves one browser prompt.
  const offUnload = on(window, 'beforeunload', (event) => {
    if (!isDirty()) return
    event.preventDefault()
    // Older Chromium ignores a bare preventDefault for this event.
    event.returnValue = ''
  })

  // ---- save --------------------------------------------------------------

  async function persist() {
    try {
      const saved = await api.admin.updateSettings(draft)
      consoleSettings.apply(saved)
      // Adopted as the new draft, not only as the new settings: the server
      // normalises the rule groups, and leaving the pre-normalisation draft in
      // place would show "unsaved changes" over a form that was just saved.
      baseline = clone(saved)
      draft = clone(saved)
      toast.success('设置已保存')
      paint()
    } catch (error) {
      toast.error(errorText(error, '保存失败'))
    }
  }

  async function save() {
    if (!consoleSettings.isLoaded()) {
      toast.error('设置尚未加载成功，保存会覆盖服务端已有配置')
      return
    }

    // The server rejects the whole document over this, and the reason is two
    // tabs away from the button — better to name it here than to round-trip.
    const { oversizedReplies } = blocklistStats(draft)
    if (oversizedReplies > 0) {
      toast.error(`屏蔽规则里有 ${oversizedReplies} 条回复超长，服务端会拒绝保存`)
      tab = 'blocklist'
      paint()
      return
    }

    // Lowering the keep-count deletes captured bodies immediately and
    // irreversibly; that is worth one explicit confirmation.
    if (draft.log_detail_keep < baseline.log_detail_keep) {
      const confirmed = await confirmModal({
        title:
          draft.log_detail_keep === 0
            ? '停止记录并清空全部已保留的调用正文？'
            : `把保留条数降到 ${draft.log_detail_keep}？`,
        description: '超出条数的请求 / 响应正文会被立即删除，且无法恢复。',
        okText: '确认保存',
        danger: true,
      })
      if (!confirmed) return
    }

    await persist()
  }

  // ---- tabs --------------------------------------------------------------

  // Built once; repaints only restyle it. Rebuilding the strip on every
  // keystroke would steal focus from the field being typed in.
  const strip = tabs({
    items: TABS.map((entry) => ({ key: entry.key, label: entry.label })),
    value: tab,
    ariaLabel: '设置分组',
    onChange: (key) => {
      tab = key
      paint()
    },
  })
  tabsSlot.append(strip)

  function paintTabs() {
    strip.setValue(tab)
    // A change in another tab has to be visible from here, or it is only
    // found on the way back.
    strip.setMarked(dirtyTabs())
  }

  // ---- panels ------------------------------------------------------------

  const PANELS = {
    general: () =>
      el('div', { class: 'settings-form' }, [
        el('div', { class: 'settings-section__title' }, '列表显示'),
        settingsRow({
          label: '默认每页条数',
          help: '渠道、用户、日志等列表首次打开时的每页条数；每个列表仍可临时切换。',
          control: select({
            value: draft.default_page_size,
            ariaLabel: '默认每页条数',
            options: PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} 条` })),
            onChange: (value) => patch({ default_page_size: Number(value) }),
          }),
        }),
        el('div', { class: 'settings-section__title' }, '渠道快速导入'),
        settingsRow({
          label: '默认优先级',
          help: '快速导入新建渠道时预填的优先级，数值越大越优先。导入到已存在的渠道时不会覆盖它原有的值。',
          control: numberField({
            value: draft.import_priority,
            min: -1000000,
            max: 1000000,
            ariaLabel: '默认优先级',
            onChange: (value) => patch({ import_priority: value ?? 0 }),
          }),
        }),
        settingsRow({
          label: '默认权重',
          help: '同优先级的渠道之间按权重随机分配流量。至少为 1，为 0 的渠道永远不会被选中。',
          control: numberField({
            value: draft.import_weight,
            min: 1,
            max: 1000000,
            ariaLabel: '默认权重',
            onChange: (value) => patch({ import_weight: value ?? 1 }),
          }),
        }),
      ]),

    registration: () => {
      // Reachable by anyone with the URL, and paid for out of the operator's
      // upstream spend. Worth one warning while all three are true.
      const openGrant =
        draft.allow_register && !draft.require_invite_code && draft.init_quota_usd > 0

      let inviteState = '任何人都可以直接注册'
      if (!draft.allow_register) inviteState = '注册已关闭，此项无效'
      else if (draft.require_invite_code) inviteState = '需要邀请码'

      return el('div', { class: 'settings-form' }, [
        settingsRow({
          label: '开放注册',
          help: '关闭后访客无法自助注册，登录页也不再显示注册入口；管理员仍可手动创建账号。',
          control: switchField({
            checked: draft.allow_register,
            ariaLabel: '开放注册',
            caption: draft.allow_register ? '任何人都可以注册' : '仅管理员可创建账号',
            onChange: (checked) => patch({ allow_register: checked }),
          }),
        }),
        settingsRow({
          label: '注册需要邀请码',
          help: '开启后，访客必须填写管理员生成的邀请码才能注册。一个邀请码只能注册一个账号。',
          control: switchField({
            checked: draft.require_invite_code,
            disabled: !draft.allow_register,
            ariaLabel: '注册需要邀请码',
            caption: inviteState,
            onChange: (checked) => patch({ require_invite_code: checked }),
          }),
        }),
        settingsRow({
          label: '注册赠送额度（美元）',
          help: draft.allow_register
            ? '用户自助注册后获得的初始余额；管理员手动创建的账号不受影响。'
            : '注册已关闭，此项无效。',
          control: numberField({
            value: draft.init_quota_usd,
            min: 0,
            step: 1,
            disabled: !draft.allow_register,
            ariaLabel: '注册赠送额度',
            onChange: (value) => patch({ init_quota_usd: value ?? 0 }),
          }),
        }),
        openGrant &&
          banner({
            type: 'warning',
            title: `开放注册且每个新账号赠送 $${draft.init_quota_usd}`,
            description: '若本服务可从公网访问，任何人都能反复注册领取额度，消耗的是你的上游支出。',
          }),
      ])
    },

    relay: () =>
      el('div', { class: 'settings-form' }, [
        settingsRow({
          label: '最大重试次数',
          help: '单次请求最多访问多少个渠道。渠道自己配的重试次数会先用完，然后才换下一个渠道。',
          control: numberField({
            value: draft.max_retries,
            min: 1,
            max: 20,
            suffix: '次',
            ariaLabel: '最大重试次数',
            onChange: (value) => patch({ max_retries: value ?? 1 }),
          }),
        }),
        settingsRow({
          label: '重试间隔',
          help: '换到下一个渠道重试前的停顿基数，按尝试次数递增，上限 2 秒。设为 0 则不等待。渠道自己配了重试间隔时以渠道为准；上游返回 Retry-After 时，该渠道的熔断冷却直接采用上游给定的时间。',
          control: numberField({
            value: draft.retry_backoff_ms,
            min: 0,
            max: 10000,
            step: 50,
            suffix: '毫秒',
            ariaLabel: '重试间隔',
            onChange: (value) => patch({ retry_backoff_ms: value ?? 0 }),
          }),
        }),
      ]),

    logging: () => {
      // Both fields multiply into the disk estimate, which is why they share a
      // tab: raising one without seeing the other is how a log directory fills.
      const footprint = formatBytes(draft.log_detail_keep * draft.log_body_limit * 2)

      return el('div', { class: 'settings-form' }, [
        el('div', { class: 'settings-section__title' }, '完整正文留存'),
        settingsRow({
          label: '保留条数',
          help: '在「调用日志 → 点开某一行」中查看请求和响应原文。超出条数的旧记录会自动删除；设为 0 表示不记录，并清空已有正文。',
          control: numberField({
            value: draft.log_detail_keep,
            min: 0,
            max: 20000,
            step: 100,
            suffix: '次',
            ariaLabel: '保留最近多少次调用的完整正文',
            onChange: (value) => patch({ log_detail_keep: value ?? 0 }),
          }),
        }),
        settingsRow({
          label: '单条上限',
          help: '单条请求或响应保留的最大字节数，超出部分截断。',
          control: select({
            value: draft.log_body_limit,
            ariaLabel: '正文保留上限',
            options: BODY_LIMIT_OPTIONS,
            onChange: (value) => patch({ log_body_limit: Number(value) }),
          }),
        }),
        draft.log_detail_keep > 0 &&
          banner({
            title: `最多约占用 ${footprint}`,
            description: '按每次调用的请求与响应各达到单条上限估算；实际正文通常远小于上限。',
          }),
      ])
    },

    blocklist: () => renderBlocklist({ draft, patch, open: openGroups }),
  }

  function paintPanel() {
    replace(panelSlot, card({ body: PANELS[tab]() }))
  }

  function paintSaveBar() {
    if (!isDirty()) {
      replace(saveSlot, null)
      return
    }
    replace(
      saveSlot,
      el('div', { class: 'settings-savebar' }, [
        el('span', { class: 'text-muted text-small' }, '有未保存的修改'),
        el('div', { class: 'row' }, [
          button({ label: '放弃修改', onClick: discard }),
          button({
            label: '保存',
            variant: 'primary',
            glyph: ICONS.save,
            disabled: !consoleSettings.isLoaded(),
            onClick: save,
          }),
        ]),
      ]),
    )
  }

  function paintNotice() {
    if (consoleSettings.isLoaded()) {
      replace(noticeSlot, null)
      return
    }
    // Editable defaults under a red warning would read as "loading failed";
    // the form still renders, but saving is refused until a real read lands.
    const notice = banner({
      type: 'warning',
      title: '没能读取到服务端设置',
      description: '下面显示的是默认值，不是当前配置。保存已被禁用，以免覆盖服务端已有的设置。',
    })
    notice.append(
      el(
        'div',
        { style: { marginInlineStart: 'auto', alignSelf: 'center' } },
        button({
          label: '重试',
          onClick: async () => {
            await consoleSettings.refresh()
            if (disposed) return
            if (consoleSettings.isLoaded() && !isDirty()) {
              baseline = clone(consoleSettings.get())
              draft = clone(baseline)
            }
            paint()
          },
        }),
      ),
    )
    replace(noticeSlot, notice)
  }

  function paint() {
    if (disposed) return
    paintNotice()
    paintTabs()
    paintPanel()
    paintSaveBar()
  }

  // A page that renders the fallback while the settings are still in flight
  // would let an operator edit defaults and save them over the real config.
  if (consoleSettings.isLoaded()) {
    paint()
  } else {
    replace(panelSlot, card({ body: skeleton(10) }))
    void consoleSettings.refresh().then(() => {
      if (disposed) return
      baseline = clone(consoleSettings.get())
      draft = clone(baseline)
      paint()
    })
  }

  return () => {
    disposed = true
    offUnload()
  }
}

/** A number input sized for a settings row, with an optional unit after it. */
function numberField({ value, min, max, step = 1, suffix = null, disabled = false, ariaLabel, onChange }) {
  const control = numberInput({ value, min, max, step })
  control.classList.add('settings-control')
  control.disabled = disabled
  control.setAttribute('aria-label', ariaLabel)
  control.addEventListener('input', () => onChange(control.read()))
  if (!suffix) return control
  return el('div', { class: 'row' }, [control, el('span', { class: 'text-muted text-small' }, suffix)])
}

/** A switch with a caption stating what the current position means. */
function switchField({ checked, disabled = false, ariaLabel, caption, onChange }) {
  const control = toggle({
    checked,
    disabled,
    ariaLabel,
    onChange: (next, node) => {
      node.setChecked(next)
      onChange(next)
    },
  })
  return el('div', { class: 'row' }, [control, el('span', { class: 'text-muted text-small' }, caption)])
}
