/**
 * Dialogs.
 *
 * A modal traps focus and closes on Escape, because a dialog that does neither
 * is a div that happens to float. Both helpers return a promise so a caller
 * reads as a decision — `if (await confirm(...))` — rather than as a pair of
 * callbacks.
 */

import { el, icon, on } from '../driver/dom.js'
import { button } from './controls.js'
import { ICONS } from './icons.js'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Opens a dialog.
 *
 * `body` is the content; `footer(close)` builds the buttons and receives the
 * closer. Returns { close }.
 */
export function openModal({
  title,
  body,
  footer = null,
  onClose = null,
  width = null,
  // A dialog showing something that cannot be produced again — generated
  // codes, a revealed key — must not be dismissable by a stray click beside
  // it. Escape still works, because that is deliberate.
  dismissOnBackdrop = true,
} = {}) {
  // Restored on close: sending focus back where it came from is what keeps
  // keyboard use from restarting at the top of the page after every dialog.
  const opener = document.activeElement

  const dialog = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': typeof title === 'string' ? title : undefined,
    style: width ? { maxWidth: `${width}px` } : null,
  })

  const scrim = el('div', { class: 'modal-scrim' }, dialog)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    offKeydown()
    scrim.remove()
    opener?.focus?.()
    onClose?.()
  }

  dialog.append(
    el('div', { class: 'modal__head' }, [
      el('div', { class: 'modal__title' }, title),
      el(
        'button',
        { type: 'button', class: 'btn btn--icon', 'aria-label': '关闭', onclick: close },
        icon(ICONS.close, { size: 16 }),
      ),
    ]),
    el('div', { class: 'modal__body' }, body),
  )

  if (footer) dialog.append(el('div', { class: 'modal__foot' }, footer(close)))

  // A click on the backdrop closes; a click that started inside must not.
  if (dismissOnBackdrop) {
    scrim.addEventListener('mousedown', (event) => {
      if (event.target === scrim) close()
    })
  }

  const offKeydown = on(document, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab') return

    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null)
    if (items.length === 0) return

    const first = items[0]
    const last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  document.body.append(scrim)
  // The first real control, not the close button: a dialog that opens with
  // focus on "×" makes Enter dismiss what the user came to fill in.
  const target = dialog.querySelector('.modal__body ' + FOCUSABLE) ?? dialog
  target.focus?.()

  return { close, dialog }
}

/**
 * Asks before doing something that cannot be taken back.
 *
 * Resolves true only if the confirming button was pressed; Escape, the
 * backdrop and 取消 all resolve false.
 */
export function confirmModal({
  title,
  description = null,
  okText = '确定',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const { close } = openModal({
      title,
      width: 440,
      body: description ? el('p', { class: 'text-muted' }, description) : null,
      footer: (closeDialog) => [
        button({
          label: '取消',
          onClick: () => {
            settle(false)
            closeDialog()
          },
        }),
        button({
          label: okText,
          variant: danger ? 'danger' : 'primary',
          onClick: () => {
            settle(true)
            closeDialog()
          },
        }),
      ],
      // Covers Escape and the backdrop, which never reach the buttons above.
      onClose: () => settle(false),
    })

    void close
  })
}
