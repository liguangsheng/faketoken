/**
 * Copies text with a fallback for non-secure contexts: navigator.clipboard
 * rejects over plain HTTP, which is exactly how this proxy is often reached
 * on a LAN. The hidden-textarea path is what antd's own copyable uses, so
 * explicit copy buttons keep working wherever the inline icons do.
 *
 * Returns whether the text actually made it to the clipboard.
 */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const holder = document.createElement('textarea')
      holder.value = text
      holder.style.position = 'fixed'
      holder.style.opacity = '0'
      document.body.appendChild(holder)
      holder.select()
      const copied = document.execCommand('copy')
      holder.remove()
      return copied
    } catch {
      return false
    }
  }
}
