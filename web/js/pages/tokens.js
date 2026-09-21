/**
 * API keys.
 *
 * A key is the one thing on this console that leaves it: it goes into a
 * client somewhere and is presented on every call. So the page is built
 * around getting it out safely — shown once on creation, fetched on demand
 * for a copy, never carried in the listing.
 */

import { el, icon, replace } from '../driver/dom.js'
import { copyText } from '../driver/clipboard.js'
import { api } from '../core/api.js'
import { defaultPageSize } from '../core/settings.js'
import {
  STATUS,
  formatDayTime,
  formatMoney,
  formatRelative,
  formatTime,
  formatUSD,
  toUSD,
} from '../core/format.js'
import {
  banner,
  button,
  card,
  dateTimeInput,
  field,
  input,
  numberInput,
  pageHeader,
  select,
  tag,
  toggle,
} from '../ui/controls.js'
import { emptyState, skeleton } from '../ui/feedback.js'
import { confirmModal, openModal } from '../ui/modal.js'
import { pagination } from '../ui/pagination.js'
import { cellStack, table } from '../ui/table.js'
import { tabs } from '../ui/tabs.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

/**
 * Below this a key stops being something an attacker has to steal and becomes
 * something they can guess, so it takes an explicit confirmation. Mirrors
 * auth.MinRecommendedKeyLength, which is what actually enforces it.
 */
const MIN_KEY_LENGTH = 16

const COLLAPSE_KEY = 'faketoken-endpoints-collapsed'

const ENDPOINTS = [
  {
    key: 'openai',
    label: 'OpenAI 兼容',
    suffix: '/v1',
    hint: '填入 Base URL，鉴权用 Authorization: Bearer',
    curl: (origin, key) =>
      `curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'`,
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    suffix: '',
    hint: '原生 /v1/messages，鉴权用 x-api-key',
    curl: (origin, key) =>
      `curl ${origin}/v1/messages \\\n  -H "x-api-key: ${key}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"claude-sonnet-4","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`,
  },
  {
    key: 'gemini',
    label: 'Gemini',
    suffix: '',
    hint: '原生 /v1beta，密钥也可放在 ?key= 上',
    curl: (origin, key) =>
      `curl "${origin}/v1beta/models/gemini-2.5-pro:generateContent" \\\n  -H "x-goog-api-key: ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`,
  },
]

const isExpired = (value) => Boolean(value) && new Date(value).getTime() < Date.now()

export function renderTokens(container) {
  let rows = []
  let total = 0
  let page = 1
  let pageSize = defaultPageSize()
  let loading = true
  let loadError = null
  let models = []
  // Offered by the server, which is also the thing that enforces the choice.
  let groups = []
  let ownGroup = 'default'
  let disposed = false
  let requestSeq = 0

  const origin = window.location.origin

  const endpointSlot = el('div')
  const listSlot = el('div')
  const pagerSlot = el('div')

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const createButton = button({
    label: '新建密钥',
    variant: 'primary',
    glyph: ICONS.plus,
    onClick: () => openEditor(null),
  })

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: 'API 密钥',
        description: '把密钥填进任意兼容客户端即可开始调用；列表中可随时复制完整密钥。',
        extra: [refreshButton, createButton],
      }),
      endpointSlot,
      listSlot,
      pagerSlot,
    ]),
  )

  async function load() {
    const seq = ++requestSeq
    loading = true
    refreshButton.setBusy(true)
    paintList()

    try {
      const result = await api.listTokens({ page, page_size: pageSize })
      if (seq !== requestSeq || disposed) return
      rows = result.data ?? []
      total = result.total ?? 0
      loadError = null

      const pages = Math.max(1, Math.ceil(total / pageSize))
      if (page > pages) {
        page = pages
        void load()
        return
      }
    } catch (error) {
      if (seq !== requestSeq || disposed) return
      // Both surfaces on purpose: the empty-state branch is invisible while
      // stale rows are still on screen, and the toast alone evaporates.
      loadError = errorText(error, '加载失败')
      toast.error(loadError)
    } finally {
      if (seq === requestSeq && !disposed) {
        loading = false
        refreshButton.setBusy(false)
        paintList()
      }
    }
  }

  // ---- endpoints ---------------------------------------------------------

  /**
   * The Base URLs and a curl per protocol. Onboarding material: regulars fold
   * it away, and collapsed it still answers the one daily question — the URL
   * — without a screen of examples between the title and the table.
   */
  function paintEndpoints() {
    const collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'

    const toggleButton = button({
      label: collapsed ? '展开示例' : '收起',
      variant: 'text',
      onClick: () => {
        localStorage.setItem(COLLAPSE_KEY, collapsed ? '0' : '1')
        paintEndpoints()
      },
    })

    let body
    if (collapsed) {
      body = el(
        'div',
        { class: 'row row--wrap', style: { gap: '4px 16px' } },
        ENDPOINTS.map((endpoint) =>
          el('span', { class: 'row', style: { gap: '6px' } }, [
            el('span', { class: 'text-muted text-small' }, endpoint.label),
            copyableCode(origin + endpoint.suffix),
          ]),
        ),
      )
    } else {
      body = endpointTabs((endpoint) => [
        el('div', { class: 'row row--wrap' }, [
          el('span', { class: 'text-muted text-small' }, 'Base URL'),
          copyableCode(origin + endpoint.suffix),
          el('span', { class: 'text-muted text-small' }, endpoint.hint),
        ]),
        curlBlock(endpoint.curl(origin, 'sk-你的密钥'), '复制示例'),
      ])
    }

    replace(
      endpointSlot,
      el('div', { style: { marginBottom: '12px' } }, [
        card({ title: '接入地址', extra: toggleButton, body, tight: collapsed }),
      ]),
    )
  }

  /** A tab strip over the three protocols; `render(endpoint)` builds a panel. */
  function endpointTabs(render) {
    const panel = el('div', { class: 'stack', style: { gap: '8px', marginTop: '12px' } })
    const paintPanel = (key) => {
      replace(panel, render(ENDPOINTS.find((endpoint) => endpoint.key === key)))
    }
    const strip = tabs({
      items: ENDPOINTS.map((endpoint) => ({ key: endpoint.key, label: endpoint.label })),
      value: ENDPOINTS[0].key,
      ariaLabel: '接入协议',
      onChange: paintPanel,
    })
    paintPanel(ENDPOINTS[0].key)
    return el('div', {}, [strip, panel])
  }

  // ---- editor ------------------------------------------------------------

  /** `token` null creates; otherwise the secret is left alone unless retyped. */
  function openEditor(token) {
    const editing = Boolean(token)

    const name = input({ id: 'token-name', value: token?.name ?? '', placeholder: '例如：本地开发', maxlength: 64 })
    // Masked by default: a key typed on a shared screen is a leak.
    const key = input({
      id: 'token-key',
      type: 'password',
      placeholder: editing ? '留空表示不修改' : '留空自动生成',
      autocomplete: 'new-password',
      maxlength: 200,
    })

    const status = select({
      id: 'token-status',
      value: token?.status ?? STATUS.ENABLED,
      options: [
        { value: STATUS.ENABLED, label: '启用' },
        { value: STATUS.DISABLED, label: '禁用' },
      ],
    })

    const quota = numberInput({
      id: 'token-quota',
      value: editing ? toUSD(token.quota) : 0,
      min: 0,
      step: 1,
    })
    const quotaField = field({
      label: '剩余额度（美元）',
      control: quota,
      htmlFor: 'token-quota',
      hint: editing
        ? `设置的是剩余可用金额；该密钥已消费 ${formatMoney(token.used_quota)}，不计入此数。0 表示没有可用额度，密钥将无法调用。`
        : '设置的是可用金额，用完即停。0 表示没有可用额度，密钥将无法调用。',
    })

    const unlimited = toggle({
      checked: token?.unlimited_quota ?? true,
      ariaLabel: '不限额度',
      onChange: (checked, control) => {
        control.setChecked(checked)
        quotaField.style.display = checked ? 'none' : ''
      },
    })
    quotaField.style.display = unlimited.checked ? 'none' : ''

    const rpm = numberInput({ id: 'token-rpm', value: token?.rpm_limit ?? 0, min: 0, step: 1 })

    // Empty means "follow my account" — a real choice in the dropdown, so it
    // round-trips instead of being silently pinned on save.
    const group = select({
      id: 'token-group',
      value: token?.group ?? '',
      options: [
        { value: '', label: `跟随账号分组（当前「${ownGroup}」）` },
        ...groups.map((item) => ({
          value: item.name,
          label: `${item.name}${item.rate !== 1 ? ` ×${item.rate}` : ''}${item.name === ownGroup ? '（默认）' : ''}`,
        })),
      ],
    })

    const allowed = modelPicker({ options: models, value: token?.allowed_models ?? [] })

    const expires = dateTimeInput({ id: 'token-expires' })
    if (token?.expires_at) expires.value = toLocalInput(token.expires_at)

    const nameField = field({
      label: '名称',
      control: name,
      htmlFor: 'token-name',
      hint: '只用于你自己辨认，例如「本地开发」「线上服务」。',
    })
    const keyField = field({
      label: '自定义密钥',
      control: key,
      htmlFor: 'token-key',
      hint: editing
        ? '留空表示不修改。填写后旧密钥立即失效，正在使用它的客户端都要改配置。'
        : `留空则自动生成一个随机密钥。建议至少 ${MIN_KEY_LENGTH} 位。`,
    })
    const expiresField = field({
      label: '过期时间',
      control: expires,
      htmlFor: 'token-expires',
      hint: '留空表示永不过期。',
    })

    const save = button({
      label: editing ? '保存' : '创建',
      variant: 'primary',
      onClick: async () => {
        nameField.setError(null)
        keyField.setError(null)
        expiresField.setError(null)

        let ok = true
        if (!name.value.trim()) {
          nameField.setError('请输入名称')
          ok = false
        }

        const secret = key.value.trim()
        if (secret) {
          // It is sent in an HTTP header, where whitespace would be mangled
          // or split the header outright.
          if (/\s/.test(secret)) {
            keyField.setError('密钥不能包含空格或换行')
            ok = false
          } else if (secret.length > 200) {
            keyField.setError('密钥不能超过 200 个字符')
            ok = false
          }
        }

        const expiresAt = expires.readISO() ?? null
        // The min attribute only blocks past days; a past hour today would
        // create a key that is born expired.
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
          expiresField.setError('过期时间需晚于当前时刻')
          ok = false
        }
        if (!ok) return

        // Ask before accepting a guessable key. The server refuses it without
        // the acknowledgement, so this dialog is the explanation, not the
        // control.
        let confirmWeakKey = false
        const length = [...secret].length
        if (secret && length < MIN_KEY_LENGTH) {
          confirmWeakKey = await confirmModal({
            title: `密钥只有 ${length} 位`,
            description: `短密钥容易被猜到，任何猜中的人都能直接消耗这个密钥的额度。建议至少 ${MIN_KEY_LENGTH} 位。确定要继续吗？`,
            okText: '仍然使用',
            danger: true,
          })
          if (!confirmWeakKey) return
        }

        const payload = {
          name: name.value.trim(),
          status: editing ? Number(status.value) : STATUS.ENABLED,
          unlimited_quota: unlimited.checked,
          quota_usd: unlimited.checked ? 0 : (quota.read() ?? 0),
          rpm_limit: rpm.read() ?? 0,
          allowed_models: allowed.read(),
          group: group.value,
          key: secret,
          confirm_weak_key: confirmWeakKey,
          expires_at: expiresAt,
        }

        try {
          if (editing) {
            await api.updateToken(token.id, payload)
            toast.success(secret ? '已保存，密钥已更换' : '已保存')
            dialog.close()
          } else {
            const created = await api.createToken(payload)
            dialog.close()
            showNewKey(created.key)
          }
          await load()
        } catch (error) {
          toast.error(errorText(error, '保存失败'))
        }
      },
    })

    const dialog = openModal({
      title: editing ? `编辑密钥：${token.name}` : '新建密钥',
      body: el(
        'form',
        {
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault()
            save.click()
          },
        },
        [
          nameField,
          keyField,
          editing && field({ label: '状态', control: status, htmlFor: 'token-status' }),
          field({
            label: '不限额度',
            control: unlimited,
            hint: '关闭后该密钥单独拥有一份额度，用完即停，不影响账户其他密钥。',
          }),
          quotaField,
          field({
            label: 'RPM 限制（次 / 分钟）',
            control: rpm,
            htmlFor: 'token-rpm',
            hint: '这个密钥每分钟最多发起的请求数，超出的请求会收到 429；0 表示不限制。',
          }),
          field({
            label: '分组',
            control: group,
            htmlFor: 'token-group',
            hint: '决定这个密钥能路由到哪些渠道，以及计费倍率；只列出管理员开放给你的分组。',
          }),
          field({
            label: '可用模型',
            control: allowed,
            hint: '留空表示允许分组内的全部模型。',
          }),
          expiresField,
          el('button', { type: 'submit', hidden: true }),
        ],
      ),
      footer: (close) => [button({ label: '取消', onClick: close }), save],
    })
  }

  /**
   * The new secret, shown once. Copying is the whole point of this dialog, so
   * it takes the primary spot; the backdrop does not dismiss it, because a
   * stray click would take the only display of the key with it.
   */
  function showNewKey(secret) {
    const copy = async () => {
      if (await copyText(secret)) toast.success('已复制密钥')
      else toast.warning('浏览器拒绝了剪贴板访问，请手动选中复制')
    }

    openModal({
      title: '密钥创建成功',
      width: 640,
      dismissOnBackdrop: false,
      body: [
        banner({
          title: '密钥已加密保存',
          description: '现在复制填入客户端；之后也随时可以在列表中重新复制。',
        }),
        el('div', { class: 'secret-box mono', onclick: copy, title: '点击复制' }, secret),
        endpointTabs((endpoint) => [curlBlock(endpoint.curl(origin, secret), '复制命令')]),
      ],
      footer: (close) => [
        button({ label: '关闭', onClick: close }),
        button({ label: '复制密钥', variant: 'primary', glyph: ICONS.copy, onClick: copy }),
      ],
    })
  }

  // ---- row actions -------------------------------------------------------

  /** Fetched on demand rather than carried in the list, so a key only travels
   *  when someone actually asks for it. */
  async function copyKey(token) {
    try {
      const { key } = await api.revealToken(token.id)
      if (await copyText(key)) toast.success(`已复制「${token.name}」的密钥`)
      else toast.error('复制失败：浏览器不允许访问剪贴板')
    } catch (error) {
      toast.error(errorText(error, '获取密钥失败'))
    }
  }

  /**
   * The update endpoint replaces the whole row, so every field is echoed back
   * — dropping one (group, say) would silently rewrite it to its zero value.
   */
  async function toggleStatus(row, enabled, control) {
    control.setBusy(true)
    try {
      await api.updateToken(row.id, {
        name: row.name,
        status: enabled ? STATUS.ENABLED : STATUS.DISABLED,
        unlimited_quota: row.unlimited_quota,
        quota_usd: toUSD(row.quota),
        rpm_limit: row.rpm_limit,
        allowed_models: row.allowed_models ?? [],
        group: row.group,
        expires_at: row.expires_at,
      })
      toast.success(enabled ? '密钥已启用' : '密钥已禁用')
      await load()
    } catch (error) {
      toast.error(errorText(error, '操作失败'))
      control.setChecked(!enabled)
    } finally {
      control.setBusy(false)
    }
  }

  async function removeToken(row) {
    const confirmed = await confirmModal({
      title: '删除这个密钥？',
      description: '使用该密钥的客户端会立即失效，且无法恢复。',
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return

    try {
      await api.deleteToken(row.id)
      toast.success('已删除')
      // Deleting the page's last row must not strand the view on an empty
      // page while the pager still shows a total.
      if (rows.length === 1 && page > 1) page -= 1
      await load()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    }
  }

  // ---- cells -------------------------------------------------------------

  function nameCell(row) {
    const copy = button({
      variant: 'icon',
      glyph: ICONS.copy,
      ariaLabel: `复制密钥 ${row.name}`,
      title: '复制完整密钥',
      onClick: () => copyKey(row),
    })
    copy.classList.add('code-cell__copy')
    return el('div', { class: 'cell-stack' }, [
      el('strong', { class: 'truncate', title: row.name }, row.name),
      el('div', { class: 'code-cell' }, [
        el('span', { class: 'mono text-muted text-small' }, row.key_prefix),
        copy,
      ]),
    ])
  }

  function quotaCell(row) {
    if (row.unlimited_quota) {
      return el('span', { title: '不单独限额，只受账户余额约束' }, tag('不限额度', 'brand'))
    }
    const totalQuota = row.quota + row.used_quota
    // The bar shows what remains, matching the number beside it: a full bar
    // means plenty left, a red sliver means nearly spent.
    const remaining = totalQuota > 0 ? (row.quota / totalQuota) * 100 : 0
    // Sub-cent balances still bill; "$0.00" would look like a bug.
    const remainingText =
      row.quota > 0 && row.quota < 10_000 ? formatUSD(row.quota) : formatMoney(row.quota)
    return el('div', { class: 'stack', style: { gap: '2px', minWidth: '130px' } }, [
      el('span', { class: 'text-small' }, ['剩余 ', el('strong', {}, remainingText)]),
      el(
        'div',
        { class: `progress${remaining <= 5 ? ' progress--danger' : ''}` },
        el('span', { style: { width: `${Math.max(remaining, 0)}%` } }),
      ),
    ])
  }

  function groupCell(row) {
    const effective = row.group || ownGroup
    const rate = groups.find((item) => item.name === effective)?.rate
    const label = `${effective}${rate !== undefined && rate !== 1 ? ` ×${rate}` : ''}`
    // Brand colour marks a pinned group; a followed one stays neutral.
    const node = tag(label, row.group ? 'brand' : null)
    node.title = row.group ? `该密钥固定使用「${row.group}」分组` : `跟随账号分组（当前为「${ownGroup}」）`
    return node
  }

  function modelsCell(row) {
    const list = row.allowed_models ?? []
    if (list.length === 0) return tag('全部', 'brand')
    const chips = list.slice(0, 2).map((model) => {
      const chip = tag(model)
      chip.classList.add('mono')
      return chip
    })
    if (list.length > 2) {
      const more = tag(`+${list.length - 2}`)
      more.title = list.join('、')
      chips.push(more)
    }
    return el('div', { class: 'tag-list' }, chips)
  }

  function expiresCell(row) {
    if (!row.expires_at) return el('span', { class: 'text-faint' }, '永不过期')
    const node = cellStack(formatDayTime(row.expires_at), formatRelative(row.expires_at))
    node.title = formatTime(row.expires_at)
    if (isExpired(row.expires_at)) node.firstElementChild.classList.add('text-danger')
    return node
  }

  function lastUsedCell(row) {
    if (!row.last_used_at) return el('span', { class: 'text-faint' }, '从未使用')
    const node = cellStack(formatDayTime(row.last_used_at), formatRelative(row.last_used_at))
    node.title = formatTime(row.last_used_at)
    return node
  }

  function paintList() {
    if (loading && rows.length === 0) {
      replace(listSlot, card({ body: skeleton(6) }))
      replace(pagerSlot, null)
      return
    }

    const empty = loadError
      ? emptyState({
          title: '加载失败',
          description: loadError,
          action: button({ label: '重试', variant: 'primary', glyph: ICONS.reload, onClick: () => load() }),
        })
      : emptyState({
          title: '还没有 API 密钥',
          description: '创建一个密钥，就能把上面的地址填进任意客户端了。',
          action: button({
            label: '新建密钥',
            variant: 'primary',
            glyph: ICONS.plus,
            onClick: () => openEditor(null),
          }),
        })

    replace(
      listSlot,
      table({
        caption: 'API 密钥列表',
        rowKey: (row) => row.id,
        rows,
        empty,
        columns: [
          { key: 'name', title: '名称 / 密钥', width: 250, render: nameCell },
          {
            key: 'status',
            title: '状态',
            width: 130,
            render: (row) =>
              el('div', { class: 'row', style: { gap: '6px' } }, [
                toggle({
                  checked: row.status === STATUS.ENABLED,
                  ariaLabel: `启用或禁用密钥 ${row.name}`,
                  onChange: (checked, control) => {
                    control.setChecked(checked)
                    void toggleStatus(row, checked, control)
                  },
                }),
                isExpired(row.expires_at) && tag('已过期', 'danger'),
              ]),
          },
          { key: 'quota', title: '额度', width: 170, at: 'md', render: quotaCell },
          { key: 'group', title: '分组', width: 120, at: 'lg', render: groupCell },
          {
            key: 'used',
            title: '已用',
            width: 110,
            at: 'lg',
            align: 'right',
            render: (row) => formatMoney(row.used_quota),
          },
          {
            key: 'rpm',
            title: 'RPM',
            width: 90,
            at: 'lg',
            align: 'right',
            render: (row) =>
              row.rpm_limit > 0
                ? el('span', { class: 'mono', title: `每分钟最多 ${row.rpm_limit} 次请求，超出返回 429` }, String(row.rpm_limit))
                : el('span', { class: 'text-faint' }, '不限'),
          },
          { key: 'models', title: '可用模型', width: 160, at: 'lg', render: modelsCell },
          { key: 'expires', title: '过期时间', width: 170, at: 'lg', render: expiresCell },
          { key: 'lastUsed', title: '最后使用', width: 140, at: 'lg', render: lastUsedCell },
          {
            key: 'actions',
            title: '操作',
            width: 120,
            render: (row) =>
              el('div', { class: 'table__actions' }, [
                button({ label: '编辑', variant: 'link', onClick: () => openEditor(row) }),
                button({ label: '删除', variant: 'link danger', onClick: () => removeToken(row) }),
              ]),
          },
        ],
      }),
    )

    replace(
      pagerSlot,
      pagination({
        page,
        pageSize,
        total,
        unit: '个密钥',
        onChange: (nextPage, nextSize) => {
          page = nextPage
          pageSize = nextSize
          void load()
        },
      }),
    )
  }

  // Models and groups feed the editor; a failure there leaves the selects
  // empty rather than blocking the list, which is what most visits are for.
  api
    .myModels()
    .then((result) => {
      models = result.data ?? []
    })
    .catch(() => {
      models = []
    })
  api
    .myGroups()
    .then((result) => {
      groups = result.data ?? []
      ownGroup = result.own || 'default'
      paintList()
    })
    .catch(() => {
      groups = []
    })

  paintEndpoints()
  paintList()
  void load()

  return () => {
    disposed = true
  }
}

// ---- pieces ---------------------------------------------------------------

/** Inline code with a copy button beside it. */
function copyableCode(text) {
  return el('span', { class: 'code-cell' }, [
    el('code', { class: 'mono' }, text),
    button({
      variant: 'icon',
      glyph: ICONS.copy,
      ariaLabel: `复制 ${text}`,
      onClick: async () => {
        if (await copyText(text)) toast.success('已复制')
        else toast.warning('浏览器拒绝了剪贴板访问，请手动复制')
      },
    }),
  ])
}

/** A curl example with a floating copy button in its corner. */
function curlBlock(command, label) {
  const copy = button({
    variant: 'icon',
    glyph: ICONS.copy,
    ariaLabel: label,
    title: label,
    onClick: async () => {
      if (await copyText(command)) toast.success('已复制')
      else toast.warning('浏览器拒绝了剪贴板访问，请手动复制')
    },
  })
  copy.classList.add('code-block__copy')
  return el('div', { class: 'code-block-wrap' }, [
    el('pre', { class: 'code-block', style: { paddingInlineEnd: '40px' } }, command),
    copy,
  ])
}

/**
 * A multi-select for model names.
 *
 * Chips for what is chosen, and a text box with a datalist for adding more:
 * the browser supplies the suggestion list, so this stays a plain input.
 * Values outside the list are accepted too — a key may be scoped to a model
 * the plaza does not list yet.
 */
function modelPicker({ options, value }) {
  const chosen = [...value]
  const listId = `models-${Math.random().toString(36).slice(2, 8)}`

  const chips = el('div', { class: 'tag-list' })
  const entry = input({ placeholder: '输入模型名后回车添加', ariaLabel: '添加可用模型' })
  entry.setAttribute('list', listId)
  entry.autocomplete = 'off'

  const datalist = el('datalist', { id: listId }, options.map((model) => el('option', { value: model })))

  const paint = () => {
    replace(
      chips,
      chosen.map((model) => {
        const chip = tag(model)
        chip.classList.add('mono', 'chip--removable')
        chip.append(
          el(
            'button',
            {
              type: 'button',
              class: 'chip__remove',
              'aria-label': `移除 ${model}`,
              onclick: () => {
                chosen.splice(chosen.indexOf(model), 1)
                paint()
              },
            },
            icon(ICONS.close, { size: 10 }),
          ),
        )
        return chip
      }),
    )
    chips.style.display = chosen.length > 0 ? '' : 'none'
  }

  const add = () => {
    const model = entry.value.trim()
    if (!model) return
    if (!chosen.includes(model)) chosen.push(model)
    entry.value = ''
    paint()
  }

  entry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    }
  })
  // Picking from the datalist fires change without a keypress.
  entry.addEventListener('change', add)

  paint()

  const node = el('div', { class: 'stack' }, [chips, entry, datalist])
  node.read = () => [...chosen]
  return node
}

/** An ISO instant as the local wall-clock text datetime-local wants. */
function toLocalInput(iso) {
  const date = new Date(iso)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
