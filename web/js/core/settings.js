/**
 * Console-wide preferences, stored server-side and shared by every browser.
 *
 * Read once at sign-in and cached: tables read the default page size as their
 * initial state, and fetching it per page would make them load once at the
 * wrong size and then reload.
 */

import { api } from './api.js'

/**
 * What the console renders before the real settings arrive, and if they never
 * do. These are the server's boot defaults, which is emphatically not the same
 * as what an operator has stored — see `loaded` below.
 */
const FALLBACK = {
  default_page_size: 20,
  require_invite_code: false,
  allow_register: false,
}

let settings = { ...FALLBACK }
/**
 * True only once the stored settings have actually been read.
 *
 * A failed fetch leaves the fallback in place, so anything that would write
 * settings back has to refuse while this is false — otherwise a network blip
 * turns into "every stored value replaced by a default".
 */
let loaded = false

export const get = () => settings
export const isLoaded = () => loaded
export const defaultPageSize = () => settings.default_page_size || FALLBACK.default_page_size

export async function refresh() {
  try {
    settings = await api.settings()
    loaded = true
  } catch {
    // The console still renders on the fallback; `loaded` stays false.
  }
  return settings
}

/**
 * Adopts settings the operator just saved, so every table picks up the new
 * page size without a reload. The server has normalised the document, which
 * is why the saved copy is stored rather than the draft that was sent.
 */
export function apply(next) {
  settings = next
  loaded = true
}

/** Drops the cache at sign-out, so the next session re-reads it. */
export function reset() {
  settings = { ...FALLBACK }
  loaded = false
}
