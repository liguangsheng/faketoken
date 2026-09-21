/**
 * The channel form.
 *
 * Seventeen fields, folded into three groups so a new channel needs three of
 * them and the rest wait. The stored upstream key is fetched on open and
 * shown masked: an edit should not have to retype a secret to change a
 * timeout, and the plaintext should not sit on a shared screen.
 */

import { el, icon, replace } from '../../driver/dom.js'
import { api } from '../../core/api.js'
import {
  STATUS,
  parseEffortRules,
  parseHeaders,
  parseList,
  parseMapping,
  stringifyEffortRules,
  stringifyHeaders,
  stringifyMapping,
} from '../../core/format.js'
import {
  banner,
  button,
  checkboxGroup,
  field,
  input,
  numberInput,
  select,
  tagInput,
  textarea,
  timeInput,
  toggle,
} from '../../ui/controls.js'
import { confirmModal, openModal } from '../../ui/modal.js'
import { ICONS } from '../../ui/icons.js'
import { errorText, toast } from '../../ui/toast.js'
import { openModelPicker } from './modelPicker.js'
import {
  AUTH_STYLES,
  MAX_PRIORITY,
  MAX_WEIGHT,
  MIN_PRIORITY,
  MIN_WEIGHT,
  TEST_PROTOCOLS,
  withConfigured,
} from './shared.js'

const ALL_PROTOCOLS = TEST_PROTOCOLS.map((item) => item.value)

const DEFAULTS = {
  name: '',
  base_url: '',
  auth_style: 'auto',
  api_key: '',
  status: STATUS.ENABLED,
  priority: 0,
  weight: 1,
  groups: ['default'],
  models: [],
  model_prefixes: [],
  model_mapping: {},
  reasoning_effort_mapping: {},
  headers: {},
  timeout_secs: 0,
  proxy_url: '',
  price_ratio: 1,
  rpm_limit: 0,
  retry_count: 0,
  retry_backoff_ms: 0,
  test_model: '',
  supported_protocols: ALL_PROTOCOLS,
  allow_attachments: true,
  lock_user_agent: false,
  locked_user_agents: {},
  note: '',
  keepalive_enabled: false,
  keepalive_at: '',
  keepalive_target: 0,
}

/**
 * Opens the form.
 *
 *   { channel?, overrides?, groupOptions, onSaved, onPatched }
 *
 * `channel` is the row being edited, or undefined for a new one. `overrides`
 * let the quick import seed the form in one write. `onPatched` reports a row
 * changed in place (a UA lock cleared) so the listing can patch it without a
 * reload.
 */
export function openChannelDrawer({ channel, overrides = {}, groupOptions, onSaved, onPatched }) {
  const editing = Boolean(channel)
  let current = channel ?? null
  const seed = { ...DEFAULTS, ...(channel ?? {}), ...overrides }
  // Never seeded from the row: the listing carries a masked key, and the
  // real one is fetched below unless the import supplied one.
  const overrideKey = typeof overrides.api_key === 'string' ? overrides.api_key : ''
  seed.api_key = overrideKey

  let touched = false
  const markTouched = () => {
    touched = true
  }

  // ---- basic --------------------------------------------------------------

  const name = input({ id: 'ch-name', value: seed.name, placeholder: '例如：主渠道' })
  const baseURL = input({ id: 'ch-url', value: seed.base_url, placeholder: 'https://api.openai.com' })
  const apiKey = input({
    id: 'ch-key',
    type: 'password',
    value: seed.api_key,
    autocomplete: 'new-password',
    placeholder: editing ? '未设置' : 'sk-...',
  })
  apiKey.classList.add('mono')

  const nameField = field({ label: '名称', control: name, htmlFor: 'ch-name' })
  const urlField = field({
    label: '接口地址',
    control: baseURL,
    htmlFor: 'ch-url',
    hint: '填到域名即可，例如 https://api.openai.com；末尾带 /v1 也能正确识别。',
  })
  const keyField = field({
    label: '上游密钥',
    control: apiKey,
    htmlFor: 'ch-key',
    hint: editing ? '当前显示已存储的明文密钥，修改后会覆盖原密钥。' : '会以 AES-256-GCM 加密后落库。',
  })

  // ---- routing ------------------------------------------------------------

  const priority = numberInput({ id: 'ch-priority', value: seed.priority, min: MIN_PRIORITY, max: MAX_PRIORITY, step: 1 })
  const weight = numberInput({ id: 'ch-weight', value: seed.weight, min: MIN_WEIGHT, max: MAX_WEIGHT, step: 1 })
  // 0 is refused here rather than accepted and quietly turned into 1 by the
  // server: unlike a user group, a channel has no "free" setting.
  const priceRatio = numberInput({ id: 'ch-ratio', value: seed.price_ratio, min: 0.01, step: 0.1 })

  const groups = tagInput({
    value: seed.groups,
    options: groupOptions.map((option) => option.value),
    placeholder: 'default',
    ariaLabel: '可用分组',
    onChange: markTouched,
  })

  const models = tagInput({
    value: seed.models,
    placeholder: '输入模型名后回车，或从上游拉取',
    ariaLabel: '支持的模型',
    onChange: markTouched,
  })

  const fetchButton = button({
    label: '从上游拉取',
    variant: 'link',
    glyph: ICONS.download,
    onClick: () => fetchModels(),
  })

  const mapping = textarea({
    id: 'ch-mapping',
    value: stringifyMapping(seed.model_mapping),
    rows: 3,
    placeholder: 'gpt-4o=gpt-4o-2024-11-20',
  })
  mapping.classList.add('mono')

  // ---- advanced -----------------------------------------------------------

  const timeout = numberInput({ id: 'ch-timeout', value: seed.timeout_secs, min: 0, step: 1 })
  const rpm = numberInput({ id: 'ch-rpm', value: seed.rpm_limit, min: 0, step: 1 })
  const retryCount = numberInput({ id: 'ch-retries', value: seed.retry_count, min: 0, max: 20, step: 1 })
  const retryBackoff = numberInput({ id: 'ch-backoff', value: seed.retry_backoff_ms, min: 0, max: 60000, step: 50 })
  const status = select({
    id: 'ch-status',
    value: seed.status,
    options: [
      { value: STATUS.ENABLED, label: '启用' },
      { value: STATUS.DISABLED, label: '禁用' },
    ],
  })
  const authStyle = select({ id: 'ch-auth', value: seed.auth_style, options: AUTH_STYLES })

  const prefixes = textarea({
    id: 'ch-prefixes',
    value: (seed.model_prefixes ?? []).join('\n'),
    rows: 3,
    placeholder: 'gpt-4\nclaude-',
  })
  const testModel = input({ id: 'ch-test-model', value: seed.test_model, placeholder: '留空则取第一个支持的模型' })
  const protocols = checkboxGroup({
    options: TEST_PROTOCOLS,
    value: seed.supported_protocols ?? ALL_PROTOCOLS,
    ariaLabel: '支持的协议',
  })
  const attachments = toggle({
    checked: seed.allow_attachments !== false,
    ariaLabel: '允许附件',
    onChange: (checked, control) => {
      control.setChecked(checked)
      markTouched()
    },
  })
  const effort = textarea({
    id: 'ch-effort',
    value: stringifyEffortRules(seed.reasoning_effort_mapping),
    rows: 3,
    placeholder: '*:max=xhigh\ngpt-5.1:max=high',
  })
  effort.classList.add('mono')

  const lockUA = toggle({
    checked: Boolean(seed.lock_user_agent),
    ariaLabel: '自动锁定 User-Agent',
    onChange: (checked, control) => {
      control.setChecked(checked)
      markTouched()
    },
  })
  const uaBoxes = {}
  const uaSlot = el('div', { class: 'stack', style: { gap: '14px' } })
  const paintUA = () => {
    replace(
      uaSlot,
      TEST_PROTOCOLS.map((protocol) => {
        const value = current?.locked_user_agents?.[protocol.value] ?? ''
        const box = uaBoxes[protocol.value] ?? textarea({
          value: seed.locked_user_agents?.[protocol.value] ?? '',
          rows: 2,
          placeholder: `${protocol.label} 的上游 UA（可留空）`,
        })
        box.classList.add('mono')
        uaBoxes[protocol.value] = box

        return el('div', {}, [
          el('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
            el('strong', { class: 'text-small' }, protocol.label),
            editing &&
              button({
                label: '清除',
                variant: 'danger',
                size: null,
                disabled: !value,
                onClick: async () => {
                  try {
                    const updated = await api.admin.clearChannelUserAgent(current.id, protocol.value)
                    current = updated
                    lockUA.setChecked(updated.lock_user_agent)
                    box.value = updated.locked_user_agents?.[protocol.value] ?? ''
                    onPatched(updated)
                    toast.success('已清除该协议 UA 配置')
                    paintUA()
                  } catch (error) {
                    toast.error(errorText(error, '清除 UA 失败'))
                  }
                },
              }),
          ]),
          box,
        ])
      }),
    )
  }
  paintUA()

  const headers = textarea({
    id: 'ch-headers',
    value: stringifyHeaders(seed.headers),
    rows: 2,
    placeholder: 'X-Custom: value\nAuthorization: Bearer abc123==',
  })
  headers.classList.add('mono')
  const proxy = input({ id: 'ch-proxy', value: seed.proxy_url, placeholder: '留空表示直连' })

  // ---- keepalive ----------------------------------------------------------

  const keepaliveAt = timeInput({ id: 'ch-ka-at', value: seed.keepalive_at ?? '' })
  const keepaliveTarget = numberInput({ id: 'ch-ka-target', value: seed.keepalive_target, min: 0, step: 1 })
  const keepaliveAtField = field({
    label: '每天启用时间',
    control: keepaliveAt,
    htmlFor: 'ch-ka-at',
    hint: '按服务器时区。过了这个时刻，渠道一旦被禁用就会立刻开窗。',
  })
  const keepaliveTargetField = field({
    label: '目标成功次数',
    control: keepaliveTarget,
    htmlFor: 'ch-ka-target',
    hint: '窗口内累计这么多次成功请求后自动禁用该渠道。',
  })

  // The schedule fields are meaningless until keepalive is on.
  const paintKeepalive = (on) => {
    keepaliveAt.disabled = !on
    keepaliveTarget.disabled = !on
  }
  const keepalive = toggle({
    checked: Boolean(seed.keepalive_enabled),
    ariaLabel: '保活',
    onChange: (checked, control) => {
      control.setChecked(checked)
      paintKeepalive(checked)
      markTouched()
    },
  })
  paintKeepalive(keepalive.checked)

  const note = textarea({ id: 'ch-note', value: seed.note, rows: 2, placeholder: '仅管理员可见' })

  // ---- advanced disclosure ------------------------------------------------

  let advancedOpen = editing
  const advancedBody = el('div', { class: 'disclosure__body' }, [
    el('div', { class: 'form-cols' }, [
      field({ label: '超时（秒）', control: timeout, htmlFor: 'ch-timeout', hint: '0 表示使用全局默认。' }),
      field({ label: 'RPM 限制', control: rpm, htmlFor: 'ch-rpm', hint: '每分钟最大请求数，0 表示不限制。' }),
      field({
        label: '重试次数',
        control: retryCount,
        htmlFor: 'ch-retries',
        hint: '失败后在这个渠道上再试的次数，用完才换下一个渠道。0 表示不重试。',
      }),
      field({
        label: '重试间隔（毫秒）',
        control: retryBackoff,
        htmlFor: 'ch-backoff',
        hint: '同渠道重试前的等待基数，按重试次数递增，上限 30 秒。0 表示使用全局间隔。',
      }),
      field({ label: '状态', control: status, htmlFor: 'ch-status' }),
      field({
        label: '鉴权方式',
        control: authStyle,
        htmlFor: 'ch-auth',
        hint: '自动会根据客户端请求端点选择；仅在兼容网关要求特殊鉴权头时覆盖。',
      }),
    ]),
    field({
      label: '模型前缀',
      control: prefixes,
      htmlFor: 'ch-prefixes',
      hint: '每行一个前缀，例如 gpt-4 可覆盖 gpt-4o、gpt-4.1；只有当没有渠道精确匹配该模型时才生效。',
    }),
    field({
      label: '测试模型',
      control: testModel,
      htmlFor: 'ch-test-model',
      hint: '执行「模型测试」时的默认模型；留空则取第一个支持的模型，只配了前缀的渠道必须填。',
    }),
    field({
      label: '支持的协议',
      control: protocols,
      hint: '勾选上游实际支持的请求协议，路由时只会把对应协议的请求转发到此渠道。',
    }),
    field({
      label: '允许附件',
      control: attachments,
      hint: '关闭后，包含图片、文档、文件或音频等附件的会话请求会绕过该渠道，交给其他允许附件的渠道；都不允许才拒绝。',
    }),
    field({
      label: '思考强度映射',
      control: effort,
      htmlFor: 'ch-effort',
      hint: '每行 模型:客户端强度=上游强度。* 对该渠道所有模型生效，gpt-5* 匹配前缀；越具体的越优先。只改写 reasoning_effort / reasoning.effort / output_config.effort，没有规则的强度原样透传。',
    }),
    el('div', { class: 'detail-card', style: { marginBottom: '16px' } }, [
      el('div', { class: 'detail-card__title' }, 'User-Agent 锁定配置'),
      field({
        label: '自动锁定 User-Agent',
        control: lockUA,
        hint: '仅控制留空配置时是否在请求成功后自动记录请求 UA；手动填写的 UA 不受此开关影响。',
      }),
      uaSlot,
    ]),
    field({
      label: '附加请求头',
      control: headers,
      htmlFor: 'ch-headers',
      hint: '每行一个头，写成 Header-Name: value，可从 curl 或浏览器直接粘贴。其中的 User-Agent 会被上方锁定的 UA 覆盖。',
    }),
    field({ label: 'HTTP 代理', control: proxy, htmlFor: 'ch-proxy', hint: '例如 http://127.0.0.1:7890。' }),
    el('div', { class: 'form-divider' }, '保活'),
    el('div', { class: 'form-cols' }, [
      field({
        label: '保活',
        control: keepalive,
        hint: '每天定时把禁用中的渠道自动启用，攒够成功请求后自动禁用。到点时渠道本来就是启用状态，则不接管。',
      }),
      keepaliveAtField,
      keepaliveTargetField,
    ]),
    editing &&
      current?.keepalive_open &&
      banner({
        title: `保活窗口进行中：已成功 ${current.keepalive_success}/${current.keepalive_target} 次`,
        description: '保存表单不会重置进度；把状态改为禁用会放弃本轮窗口，次日到点再开。',
      }),
  ])

  const advancedHead = el(
    'button',
    {
      type: 'button',
      class: 'disclosure__head',
      'aria-expanded': advancedOpen ? 'true' : 'false',
      onclick: () => {
        advancedOpen = !advancedOpen
        advancedHead.setAttribute('aria-expanded', advancedOpen ? 'true' : 'false')
        advancedBody.style.display = advancedOpen ? '' : 'none'
        chevron.classList.toggle('expand-toggle--open', advancedOpen)
      },
    },
    [
      (() => {
        const node = el('span', { class: 'expand-toggle' }, icon(ICONS.chevronRight, { size: 12 }))
        node.classList.toggle('expand-toggle--open', advancedOpen)
        return node
      })(),
      el('strong', {}, '高级设置'),
      el('span', { class: 'text-muted text-small' }, '前缀 / 超时 / 鉴权 / 协议 / 代理 / 保活'),
    ],
  )
  const chevron = advancedHead.firstElementChild
  advancedBody.style.display = advancedOpen ? '' : 'none'

  // ---- form ---------------------------------------------------------------

  const form = el(
    'form',
    {
      novalidate: true,
      oninput: markTouched,
      onsubmit: (event) => {
        event.preventDefault()
        save.click()
      },
    },
    [
      el('div', { class: 'form-divider' }, '基本信息'),
      nameField,
      urlField,
      keyField,
      el('div', { class: 'form-divider' }, '路由与计费'),
      el('div', { class: 'form-cols' }, [
        field({ label: '优先级', control: priority, htmlFor: 'ch-priority', hint: '数值越大越优先。' }),
        field({ label: '权重', control: weight, htmlFor: 'ch-weight', hint: '同优先级内按权重随机分配。' }),
        field({
          label: '计费倍率',
          control: priceRatio,
          htmlFor: 'ch-ratio',
          hint: '该渠道的费用乘数，1 为原价。这里不支持 0；要让某个分组免费请到「分组倍率」设置。',
        }),
      ]),
      field({ label: '可用分组', control: groups, hint: '只有列在这里的分组，其用户才能路由到该渠道。' }),
      field({
        label: el('span', { class: 'row', style: { gap: '8px' } }, ['支持的模型', fetchButton]),
        control: models,
        hint: '每个模型是一个标签，点 × 可移除；粘贴用逗号、空格或换行分隔的列表会自动拆分。',
      }),
      field({
        label: '模型映射',
        control: mapping,
        htmlFor: 'ch-mapping',
        hint: '每行 客户端模型=上游模型，转发时只改写 model 字段。',
      }),
      el('div', { class: 'disclosure' }, [advancedHead, advancedBody]),
      field({ label: '备注', control: note, htmlFor: 'ch-note' }),
      el('button', { type: 'submit', hidden: true }),
    ],
  )

  // ---- credential ---------------------------------------------------------

  const save = button({ label: '保存', variant: 'primary', onClick: () => submit() })

  if (editing && !overrideKey) {
    apiKey.disabled = true
    apiKey.placeholder = '正在读取密钥…'
    save.disabled = true
    api.admin
      .channelCredential(channel.id)
      .then((credential) => {
        apiKey.value = credential.api_key
      })
      .catch((error) => {
        apiKey.placeholder = '读取失败；留空保存则保持原密钥'
        toast.error(errorText(error, '读取上游密钥失败'))
      })
      .finally(() => {
        apiKey.disabled = false
        save.disabled = false
      })
  }

  // ---- actions ------------------------------------------------------------

  /**
   * Probes whatever is currently typed, so a channel can be filled in before
   * it exists and a corrected address re-probed without saving first. An empty
   * key field still means "keep the stored one", resolved by channel_id.
   */
  async function fetchModels() {
    const url = baseURL.value.trim()
    if (!url) {
      toast.warning('请先填写接口地址')
      return
    }

    fetchButton.setBusy(true)
    try {
      const result = await api.admin.importChannel({
        channel_id: current?.id,
        base_url: url,
        api_key: apiKey.value.trim() || undefined,
        auth_style: authStyle.value,
      })
      if (result.model_error) {
        toast.error(`拉取失败：${result.model_error}`)
        return
      }
      if (result.models.length === 0) {
        toast.warning('上游返回了空的模型列表')
        return
      }

      const chosen = models.read()
      openModelPicker({
        models: withConfigured(result.models, chosen),
        upstream: result.models,
        initial: chosen,
        verb: '填入',
        // The selection is just another unsaved edit: it lands in the form
        // and is committed with everything else.
        onApply: (picked, close) => {
          models.setValue(picked)
          markTouched()
          close()
          toast.success(`已填入 ${picked.length} 个模型，保存后生效`)
        },
      })
    } catch (error) {
      toast.error(errorText(error, '拉取失败'))
    } finally {
      fetchButton.setBusy(false)
    }
  }

  async function submit() {
    nameField.setError(null)
    urlField.setError(null)
    keyField.setError(null)
    keepaliveAtField.setError(null)
    keepaliveTargetField.setError(null)

    let ok = true
    if (!name.value.trim()) {
      nameField.setError('请输入名称')
      ok = false
    }
    if (!baseURL.value.trim()) {
      urlField.setError('请输入接口地址')
      ok = false
    }
    if (!editing && !apiKey.value.trim()) {
      keyField.setError('请输入上游密钥')
      ok = false
    }
    // Only required once keepalive is on: a channel that claims to be kept
    // alive and never opens is worse than a rejected form.
    if (keepalive.checked) {
      if (!keepaliveAt.read()) {
        keepaliveAtField.setError('开启保活需要填写时间')
        ok = false
      }
      if ((keepaliveTarget.read() ?? 0) < 1) {
        keepaliveTargetField.setError('至少 1 次')
        ok = false
      }
    }
    if (!ok) {
      // The failing field may be folded away.
      if (keepalive.checked && !advancedOpen) advancedHead.click()
      return
    }

    const payload = {
      name: name.value.trim(),
      base_url: baseURL.value.trim(),
      auth_style: authStyle.value,
      api_key: apiKey.value.trim(),
      status: Number(status.value),
      priority: priority.read() ?? 0,
      weight: weight.read() ?? 1,
      groups: groups.read().length > 0 ? groups.read() : ['default'],
      models: models.read(),
      model_prefixes: parseList(prefixes.value),
      model_mapping: parseMapping(mapping.value),
      reasoning_effort_mapping: parseEffortRules(effort.value),
      headers: parseHeaders(headers.value),
      timeout_secs: timeout.read() ?? 0,
      proxy_url: proxy.value.trim(),
      price_ratio: priceRatio.read() ?? 1,
      rpm_limit: rpm.read() ?? 0,
      retry_count: retryCount.read() ?? 0,
      retry_backoff_ms: retryBackoff.read() ?? 0,
      test_model: testModel.value.trim(),
      supported_protocols: protocols.read(),
      allow_attachments: attachments.checked,
      lock_user_agent: lockUA.checked,
      locked_user_agents: Object.fromEntries(
        TEST_PROTOCOLS.flatMap((protocol) => {
          const value = uaBoxes[protocol.value]?.value.trim() ?? ''
          return value ? [[protocol.value, value]] : []
        }),
      ),
      note: note.value.trim(),
      keepalive_enabled: keepalive.checked,
      keepalive_at: keepaliveAt.read(),
      keepalive_target: keepaliveTarget.read() ?? 0,
    }

    save.setBusy(true)
    try {
      if (editing) {
        await api.admin.updateChannel(current.id, payload)
        toast.success('已保存')
      } else {
        await api.admin.createChannel(payload)
        toast.success('渠道已创建')
      }
      touched = false
      dialog.close()
      await onSaved()
    } catch (error) {
      toast.error(errorText(error, '保存失败'))
    } finally {
      if (save.isConnected) save.setBusy(false)
    }
  }

  // Seventeen fields is too much typing to lose to a stray Esc or backdrop
  // click, so closing asks once the form has been touched.
  const dialog = openModal({
    title: editing ? `编辑渠道：${channel.name}` : '新建渠道',
    width: 760,
    dismissOnBackdrop: false,
    body: form,
    footer: (close) => [
      button({
        label: '取消',
        onClick: async () => {
          if (!touched) {
            close()
            return
          }
          const discard = await confirmModal({
            title: '放弃未保存的修改？',
            description: '关闭后已填写的内容不会保留。',
            okText: '放弃',
            danger: true,
          })
          if (discard) close()
        },
      }),
      save,
    ],
  })
  dialog.dialog.classList.add('modal--drawer')

  name.focus()
  return dialog
}
