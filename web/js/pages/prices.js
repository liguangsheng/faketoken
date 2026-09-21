/**
 * Model prices.
 *
 * Every request is billed on what this table says, so the two dangerous paths
 * are guarded: a catalogue import shows its diff before writing, and changing
 * the unpriced policy says out loud what each option costs the operator.
 */

import { el, icon, replace } from '../driver/dom.js'
import { api } from '../core/api.js'
import { defaultPageSize } from '../core/settings.js'
import { formatPrice, formatRelative, formatTime } from '../core/format.js'
import {
  banner,
  button,
  card,
  field,
  input,
  numberInput,
  pageHeader,
  searchInput,
  select,
  tag,
} from '../ui/controls.js'
import { dropdown, menuItem } from '../ui/dropdown.js'
import { emptyState, skeleton } from '../ui/feedback.js'
import { confirmModal, openModal } from '../ui/modal.js'
import { pagination } from '../ui/pagination.js'
import { table } from '../ui/table.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

const POLICY_LABEL = {
  reject: '拒绝请求',
  fallback: '按兜底价计费',
  free: '免费放行',
}

const EMPTY_PRICE = {
  model: '',
  input_price: 0,
  output_price: 0,
  cached_price: 0,
  per_request_price: 0,
}

/** How many unpriced models to list before collapsing the rest into a count. */
const MAX_MISSING_TAGS = 24

const money = (value) => (value ? formatPrice(value) : null)

export function renderPrices(container) {
  let rows = []
  let catalog = null
  let billing = null
  let unpriced = null
  let keyword = ''
  let page = 1
  let pageSize = defaultPageSize()
  let sortKey = 'model'
  let sortDesc = false
  let showAllMissing = false
  let loading = true
  let disposed = false
  let importMenu = null

  const noticeSlot = el('div')
  const missingSlot = el('div')
  const listSlot = el('div')
  const pagerSlot = el('div')
  const headerSlot = el('div')

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const policyButton = button({
    label: '计费策略',
    glyph: ICONS.settings,
    onClick: () => openPolicy(),
  })
  const createButton = button({
    label: '新增价格',
    variant: 'primary',
    glyph: ICONS.plus,
    onClick: () => openEditor(null),
  })
  const importButton = button({
    label: '拉取最新价格',
    glyph: ICONS.download,
    onClick: () => runImport(false),
  })
  const search = searchInput({
    placeholder: '搜索模型',
    onSearch: (value) => {
      keyword = value
      // A stale page number under a client-side filter makes the result look
      // empty when it is not.
      page = 1
      paint()
    },
  })

  container.append(
    el('div', { class: 'page-enter' }, [
      headerSlot,
      noticeSlot,
      missingSlot,
      listSlot,
      pagerSlot,
    ]),
  )

  const policy = () => billing?.unpriced_policy ?? 'reject'
  // An empty URL means MODELS_DEV_URL is unset and the server refuses the
  // import; disabling the control beats a 503 nobody can explain.
  const catalogDisabled = () => !catalog?.url

  async function load() {
    loading = true
    refreshButton.setBusy(true)
    paint()

    try {
      const [prices, settings, missing] = await Promise.all([
        api.admin.listPrices(),
        api.admin.billingSettings(),
        api.admin.unpricedModels(),
      ])
      if (disposed) return
      rows = prices.data ?? []
      catalog = prices.catalog ?? null
      billing = settings
      unpriced = missing
    } catch (error) {
      if (disposed) return
      toast.error(errorText(error, '加载失败'))
    } finally {
      if (!disposed) {
        loading = false
        refreshButton.setBusy(false)
        paint()
      }
    }
  }

  // ---- import ------------------------------------------------------------

  /**
   * Pulls the catalogue and shows the diff before writing.
   *
   * The dry run is what makes the write reviewable: a price is what every
   * request is billed on. Confirming sends that exact plan back, and the
   * server refuses it if the catalogue moved in between.
   */
  async function runImport(overwrite) {
    importButton.setBusy(true)
    try {
      const plan = await api.admin.previewPriceImport(overwrite)

      if (plan.added.length === 0 && plan.changed.length === 0) {
        toast.info(
          plan.kept > 0
            ? `没有新增模型，${plan.kept} 个已有价格保留`
            : '价格表已和 models.dev 一致',
        )
        return
      }

      const apply = button({
        label: overwrite ? '确认覆盖' : '确认写入',
        variant: overwrite ? 'danger' : 'primary',
        onClick: async () => {
          try {
            const written = await api.admin.applyPriceImport(plan)
            const extra = written.changed.length ? `，覆盖 ${written.changed.length} 个` : ''
            toast.success(`已写入 ${written.added.length} 个模型${extra}`)
            dialog.close()
            await load()
          } catch (error) {
            // A 409 here means the catalogue changed under the preview; the
            // operator has to look at a fresh diff rather than retry blindly.
            toast.error(errorText(error, '写入失败'))
          }
        },
      })

      const dialog = openModal({
        title: overwrite ? '用 models.dev 覆盖同名模型的价格？' : '从 models.dev 补充价格表？',
        width: 720,
        dismissOnBackdrop: false,
        body: planPreview(plan),
        footer: (close) => [button({ label: '取消', onClick: close }), apply],
      })
    } catch (error) {
      toast.error(errorText(error, '拉取 models.dev 失败'))
    } finally {
      importButton.setBusy(false)
    }
  }

  /** Exactly the rows a write would add or rewrite. */
  function planPreview(plan) {
    const delta = (before, after) => {
      if (before === after) {
        return el('span', { class: 'text-muted' }, money(before) ?? '免费')
      }
      return el('span', {}, [
        el('span', { class: 'price-was' }, money(before) ?? '免费'),
        el('span', {}, money(after) ?? '免费'),
      ])
    }

    const summary = [`models.dev 共 ${plan.total} 个模型：新增 ${plan.added.length} 个`]
    if (plan.changed.length) summary.push(`，覆盖 ${plan.changed.length} 个改价`)
    if (plan.kept) summary.push(`，保留 ${plan.kept} 个已有价格`)

    const body = [el('p', { class: 'text-small' }, `${summary.join('')}。`)]

    if (plan.changed.length > 0) {
      body.push(
        el(
          'div',
          { class: 'plan-diff' },
          table({
            caption: '将被覆盖的价格',
            rowKey: (row) => row.model,
            rows: plan.changed,
            columns: [
              {
                key: 'model',
                title: '模型',
                width: 220,
                render: (row) => el('span', { class: 'mono truncate', title: row.model }, row.model),
              },
              {
                key: 'input',
                title: '输入 / 1M',
                align: 'right',
                render: (row) => delta(row.old.input_price, row.new.input_price),
              },
              {
                key: 'output',
                title: '输出 / 1M',
                align: 'right',
                render: (row) => delta(row.old.output_price, row.new.output_price),
              },
              {
                key: 'cached',
                title: '缓存 / 1M',
                align: 'right',
                render: (row) => delta(row.old.cached_price, row.new.cached_price),
              },
            ],
          }),
        ),
      )
    }

    if (plan.added.length > 0) {
      const shown = plan.added.slice(0, MAX_MISSING_TAGS)
      const chips = shown.map((row) => tag(row.model))
      for (const chip of chips) chip.classList.add('mono')
      if (plan.added.length > MAX_MISSING_TAGS) {
        chips.push(tag(`…还有 ${plan.added.length - MAX_MISSING_TAGS} 个`))
      }
      body.push(el('div', { class: 'tag-list', style: { marginTop: '10px' } }, chips))
    }

    return body
  }

  // ---- price editor ------------------------------------------------------

  /**
   * `asNew` opens the form in create mode while keeping the model name that
   * was passed in — editable, so a missing model can be shortened to a prefix
   * before saving. Editing an existing row still locks the name.
   */
  function openEditor(price, asNew = false) {
    const editing = Boolean(price) && !asNew
    const seed = price ?? EMPTY_PRICE

    const model = input({ id: 'price-model', value: seed.model, placeholder: 'gpt-4o' })
    model.classList.add('mono')
    model.disabled = editing

    const inputPrice = numberInput({ id: 'price-input', value: seed.input_price, min: 0, step: 0.01 })
    const outputPrice = numberInput({
      id: 'price-output',
      value: seed.output_price,
      min: 0,
      step: 0.01,
    })
    const cachedPrice = numberInput({
      id: 'price-cached',
      value: seed.cached_price,
      min: 0,
      step: 0.01,
    })
    const perRequest = numberInput({
      id: 'price-per-request',
      value: seed.per_request_price,
      min: 0,
      step: 0.001,
    })

    const modelField = field({
      label: '模型名',
      control: model,
      htmlFor: 'price-model',
      hint: editing
        ? '模型名不可修改；要改名请用列表里的「复制为新条目」，再删除旧的。'
        : '支持前缀匹配：填 gpt-4o 即可覆盖所有 gpt-4o-* 快照。',
    })

    const save = button({
      label: editing ? '保存' : '创建',
      variant: 'primary',
      onClick: async () => {
        modelField.setError(null)
        if (!model.value.trim()) {
          modelField.setError('请输入模型名')
          return
        }

        try {
          await api.admin.upsertPrice({
            model: model.value.trim(),
            input_price: inputPrice.read() ?? 0,
            output_price: outputPrice.read() ?? 0,
            cached_price: cachedPrice.read() ?? 0,
            per_request_price: perRequest.read() ?? 0,
          })
          toast.success('已保存')
          dialog.close()
          await load()
        } catch (error) {
          toast.error(errorText(error, '保存失败'))
        }
      },
    })

    const dialog = openModal({
      title: editing ? `编辑价格：${price.model}` : '新增价格',
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
          modelField,
          field({ label: '输入价格（美元 / 1M Token）', control: inputPrice, htmlFor: 'price-input' }),
          field({
            label: '输出价格（美元 / 1M Token）',
            control: outputPrice,
            htmlFor: 'price-output',
          }),
          field({
            label: '缓存输入价格（美元 / 1M Token）',
            control: cachedPrice,
            htmlFor: 'price-cached',
            hint: '填 0 表示与输入价格相同。',
          }),
          field({
            label: '按次计费（美元 / 次）',
            control: perRequest,
            htmlFor: 'price-per-request',
            hint: '与 token 计费叠加，填 0 表示不启用。',
          }),
          el('button', { type: 'submit', hidden: true }),
        ],
      ),
      footer: (close) => [button({ label: '取消', onClick: close }), save],
    })
  }

  // ---- billing policy ----------------------------------------------------

  function openPolicy() {
    const current = billing ?? {
      unpriced_policy: 'reject',
      fallback: { input_price: 0, output_price: 0, cached_price: 0, per_request_price: 0 },
    }

    const choice = select({
      id: 'policy-choice',
      value: current.unpriced_policy,
      options: [
        { value: 'reject', label: '拒绝请求（推荐）' },
        { value: 'fallback', label: '按兜底价计费' },
        { value: 'free', label: '免费放行，不扣费' },
      ],
      onChange: () => paintPolicyBody(),
    })

    const fallbackInput = numberInput({ id: 'fb-input', value: current.fallback.input_price, min: 0, step: 0.01 })
    const fallbackOutput = numberInput({ id: 'fb-output', value: current.fallback.output_price, min: 0, step: 0.01 })
    const fallbackCached = numberInput({ id: 'fb-cached', value: current.fallback.cached_price, min: 0, step: 0.01 })
    const fallbackPerRequest = numberInput({
      id: 'fb-per-request',
      value: current.fallback.per_request_price,
      min: 0,
      step: 0.001,
    })

    const choiceField = field({
      label: '模型未配置价格时',
      control: choice,
      htmlFor: 'policy-choice',
      hint: '默认拒绝：未配价的模型一旦放行，就是在免费送上游额度。',
    })
    const extraSlot = el('div')

    const paintPolicyBody = () => {
      if (choice.value === 'fallback') {
        replace(extraSlot, [
          banner({ title: '兜底价至少要有一项大于 0，否则等同于免费放行。' }),
          field({ label: '兜底输入价格（美元 / 1M Token）', control: fallbackInput, htmlFor: 'fb-input' }),
          field({ label: '兜底输出价格（美元 / 1M Token）', control: fallbackOutput, htmlFor: 'fb-output' }),
          field({
            label: '兜底缓存输入价格（美元 / 1M Token）',
            control: fallbackCached,
            htmlFor: 'fb-cached',
            hint: '填 0 表示与输入价格相同。',
          }),
          field({
            label: '兜底按次计费（美元 / 次）',
            control: fallbackPerRequest,
            htmlFor: 'fb-per-request',
          }),
        ])
        return
      }

      if (choice.value === 'free') {
        replace(
          extraSlot,
          banner({
            type: 'warning',
            title: '未配价的模型将被免费放行',
            description:
              '用量会记录但不扣费，用户余额和请求计数都不会变化。仅在刻意运营免费网关时使用。',
          }),
        )
        return
      }

      replace(extraSlot, null)
    }

    const save = button({
      label: '保存',
      variant: 'primary',
      onClick: async () => {
        const payload = {
          unpriced_policy: choice.value,
          fallback: {
            input_price: fallbackInput.read() ?? 0,
            output_price: fallbackOutput.read() ?? 0,
            cached_price: fallbackCached.read() ?? 0,
            per_request_price: fallbackPerRequest.read() ?? 0,
          },
        }

        // The banner states the rule; the form has to actually hold it, or
        // "fallback" silently becomes "free".
        if (
          payload.unpriced_policy === 'fallback' &&
          !payload.fallback.input_price &&
          !payload.fallback.output_price &&
          !payload.fallback.per_request_price
        ) {
          toast.warning('兜底价至少要有一项大于 0，否则等同于免费放行')
          return
        }

        try {
          billing = await api.admin.updateBillingSettings(payload)
          toast.success('计费策略已更新')
          dialog.close()
          await load()
        } catch (error) {
          toast.error(errorText(error, '保存失败'))
        }
      },
    })

    paintPolicyBody()

    const dialog = openModal({
      title: '计费策略',
      body: [
        choiceField,
        extraSlot,
        el(
          'p',
          { class: 'field__hint' },
          '改完策略后建议回到列表检查「未配置价格」提示，确认没有模型被意外拒绝或免费放行。',
        ),
      ],
      footer: (close) => [button({ label: '取消', onClick: close }), save],
    })
  }

  // ---- rendering ---------------------------------------------------------

  function paintHeader() {
    const description = [
      '单位是「美元 / 100 万 Token」，查找支持最长前缀匹配：配置了 gpt-4o 后，',
      'gpt-4o-2024-11-20 自动沿用该价格。',
    ]
    if (catalog) {
      const synced = catalog.synced_at ? `（最近同步 ${formatTime(catalog.synced_at)}）` : '（尚未同步过）'
      description.push(` 价格表来自 ${catalog.source}${synced}。`)
      if (!catalog.url) description.push('未配置 MODELS_DEV_URL，拉取功能已禁用。')
    }

    importButton.disabled = catalogDisabled()
    importMenu?.destroy()

    // The safe action is the button; the destructive overwrite is one level in.
    const more = el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': '更多导入方式',
      'aria-haspopup': 'menu',
      disabled: catalogDisabled(),
    })
    replace(more, icon(ICONS.down, { size: 12 }))

    importMenu = dropdown(more, () => [
      menuItem({
        label: '覆盖同名模型的价格',
        danger: true,
        onSelect: () => runImport(true),
      }),
    ])

    replace(
      headerSlot,
      pageHeader({
        title: '模型价格',
        description: description.join(''),
        extra: [
          search,
          refreshButton,
          policyButton,
          el('div', { class: 'row', style: { gap: '0' } }, [importButton, importMenu.node]),
          createButton,
        ],
      }),
    )
  }

  function paintNotices() {
    if (!billing) {
      replace(noticeSlot, null)
      replace(missingSlot, null)
      return
    }

    const current = policy()
    const descriptions = {
      reject: '未配置价格的模型会被直接拒绝（HTTP 403），不会消耗上游额度。',
      fallback: `未配置价格的模型按兜底价计费：输入 $${billing.fallback.input_price} / 输出 $${billing.fallback.output_price}（每 100 万 Token）。`,
      free: '未配置价格的模型会被免费放行且不扣费，用量仍会记录。这是收入漏洞，仅在刻意运营免费网关时使用。',
    }

    const notice = banner({
      type: current === 'free' ? 'warning' : 'info',
      title: `未配价模型的处理方式：${POLICY_LABEL[current]}`,
      description: descriptions[current],
    })
    notice.append(
      el(
        'div',
        { style: { marginInlineStart: 'auto', alignSelf: 'center' } },
        button({ label: '修改', onClick: () => openPolicy() }),
      ),
    )
    replace(noticeSlot, notice)

    // ---- unpriced report
    const missing = unpriced?.data ?? []
    const missingCount = unpriced?.total ?? 0
    if (missingCount === 0) {
      replace(missingSlot, null)
      return
    }

    const explain = {
      reject: '这些模型当前会被拒绝，用户无法调用。点标签可以直接补价格，或一键从 models.dev 拉取。',
      free: '这些模型正在被免费调用，成本由你承担。请立即补齐价格。',
      fallback: '这些模型正在按兜底价计费，价格可能与真实成本有偏差。',
    }

    const shown = showAllMissing ? missing : missing.slice(0, MAX_MISSING_TAGS)
    const chips = shown.map((name) => {
      const chip = tag(name, 'danger')
      chip.classList.add('mono', 'tag--clickable')
      chip.setAttribute('role', 'button')
      chip.setAttribute('tabindex', '0')
      chip.setAttribute('aria-label', `为 ${name} 配置价格`)
      chip.title = '点击为该模型配置价格'
      const open = () => openEditor({ ...EMPTY_PRICE, model: name }, true)
      chip.addEventListener('click', open)
      chip.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
      return chip
    })

    if (missing.length > MAX_MISSING_TAGS) {
      const toggle = tag(showAllMissing ? '收起' : `展开全部 ${missing.length} 个`)
      toggle.classList.add('tag--clickable')
      toggle.setAttribute('role', 'button')
      toggle.setAttribute('tabindex', '0')
      toggle.addEventListener('click', () => {
        showAllMissing = !showAllMissing
        paintNotices()
      })
      chips.push(toggle)
    }

    const report = banner({
      type: 'warning',
      title: `有 ${missingCount} 个模型正在被渠道提供，但没有配置价格`,
      description: explain[current],
    })
    report.lastElementChild.append(
      el('div', { class: 'tag-list', style: { margin: '10px 0' } }, chips),
      button({
        label: '拉取价格表补齐',
        variant: 'primary',
        glyph: ICONS.download,
        disabled: catalogDisabled(),
        onClick: () => runImport(false),
      }),
    )
    replace(missingSlot, report)
  }

  function sorted(list) {
    const compare = {
      model: (a, b) => a.model.localeCompare(b.model),
      input_price: (a, b) => a.input_price - b.input_price,
      output_price: (a, b) => a.output_price - b.output_price,
      updated_at: (a, b) =>
        new Date(a.updated_at ?? 0).getTime() - new Date(b.updated_at ?? 0).getTime(),
    }
    const fn = compare[sortKey] ?? compare.model
    // Inverting the comparator rather than reversing afterwards: one pass, and
    // equal rows keep their relative order instead of being flipped.
    return [...list].sort(sortDesc ? (a, b) => fn(b, a) : fn)
  }

  function paintTable() {
    if (loading && rows.length === 0) {
      replace(listSlot, card({ body: skeleton(6) }))
      replace(pagerSlot, null)
      return
    }

    const needle = keyword.trim().toLowerCase()
    const filtered = needle
      ? rows.filter((row) => row.model.toLowerCase().includes(needle))
      : rows
    const ordered = sorted(filtered)
    const start = (page - 1) * pageSize
    const shown = ordered.slice(start, start + pageSize)

    const priceCell = (value) =>
      money(value) ?? el('span', { class: 'text-muted' }, '免费')

    replace(
      listSlot,
      table({
        caption: '模型价格列表',
        rowKey: (row) => row.model,
        rows: shown,
        sort: {
          key: sortKey,
          desc: sortDesc,
          onSort: (key) => {
            if (sortKey === key) sortDesc = !sortDesc
            else {
              sortKey = key
              sortDesc = false
            }
            paint()
          },
        },
        empty: emptyState({
          title: keyword ? '没有匹配的模型' : '还没有配置任何价格',
          description: keyword
            ? '换个关键词试试。'
            : '可以从 models.dev 拉取价格表，再按自己的成本微调。',
          action: keyword
            ? button({
                label: '清除搜索',
                onClick: () => {
                  search.clear()
                  keyword = ''
                  page = 1
                  paint()
                },
              })
            : button({
                label: '拉取价格表',
                variant: 'primary',
                glyph: ICONS.download,
                disabled: catalogDisabled(),
                onClick: () => runImport(false),
              }),
        }),
        columns: [
          {
            key: 'model',
            title: '模型',
            width: 330,
            sortable: true,
            render: (row) => el('span', { class: 'mono truncate', title: row.model }, row.model),
          },
          {
            key: 'input_price',
            title: '输入 / 1M',
            width: 130,
            align: 'right',
            sortable: true,
            render: (row) => priceCell(row.input_price),
          },
          {
            key: 'output_price',
            title: '输出 / 1M',
            width: 130,
            align: 'right',
            sortable: true,
            render: (row) => priceCell(row.output_price),
          },
          {
            key: 'cached_price',
            title: '缓存输入 / 1M',
            width: 150,
            at: 'lg',
            align: 'right',
            render: (row) => cachedCell(row),
          },
          {
            key: 'per_request_price',
            title: '每次请求',
            width: 120,
            at: 'lg',
            align: 'right',
            render: (row) => money(row.per_request_price) ?? el('span', { class: 'text-muted' }, '-'),
          },
          {
            key: 'updated_at',
            title: '更新时间',
            width: 130,
            at: 'lg',
            sortable: true,
            render: (row) =>
              el('span', { title: formatTime(row.updated_at) }, formatRelative(row.updated_at)),
          },
          { key: 'actions', title: '操作', width: 150, render: rowActions },
        ],
      }),
    )

    replace(
      pagerSlot,
      pagination({
        page,
        pageSize,
        total: ordered.length,
        unit: '个模型',
        onChange: (nextPage, nextSize) => {
          page = nextPage
          pageSize = nextSize
          paintTable()
        },
      }),
    )
  }

  /** Cache price falls back to the input price when it is left at zero. */
  function cachedCell(row) {
    const explicit = money(row.cached_price)
    if (explicit) return explicit
    if (row.input_price) {
      return el('span', { class: 'text-muted' }, `${money(row.input_price)}（同输入）`)
    }
    return el('span', { class: 'text-muted' }, '免费')
  }

  function rowActions(row) {
    const consequence = {
      reject: '删除后该模型会被拒绝调用。',
      free: '删除后该模型将被免费调用且不扣费。',
      fallback: '删除后该模型将按兜底价计费。',
    }

    return el('div', { class: 'table__actions' }, [
      button({ label: '编辑', variant: 'link', onClick: () => openEditor(row) }),
      button({
        label: '复制',
        variant: 'link',
        title: '以这份价格为模板新增',
        // Model names are the primary key, so a copy starts with an empty one.
        onClick: () => openEditor({ ...row, model: '' }, true),
      }),
      button({
        label: '删除',
        variant: 'link danger',
        onClick: async () => {
          const confirmed = await confirmModal({
            title: '删除这个价格？',
            description: consequence[policy()],
            okText: '删除',
            danger: true,
          })
          if (!confirmed) return

          try {
            await api.admin.deletePrice(row.model)
            toast.success('已删除')
            await load()
          } catch (error) {
            toast.error(errorText(error, '删除失败'))
          }
        },
      }),
    ])
  }

  function paint() {
    paintHeader()
    paintNotices()
    paintTable()
  }

  paint()
  void load()

  return () => {
    disposed = true
    search.stop()
    importMenu?.destroy()
  }
}
