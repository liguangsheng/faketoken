/**
 * Who is signed in.
 *
 * A small observable store rather than a framework context: the shell and the
 * pages subscribe, and every write goes through one of the methods here so
 * there is a single place that decides what "signed out" means.
 */

import { api, session as token, setUnauthorizedHandler, ApiError } from './api.js'

const listeners = new Set()

const state = {
  user: null,
  /** True until the first profile read settles, so nothing renders too early. */
  loading: true,
}

const emit = () => {
  for (const listener of listeners) listener(state)
}

/** Subscribes and immediately reports the current state. Returns the remover. */
export function subscribe(listener) {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

export const getUser = () => state.user
export const isLoading = () => state.loading
/** Role 100 and above is an administrator; mirrors the server's check. */
export const isAdmin = () => (state.user?.role ?? 0) >= 100

/** Re-reads the profile. Balance and counters drift as requests flow. */
export async function refresh() {
  if (!token.get()) {
    state.user = null
    state.loading = false
    emit()
    return
  }

  try {
    state.user = await api.me()
  } catch (error) {
    // Only a rejected session signs the user out — the balance poll runs every
    // minute and a flaky network must not bounce anyone to the login form.
    if (error instanceof ApiError && error.status === 401) state.user = null
  } finally {
    state.loading = false
    emit()
  }
}

export async function signIn(username, password) {
  const result = await api.login(username, password)
  token.set(result.token)
  state.user = result.user
  state.loading = false
  emit()
}

export async function signUp(username, password, inviteCode) {
  const result = await api.register(username, password, inviteCode)
  token.set(result.token)
  state.user = result.user
  state.loading = false
  emit()
}

export function signOut() {
  token.clear()
  state.user = null
  state.loading = false
  emit()
}

/**
 * Installs the expired-session handler.
 *
 * `onExpired` only fires when a session actually existed: a failed login
 * attempt also answers 401, and announcing "登录已过期" there would be a lie.
 */
export function start({ onExpired } = {}) {
  setUnauthorizedHandler(() => {
    const hadUser = state.user !== null
    state.user = null
    state.loading = false
    emit()
    if (hadUser) onExpired?.()
  })
  return refresh()
}
