/**
 * The login form.
 *
 * Deliberately anonymous: an unauthenticated visitor should not be able to
 * tell what this deployment is, what it proxies or who runs it. No product
 * name, no feature copy, no contact hints — just the credential form.
 */

import { el, icon, replace } from '../driver/dom.js'
import { api } from '../core/api.js'
import * as sessionStore from '../core/session.js'
import { affixInput, button, field, segmented } from '../ui/controls.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

export function renderLogin(container) {
  let mode = 'login'
  let allowRegister = false
  let requireInvite = false

  const username = affixInput({
    glyph: ICONS.user,
    id: 'login-username',
    placeholder: '用户名',
    ariaLabel: '用户名',
    autocomplete: 'username',
  })
  const password = affixInput({
    glyph: ICONS.lock,
    reveal: true,
    id: 'login-password',
    type: 'password',
    placeholder: '密码',
    ariaLabel: '密码',
    autocomplete: 'current-password',
  })
  const invite = affixInput({
    glyph: ICONS.gift,
    id: 'login-invite',
    placeholder: '邀请码',
    ariaLabel: '邀请码',
    autocomplete: 'off',
  })

  const usernameField = field({ label: null, control: username, htmlFor: 'login-username' })
  const passwordField = field({ label: null, control: password, htmlFor: 'login-password' })
  const inviteField = field({ label: null, control: invite, htmlFor: 'login-invite' })
  inviteField.style.display = 'none'

  const submit = button({ label: '登录', variant: 'primary', block: true, size: 'lg', type: 'submit' })

  // Fixed height: the register switch arrives async, and swapping a plain
  // title for the switcher must not shove the form down under the pointer.
  const switchSlot = el('div', { class: 'login-switch-slot' }, el('h1', { class: 'login-title' }, '登录'))

  const setMode = (next) => {
    mode = next
    password.control.setAttribute(
      'autocomplete',
      next === 'login' ? 'current-password' : 'new-password',
    )
    password.control.placeholder = next === 'register' ? '密码（至少 8 位）' : '密码'
    inviteField.style.display = next === 'register' && requireInvite ? '' : 'none'
    replace(submit, el('span', {}, next === 'login' ? '登录' : '注册'))
    // A register-only rule (min length) must not linger on the login tab.
    usernameField.setError(null)
    passwordField.setError(null)
    inviteField.setError(null)
  }

  const validate = () => {
    let ok = true
    usernameField.setError(null)
    passwordField.setError(null)
    inviteField.setError(null)

    if (!username.control.value.trim()) {
      usernameField.setError('请输入用户名')
      ok = false
    }
    if (!password.control.value) {
      passwordField.setError('请输入密码')
      ok = false
    } else if (mode === 'register' && password.control.value.length < 8) {
      passwordField.setError('密码至少 8 位')
      ok = false
    }
    if (mode === 'register' && requireInvite && !invite.control.value.trim()) {
      inviteField.setError('请输入邀请码')
      ok = false
    }
    return ok
  }

  const form = el(
    'form',
    {
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault()
        if (!validate()) return

        submit.setBusy(true)
        try {
          if (mode === 'login') {
            await sessionStore.signIn(username.control.value.trim(), password.control.value)
          } else {
            await sessionStore.signUp(
              username.control.value.trim(),
              password.control.value,
              invite.control.value.trim(),
            )
          }
        } catch (error) {
          toast.error(errorText(error))
        } finally {
          if (submit.isConnected) submit.setBusy(false)
        }
      },
    },
    [usernameField, passwordField, inviteField, submit],
  )

  container.append(
    el('div', { class: 'login-shell' }, [
      el('main', { class: 'login-card' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card__body' }, [
            el('div', { class: 'login-mark', 'aria-hidden': 'true' }, icon(ICONS.lock, { size: 20 })),
            switchSlot,
            form,
          ]),
        ]),
      ]),
    ]),
  )

  username.control.focus()

  // Whether registration is open is the server's call, and it re-checks on
  // submit — this only decides whether the tab is worth showing.
  api
    .status()
    .then((status) => {
      allowRegister = status.allow_register
      requireInvite = status.require_invite_code
      if (!allowRegister) return

      replace(
        switchSlot,
        segmented({
          block: true,
          value: 'login',
          options: [
            { value: 'login', label: '登录' },
            { value: 'register', label: '注册' },
          ],
          onChange: setMode,
        }),
      )
    })
    .catch(() => {
      allowRegister = false
    })
}
