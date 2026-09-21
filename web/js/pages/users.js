/**
 * User accounts.
 *
 * Three things happen here that can hurt someone: disabling an account cuts
 * off every key it owns, a balance can be overwritten instead of topped up,
 * and deletion takes the keys with it. Each is guarded differently, and the
 * comments say which is which.
 */

import { el, icon, replace } from '../driver/dom.js'
import { api } from '../core/api.js'
import * as sessionStore from '../core/session.js'
import { defaultPageSize } from '../core/settings.js'
import { STATUS, formatMoney, formatNumber, formatRelative, formatTime, toUSD } from '../core/format.js'
import {
  button,
  card,
  field,
  input,
  numberInput,
  pageHeader,
  searchInput,
  select,
  tag,
  toggle,
} from '../ui/controls.js'
import { dropdown, menuItem } from '../ui/dropdown.js'
import { emptyState, skeleton } from '../ui/feedback.js'
import { confirmModal, openModal } from '../ui/modal.js'
import { pagination } from '../ui/pagination.js'
import { cellStack, table } from '../ui/table.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

const ROLE_ADMIN = 100
const ROLE_USER = 1
const MICRO_USD = 1_000_000

const QUICK_AMOUNTS = [5, 10, 50, 100]

export function renderUsers(container) {
  let rows = []
  let total = 0
  let page = 1
  let pageSize = defaultPageSize()
  let keyword = ''
  let groups = []
  let loading = true
  let disposed = false

  // Overlapping fetches race: a slow keyword query must not land after the
  // fast one that replaced it.
  let requestSeq = 0
  // Every row's action menu registers document listeners; they are torn down
  // on each repaint so a long session does not accumulate them.
  let menus = []

  const listSlot = el('div')
  const pagerSlot = el('div')

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const createButton = button({
    label: '新建用户',
    variant: 'primary',
    glyph: ICONS.plus,
    onClick: () => openEditor(null),
  })
  const search = searchInput({
    placeholder: '搜索用户名 / 邮箱',
    onSearch: (value) => {
      keyword = value
      page = 1
      void load()
    },
  })

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '用户管理',
        description: '分组决定用户可用的渠道和计费倍率；余额为负时请求会被拒绝。',
        extra: [search, refreshButton, createButton],
      }),
      listSlot,
      pagerSlot,
    ]),
  )

  const me = () => sessionStore.getUser()
  const isSelf = (row) => row.id === me()?.id

  async function load() {
    const seq = ++requestSeq
    loading = true
    refreshButton.setBusy(true)
    paint()

    try {
      const result = await api.admin.listUsers({ page, page_size: pageSize, keyword })
      if (seq !== requestSeq || disposed) return
      rows = result.data ?? []
      total = result.total ?? 0

      const pages = Math.max(1, Math.ceil(total / pageSize))
      if (page > pages) {
        page = pages
        void load()
        return
      }
    } catch (error) {
      if (seq !== requestSeq || disposed) return
      toast.error(errorText(error, '加载失败'))
    } finally {
      if (seq === requestSeq && !disposed) {
        loading = false
        refreshButton.setBusy(false)
        paint()
      }
    }
  }

  /**
   * Re-reads one account's balance.
   *
   * The update endpoint replaces every field, and users keep spending while a
   * form sits open — echoing back the balance from page load would silently
   * refund whatever they used. There is no single-user GET, so this goes
   * through the list search.
   */
  async function freshQuota(row) {
    try {
      const result = await api.admin.listUsers({ page: 1, page_size: 100, keyword: row.username })
      return result.data?.find((item) => item.id === row.id)?.quota ?? row.quota
    } catch {
      return row.quota
    }
  }

  /** Sends the whole row back with one field changed. */
  async function patch(row, changes) {
    await api.admin.updateUser(row.id, {
      display_name: row.display_name,
      email: row.email,
      role: row.role,
      status: row.status,
      group: row.group,
      quota_usd: toUSD(await freshQuota(row)),
      ...changes,
    })
  }

  async function setStatus(row, status, control) {
    control?.setBusy(true)
    try {
      await patch(row, { status })
      toast.success(status === STATUS.ENABLED ? '账号已启用' : '账号已禁用')
      if (isSelf(row)) await sessionStore.refresh()
      await load()
    } catch (error) {
      toast.error(errorText(error, '操作失败'))
      control?.setChecked(row.status === STATUS.ENABLED)
    } finally {
      control?.setBusy(false)
    }
  }

  /**
   * Disabling cuts off every key the account owns, immediately, so it asks
   * first. Re-enabling is harmless and stays one click.
   */
  async function toggleStatus(row, enabled, control) {
    if (enabled) {
      await setStatus(row, STATUS.ENABLED, control)
      return
    }

    const confirmed = await confirmModal({
      title: `禁用「${row.username}」？`,
      description: '禁用后该账号及其所有 API 密钥将立即无法调用，可随时重新启用。',
      okText: '禁用',
      danger: true,
    })
    if (!confirmed) {
      control.setChecked(true)
      return
    }
    await setStatus(row, STATUS.DISABLED, control)
  }

  async function removeUser(row) {
    const confirmed = await confirmModal({
      title: `删除用户「${row.username}」？`,
      description: '该用户的 API 密钥会一并删除，历史日志保留。此操作不可撤销。',
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return

    try {
      await api.admin.deleteUser(row.id)
      toast.success('已删除')
      await load()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    }
  }

  // ---- editor ------------------------------------------------------------

  /** `user` null creates; otherwise username and password are not editable. */
  function openEditor(user) {
    const editing = Boolean(user)
    const self = editing && isSelf(user)

    const username = input({ id: 'user-name', autocomplete: 'off' })
    const password = input({ id: 'user-password', type: 'password', autocomplete: 'new-password' })
    const displayName = input({ id: 'user-display', value: user?.display_name ?? '' })
    const email = input({ id: 'user-email', type: 'email', value: user?.email ?? '' })

    const role = select({
      id: 'user-role',
      value: user?.role ?? ROLE_USER,
      options: [
        { value: ROLE_USER, label: '普通用户' },
        { value: ROLE_ADMIN, label: '管理员' },
      ],
    })
    const status = select({
      id: 'user-status',
      value: user?.status ?? STATUS.ENABLED,
      options: [
        { value: STATUS.ENABLED, label: '正常' },
        { value: STATUS.DISABLED, label: '禁用' },
      ],
    })
    const group = select({
      id: 'user-group',
      value: user?.group ?? 'default',
      options: groups.map((item) => ({ value: item.name, label: `${item.name}（×${item.rate}）` })),
    })

    // An account cannot lock itself out or demote itself out of the console.
    role.disabled = self
    status.disabled = self

    const quota = numberInput({
      id: 'user-quota',
      value: editing ? toUSD(user.quota) : 1,
      step: 1,
    })
    // Only an amount actually typed overrides the live balance; see freshQuota.
    let quotaTouched = false
    quota.addEventListener('input', () => {
      quotaTouched = true
    })

    const usernameField = field({ label: '用户名', control: username, htmlFor: 'user-name' })
    const passwordField = field({
      label: '初始密码',
      control: password,
      htmlFor: 'user-password',
      hint: '至少 8 位。',
    })
    const emailField = field({ label: '邮箱', control: email, htmlFor: 'user-email' })

    const body = [
      !editing && usernameField,
      !editing && passwordField,
      field({ label: '昵称', control: displayName, htmlFor: 'user-display' }),
      emailField,
      field({
        label: '角色',
        control: role,
        htmlFor: 'user-role',
        hint: self ? '不能取消自己的管理员权限。' : null,
      }),
      field({
        label: '分组',
        control: group,
        htmlFor: 'user-group',
        hint: '决定可用渠道与计费倍率。',
      }),
      field({
        label: '状态',
        control: status,
        htmlFor: 'user-status',
        hint: self ? '不能禁用自己的账号。' : null,
      }),
      field({
        label: '余额（美元）',
        control: quota,
        htmlFor: 'user-quota',
        hint: editing
          ? '这里是直接设置余额。不修改则保留用户当前实时余额；日常增补请用列表里的「充值」。'
          : '账号创建时的初始余额。',
      }),
    ]

    const save = button({
      label: editing ? '保存' : '创建',
      variant: 'primary',
      onClick: async () => {
        usernameField.setError(null)
        passwordField.setError(null)
        emailField.setError(null)

        let ok = true
        if (!editing) {
          if (!username.value.trim()) {
            usernameField.setError('请输入用户名')
            ok = false
          }
          if (password.value.length < 8) {
            passwordField.setError('密码至少 8 位')
            ok = false
          }
        }
        const mail = email.value.trim()
        if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
          emailField.setError('邮箱格式不正确')
          ok = false
        }
        if (!ok) return

        const payload = {
          display_name: displayName.value.trim(),
          email: mail,
          role: Number(role.value),
          status: Number(status.value),
          group: group.value,
          quota_usd: quota.read() ?? 0,
        }

        try {
          if (editing) {
            await api.admin.updateUser(user.id, {
              ...payload,
              quota_usd: quotaTouched ? payload.quota_usd : toUSD(await freshQuota(user)),
            })
            toast.success('已保存')
            if (isSelf(user)) await sessionStore.refresh()
          } else {
            await api.admin.createUser({
              ...payload,
              username: username.value.trim(),
              password: password.value,
            })
            toast.success('用户已创建')
          }
          dialog.close()
          await load()
        } catch (error) {
          toast.error(errorText(error, '保存失败'))
        }
      },
    })

    const dialog = openModal({
      title: editing ? `编辑用户：${user.username}` : '新建用户',
      body: el(
        'form',
        {
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault()
            save.click()
          },
        },
        [...body.filter(Boolean), el('button', { type: 'submit', hidden: true })],
      ),
      footer: (close) => [button({ label: '取消', onClick: close }), save],
    })
  }

  // ---- top-up ------------------------------------------------------------

  /**
   * Adds to the balance rather than setting it, so the dialog shows what the
   * result will be. A negative amount deducts, and the confirming button says
   * so — the two read very differently to someone clicking quickly.
   */
  function openQuota(row) {
    const amount = numberInput({ id: 'quota-amount', value: 10, step: 1 })
    const preview = el('p', { class: 'field__hint' })

    const amountField = field({ label: '充值金额（美元）', control: amount, htmlFor: 'quota-amount' })

    const quick = el(
      'div',
      { class: 'row row--wrap' },
      // No plus sign: clicking fills the box with this amount, it does not
      // stack onto what is already there.
      QUICK_AMOUNTS.map((value) =>
        button({
          label: `$${value}`,
          onClick: () => {
            amount.value = String(value)
            amount.dispatchEvent(new Event('input', { bubbles: true }))
          },
        }),
      ),
    )

    const confirm = button({
      label: '确认充值',
      variant: 'primary',
      onClick: async () => {
        amountField.setError(null)
        const value = amount.read()
        if (value === null || !Number.isFinite(value) || value === 0) {
          amountField.setError('请输入非零金额')
          return
        }

        try {
          await api.admin.grantQuota(row.id, value)
          toast.success(`已为「${row.username}」${value < 0 ? '扣减' : '充值'} $${Math.abs(value)}`)
          if (isSelf(row)) await sessionStore.refresh()
          dialog.close()
          await load()
        } catch (error) {
          toast.error(errorText(error, '充值失败'))
        }
      },
    })

    const paintPreview = () => {
      const value = amount.read()
      const deducting = value !== null && value < 0
      confirm.classList.toggle('btn--danger', deducting)
      replace(confirm, el('span', {}, deducting ? '确认扣减' : '确认充值'))

      if (value === null || !Number.isFinite(value)) {
        preview.textContent = ''
        return
      }
      const after = row.quota + value * MICRO_USD
      replace(preview, [
        '变更后余额：',
        el('strong', { class: after < 0 ? 'text-danger' : null }, formatMoney(after)),
      ])
    }
    amount.addEventListener('input', paintPreview)
    paintPreview()

    const dialog = openModal({
      title: `为「${row.username}」充值`,
      width: 460,
      body: [
        el(
          'p',
          { class: 'text-muted text-small' },
          `当前余额 ${formatMoney(row.quota)}，金额会累加到余额上；填负数表示扣减。`,
        ),
        amountField,
        quick,
        preview,
      ],
      footer: (close) => [button({ label: '取消', onClick: close }), confirm],
    })
  }

  // ---- password ----------------------------------------------------------

  function openPassword(row) {
    const next = input({ id: 'reset-password', type: 'password', autocomplete: 'new-password' })
    const again = input({ id: 'reset-confirm', type: 'password', autocomplete: 'new-password' })
    const nextField = field({ label: '新密码', control: next, htmlFor: 'reset-password' })
    const againField = field({ label: '确认密码', control: again, htmlFor: 'reset-confirm' })

    const confirm = button({
      label: '确认重置',
      variant: 'primary',
      onClick: async () => {
        nextField.setError(null)
        againField.setError(null)

        let ok = true
        if (next.value.length < 8) {
          nextField.setError('密码至少 8 位')
          ok = false
        }
        if (again.value !== next.value) {
          againField.setError('两次输入的密码不一致')
          ok = false
        }
        if (!ok) return

        try {
          await api.admin.resetPassword(row.id, next.value)
          toast.success(`已重置「${row.username}」的密码`)
          dialog.close()
        } catch (error) {
          toast.error(errorText(error, '重置失败'))
        }
      },
    })

    const dialog = openModal({
      title: `重置「${row.username}」的密码`,
      width: 460,
      body: el(
        'form',
        {
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault()
            confirm.click()
          },
        },
        [nextField, againField, el('button', { type: 'submit', hidden: true })],
      ),
      footer: (close) => [button({ label: '取消', onClick: close }), confirm],
    })
  }

  // ---- rendering ---------------------------------------------------------

  function userCell(row) {
    const detail = [row.display_name || '未设置昵称', row.email].filter(Boolean).join(' · ')
    return el('div', { class: 'cell-stack' }, [
      el('div', { class: 'row', style: { gap: '6px' } }, [
        el('strong', {}, row.username),
        isSelf(row) && tag('当前登录', 'brand'),
      ]),
      el('span', { class: 'cell-stack__sub' }, detail),
    ])
  }

  function quotaCell(row) {
    const node = cellStack(
      el('strong', { class: row.quota <= 0 ? 'text-danger' : null }, formatMoney(row.quota)),
      `已消费 ${formatMoney(row.used_quota)}`,
    )
    node.classList.add('cell-right')
    return node
  }

  function actionsCell(row) {
    const more = el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': `更多操作 ${row.username}`,
      'aria-haspopup': 'menu',
    })
    replace(more, icon(ICONS.more, { size: 16 }))

    const menu = dropdown(more, () => [
      menuItem({ label: '重置密码', glyph: ICONS.key, onSelect: () => openPassword(row) }),
      el('div', { class: 'dropdown__divider' }),
      menuItem({
        label: '删除用户',
        glyph: ICONS.close,
        danger: true,
        // An admin locking themselves out is not recoverable from here.
        disabled: isSelf(row),
        title: isSelf(row) ? '不能删除自己的账号' : null,
        onSelect: () => removeUser(row),
      }),
    ])
    menus.push(menu.destroy)

    return el('div', { class: 'table__actions' }, [
      button({ label: '编辑', variant: 'link', onClick: () => openEditor(row) }),
      button({ label: '充值', variant: 'link', onClick: () => openQuota(row) }),
      menu.node,
    ])
  }

  function paint() {
    // Menus from the previous render are gone from the DOM; drop their
    // document listeners with them.
    for (const destroy of menus) destroy()
    menus = []

    if (loading && rows.length === 0) {
      replace(listSlot, card({ body: skeleton(6) }))
      replace(pagerSlot, null)
      return
    }

    replace(
      listSlot,
      table({
        caption: '用户列表',
        rowKey: (row) => row.id,
        rows,
        empty: keyword
          ? emptyState({ title: '没有匹配的用户', description: '换个关键词试试。' })
          : emptyState({
              title: '还没有其他用户',
              description: '手动创建账号，或在全局设置里开放注册。',
              action: button({
                label: '新建用户',
                variant: 'primary',
                glyph: ICONS.plus,
                onClick: () => openEditor(null),
              }),
            }),
        columns: [
          { key: 'username', title: '用户', width: 220, render: userCell },
          {
            key: 'role',
            title: '角色',
            width: 100,
            at: 'md',
            render: (row) =>
              row.role >= ROLE_ADMIN ? tag('管理员', 'warning') : tag('普通用户'),
          },
          {
            key: 'group',
            title: '分组',
            width: 110,
            at: 'lg',
            render: (row) => tag(row.group, 'brand'),
          },
          {
            key: 'status',
            title: '状态',
            width: 90,
            render: (row) =>
              toggle({
                checked: row.status === STATUS.ENABLED,
                // Disabled rather than hidden: the column still reads, and the
                // title says why it cannot be flipped.
                disabled: isSelf(row),
                title: isSelf(row) ? '不能禁用自己的账号' : null,
                ariaLabel: `启用或禁用账号 ${row.username}`,
                onChange: (checked, control) => {
                  control.setChecked(checked)
                  void toggleStatus(row, checked, control)
                },
              }),
          },
          {
            key: 'quota',
            title: '余额 / 累计消费',
            width: 160,
            at: 'md',
            align: 'right',
            render: quotaCell,
          },
          {
            key: 'requests',
            title: '调用次数',
            width: 100,
            at: 'lg',
            align: 'right',
            render: (row) => formatNumber(row.request_count),
          },
          {
            key: 'createdAt',
            title: '注册时间',
            width: 130,
            at: 'lg',
            render: (row) =>
              el('span', { title: formatTime(row.created_at) }, formatRelative(row.created_at)),
          },
          { key: 'actions', title: '操作', width: 170, render: actionsCell },
        ],
      }),
    )

    replace(
      pagerSlot,
      pagination({
        page,
        pageSize,
        total,
        unit: '个用户',
        onChange: (nextPage, nextSize) => {
          page = nextPage
          pageSize = nextSize
          void load()
        },
      }),
    )
  }

  // Groups feed the editor's select; a failure there leaves it empty rather
  // than blocking the list, which is the part most visits are here for.
  api.admin
    .listGroups()
    .then((result) => {
      groups = result.data ?? []
    })
    .catch(() => {
      groups = []
    })

  paint()
  void load()

  return () => {
    disposed = true
    search.stop()
    for (const destroy of menus) destroy()
    menus = []
  }
}
