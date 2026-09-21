/**
 * Clipboard driver.
 *
 * navigator.clipboard rejects outside a secure context, which is exactly how
 * this gateway is often reached on a LAN over plain HTTP. The hidden-textarea
 * path is the fallback, so a copy button keeps working there.
 *
 * Returns whether the text actually made it to the clipboard — the caller has
 * to know, because the recovery is "select it yourself" and claiming success
 * would leave the operator with nothing pasted and no idea why.
 */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Falls through to the legacy path rather than giving up: a rejected
    // permission and a missing API look the same from here.
  }

  try {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.append(holder)
    holder.select()
    const copied = document.execCommand('copy')
    holder.remove()
    return copied
  } catch {
    return false
  }
}
