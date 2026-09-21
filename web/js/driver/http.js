/**
 * HTTP driver.
 *
 * Owns the bearer token and the shape of an API reply. Nothing above this
 * layer touches `fetch` or localStorage directly, so there is one place where
 * a 401 is recognised and one place that decides what an error message says.
 */

// The key predates this console; keeping it means a deploy does not sign
// everyone out.
const TOKEN_KEY = 'faketoken-token'

export const session = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Raised when the session is gone, so the app can return to the login form. */
let onUnauthorized = null
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn
}

export async function request(method, path, body) {
  const headers = {}
  const token = session.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, '网络请求失败，请检查网络或服务是否在运行')
  }

  if (response.status === 401) {
    session.clear()
    onUnauthorized?.()
  }

  const raw = await response.text()
  // A reverse proxy or a crash can answer with HTML; never let JSON.parse
  // blow up and mask the real status code.
  let payload = null
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload?.message || `请求失败（HTTP ${response.status}）`)
  }
  return payload
}

/** Builds a query string, dropping empty values so they never reach the API. */
export function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}
