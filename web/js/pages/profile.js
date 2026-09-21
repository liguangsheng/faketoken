/**
 * Personal settings: account facts, nickname and email, password, and topping
 * the balance up with a redemption code.
 */

import { el, replace } from '../driver/dom.js'
import { api } from '../core/api.js'
import * as sessionStore from '../core/session.js'
import { formatMoney, formatNumber, formatTime } from '../core/format.js'
import { button, card, field, input, pageHeader } from '../ui/controls.js'
import { errorText, toast } from '../ui/toast.js'

export function renderProfile(container) {
  let disposed = false

  const identityCard = el('div', { class: 'card' })
  const redeemSlot = el('div', { class: 'mt-12' })
  const profileSlot = el('div')
  const passwordSlot = el('div', { class: 'mt-12' })

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '个人设置',
        description: '账户信息、昵称邮箱与登录密码，以及使用兑换码为余额充值。',
      }),
      el('div', { class: 'grid grid--split' }, [
        el('div', {}, [identityCard, redeemSlot]),
        el('div', {}, [profileSlot, passwordSlot]),
      ]),
    ]),
  )

  // ---- identity ----------------------------------------------------------

  function paintIdentity() {
    const user = sessionStore.getUser()
    const name = user?.display_name || user?.username || '?'

    const stats = [
      { label: '账户余额', value: formatMoney(user?.quota ?? 0) },
      { label: '累计消费', value: formatMoney(user?.used_quota ?? 0) },
      { label: '调用次数', value: formatNumber(user?.request_count ?? 0) },
    ]

    replace(
      identityCard,
      el('div', { class: 'card__body' }, [
        el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } }, [
          el('span', { class: 'avatar avatar--lg' }, name.slice(0, 1).toUpperCase()),
          el('div', { class: 'stack' }, [
            el('h2', { style: { fontSize: '18px' } }, name),
            el('div', { class: 'row row--wrap', style: { gap: '6px' } }, [
              el('span', { class: 'tag mono' }, user?.username ?? '-'),
              sessionStore.isAdmin()
                ? el('span', { class: 'tag tag--warning' }, '管理员')
                : el('span', { class: 'tag' }, '普通用户'),
              el('span', { class: 'tag tag--brand' }, `分组 ${user?.group ?? '-'}`),
            ]),
            el('div', { class: 'text-small text-muted' }, `注册于 ${formatTime(user?.created_at)}`),
          ]),
        ]),
        el(
          'div',
          { class: 'grid grid--two', style: { marginTop: '20px' } },
          stats.map((item) =>
            el('div', { class: 'sunken-box' }, [
              el('div', { class: 'stat-card__label' }, item.label),
              el(
                'div',
                { class: 'truncate', style: { fontSize: '17px', fontWeight: '650', marginTop: '4px' } },
                item.value,
              ),
            ]),
          ),
        ),
      ]),
    )
  }

  // ---- redemption --------------------------------------------------------

  const redeemInput = input({
    placeholder: '输入兑换码',
    ariaLabel: '兑换码',
    onEnter: () => redeemButton.click(),
  })
  redeemInput.classList.add('mono')

  const redeemButton = button({
    label: '兑换',
    variant: 'primary',
    onClick: async () => {
      const code = redeemInput.value.trim()
      // The server credits on every call, so an empty submit is refused here
      // rather than spending a round trip to be told so.
      if (!code) {
        toast.warning('请输入兑换码')
        return
      }
      try {
        const result = await api.redeem(code)
        toast.success(`兑换成功，到账 ${formatMoney(result.quota)}`)
        redeemInput.value = ''
        // Refresh so the balance here and in the header both move.
        await sessionStore.refresh()
      } catch (error) {
        toast.error(errorText(error, '兑换失败'))
      }
    },
  })

  replace(
    redeemSlot,
    card({
      title: '兑换码充值',
      body: [
        el('div', { class: 'input-group' }, [redeemInput, redeemButton]),
        el(
          'div',
          { class: 'field__hint' },
          '兑换成功后余额立即到账，每个兑换码只能使用一次。',
        ),
      ],
    }),
  )

  // ---- profile -----------------------------------------------------------

  const displayName = input({ id: 'profile-name', maxlength: 32 })
  const email = input({ id: 'profile-email', type: 'email', placeholder: 'you@example.com' })
  const displayField = field({
    label: '昵称',
    control: displayName,
    htmlFor: 'profile-name',
    hint: '展示在右上角与调用日志中。',
  })
  const emailField = field({ label: '邮箱', control: email, htmlFor: 'profile-email' })

  const saveProfile = button({
    label: '保存资料',
    variant: 'primary',
    type: 'submit',
  })

  const profileForm = el(
    'form',
    {
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault()
        emailField.setError(null)

        const value = email.value.trim()
        // An address is optional, but a malformed one is refused rather than
        // stored.
        if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          emailField.setError('邮箱格式不正确')
          return
        }

        saveProfile.setBusy(true)
        try {
          await api.updateMe(displayName.value.trim(), value)
          await sessionStore.refresh()
          toast.success('资料已更新')
        } catch (error) {
          toast.error(errorText(error, '保存失败'))
        } finally {
          if (saveProfile.isConnected) saveProfile.setBusy(false)
        }
      },
    },
    [el('div', { class: 'grid grid--two' }, [displayField, emailField]), saveProfile],
  )

  replace(profileSlot, card({ title: '修改资料', body: profileForm }))

  // ---- password ----------------------------------------------------------

  const oldPassword = input({ id: 'pw-old', type: 'password', autocomplete: 'current-password' })
  const newPassword = input({ id: 'pw-new', type: 'password', autocomplete: 'new-password' })
  const confirmPassword = input({ id: 'pw-confirm', type: 'password', autocomplete: 'new-password' })

  const oldField = field({ label: '当前密码', control: oldPassword, htmlFor: 'pw-old' })
  const newField = field({ label: '新密码', control: newPassword, htmlFor: 'pw-new' })
  const confirmField = field({ label: '确认新密码', control: confirmPassword, htmlFor: 'pw-confirm' })

  const savePassword = button({ label: '修改密码', variant: 'primary', type: 'submit' })

  const passwordForm = el(
    'form',
    {
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault()
        oldField.setError(null)
        newField.setError(null)
        confirmField.setError(null)

        let ok = true
        if (!oldPassword.value) {
          oldField.setError('请输入当前密码')
          ok = false
        }
        if (newPassword.value.length < 8) {
          newField.setError('密码至少 8 位')
          ok = false
        }
        if (confirmPassword.value !== newPassword.value) {
          confirmField.setError('两次输入的密码不一致')
          ok = false
        }
        if (!ok) return

        savePassword.setBusy(true)
        try {
          await api.changePassword(oldPassword.value, newPassword.value)
          toast.success('密码已修改')
          oldPassword.value = ''
          newPassword.value = ''
          confirmPassword.value = ''
        } catch (error) {
          toast.error(errorText(error, '修改失败'))
        } finally {
          if (savePassword.isConnected) savePassword.setBusy(false)
        }
      },
    },
    [oldField, el('div', { class: 'grid grid--two' }, [newField, confirmField]), savePassword],
  )

  replace(passwordSlot, card({ title: '修改密码', body: passwordForm }))

  // ---- wiring ------------------------------------------------------------

  const unsubscribe = sessionStore.subscribe(() => {
    if (disposed) return
    paintIdentity()

    // Seeded from the profile, but never while being edited: the shell
    // re-reads the account every minute and would otherwise wipe a half-typed
    // nickname out from under the cursor.
    const user = sessionStore.getUser()
    if (document.activeElement !== displayName) displayName.value = user?.display_name ?? ''
    if (document.activeElement !== email) email.value = user?.email ?? ''
  })

  return () => {
    disposed = true
    unsubscribe()
  }
}
