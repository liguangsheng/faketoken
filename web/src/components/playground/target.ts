import { session } from '../../api/client'

// How the playground pages reach a target: this site, another gateway, or an
// upstream, straight from the browser or through this server.

export const PROXY_PATH = '/api/admin/playground/relay'

/** Addresses a browser reaches over plain HTTP rather than TLS. */
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.)/i

/**
 * Turns what was typed into the prefix a request hangs off: `''` for this site,
 * `null` when it cannot be read as an address. A bare `host:port` gets a scheme,
 * and a trailing `/v1` is dropped so a base URL copied from a provider — or from
 * this console's own quick-import field — can be pasted as-is.
 */
export const normalizeHost = (raw: string): string | null => {
  const input = raw.trim()
  if (!input) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `${LOCAL_HOST.test(input) ? 'http' : 'https'}://${input}`
  try {
    const url = new URL(withScheme)
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')}`
  } catch {
    return null
  }
}

export interface CallInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/**
 * One call to the target: straight from the browser, or handed to this server
 * to make on the page's behalf.
 *
 * The direct call is preceded by a CORS preflight, which a gateway that leaves
 * OPTIONS unhandled on its relay routes rejects — the request itself would have
 * succeeded, but the browser never sends it. Going through the server turns it
 * into a same-origin call, where no preflight applies. The reply is streamed
 * back verbatim, so both paths are read the same way.
 */
export const callTarget = (base: string, path: string, viaProxy: boolean, init: CallInit) => {
  const url = `${base}${path}`
  if (!viaProxy) {
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    })
  }
  const token = session.get()
  return fetch(PROXY_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ method: init.method, url, headers: init.headers, body: init.body ?? '' }),
    signal: init.signal,
  })
}
