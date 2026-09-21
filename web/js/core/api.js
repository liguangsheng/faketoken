/**
 * The API surface the pages call.
 *
 * One named method per endpoint, so a page never assembles a URL and the set
 * of endpoints this console actually uses is readable in one place.
 */

import { request, qs } from '../driver/http.js'

export { ApiError, session, setUnauthorizedHandler } from '../driver/http.js'

export const api = {
  // ---- public
  /** Deliberately carries nothing but what the login form needs. */
  status: () => request('GET', '/api/status'),
  version: () => request('GET', '/api/version'),
  login: (username, password) =>
    request('POST', '/api/auth/login', { username, password }),
  register: (username, password, inviteCode) =>
    request('POST', '/api/auth/register', {
      username,
      password,
      invite_code: inviteCode ?? '',
    }),

  // ---- account
  me: () => request('GET', '/api/me'),
  updateMe: (display_name, email) => request('PUT', '/api/me', { display_name, email }),
  changePassword: (old_password, new_password) =>
    request('PUT', '/api/me/password', { old_password, new_password }),
  /** Exchanges a code for balance. Every failure is a 4xx with a reason. */
  redeem: (code) => request('POST', '/api/redeem', { code }),

  // ---- dashboard
  stats: (params) => request('GET', `/api/stats${qs(params)}`),

  // ---- logs
  logs: (params) => request('GET', `/api/logs${qs(params)}`),
  // No session-log calls here on purpose: those carry conversation bodies
  // and live on the administrator surface only.

  /** The model plaza: reachable models plus how they would be billed. */
  plaza: () => request('GET', '/api/me/plaza'),
  myModels: () => request('GET', '/api/me/models'),
  /** Groups the caller may point a key at, plus their own group. */
  myGroups: () => request('GET', '/api/me/groups'),

  // ---- keys
  listTokens: (params) => request('GET', `/api/tokens${qs(params)}`),
  createToken: (body) => request('POST', '/api/tokens', body),
  updateToken: (id, body) => request('PUT', `/api/tokens/${id}`, body),
  /** Reads one key back in plaintext. Its own call, never part of the list. */
  revealToken: (id) => request('GET', `/api/tokens/${id}/key`),
  deleteToken: (id) => request('DELETE', `/api/tokens/${id}`),

  // ---- console preferences
  // Readable by everyone signed in, writable only by an administrator: a
  // regular account renders the same tables and needs the same default.
  settings: () => request('GET', '/api/settings'),

  admin: {
    stats: (params) => request('GET', `/api/admin/stats${qs(params)}`),

    listUsers: (params) => request('GET', `/api/admin/users${qs(params)}`),
    createUser: (body) => request('POST', '/api/admin/users', body),
    // Replaces every editable field, so a caller has to send the whole row —
    // including a balance read back fresh, or an open form silently refunds
    // whatever the user spent while it sat there.
    updateUser: (id, body) => request('PUT', `/api/admin/users/${id}`, body),
    deleteUser: (id) => request('DELETE', `/api/admin/users/${id}`),
    // Adds to the balance rather than setting it; negative deducts.
    grantQuota: (id, amount_usd) => request('POST', `/api/admin/users/${id}/quota`, { amount_usd }),
    resetPassword: (id, password) => request('PUT', `/api/admin/users/${id}/password`, { password }),

    listGroups: () => request('GET', '/api/admin/groups'),
    upsertGroup: (body) => request('POST', '/api/admin/groups', body),
    deleteGroup: (name) => request('DELETE', `/api/admin/groups/${encodeURIComponent(name)}`),

    logs: (params) => request('GET', `/api/admin/logs${qs(params)}`),
    /** Fetched on demand: the bodies are large and the listing is polled. */
    logDetail: (id) => request('GET', `/api/admin/logs/${id}/detail`),
    purgeLogs: (days) => request('DELETE', `/api/admin/logs${qs({ days })}`),
    /**
     * Aborts a call that is still running. Keyed by its live handle, because
     * the call being stopped is the one that has no id yet. 404 means it
     * finished on its own first.
     */
    cancelInflight: (key) =>
      request('POST', `/api/admin/logs/inflight/${encodeURIComponent(key)}/cancel`),

    listChannels: (params) => request('GET', `/api/admin/channels${qs(params)}`),
    getChannel: (id) => request('GET', `/api/admin/channels/${id}`),
    /** The upstream connection in the clear. Its own call, never in a listing. */
    channelCredential: (id) => request('GET', `/api/admin/channels/${id}/credential`),
    createChannel: (body) => request('POST', '/api/admin/channels', body),
    updateChannel: (id, body) => request('PUT', `/api/admin/channels/${id}`, body),
    deleteChannel: (id) => request('DELETE', `/api/admin/channels/${id}`),
    setChannelStatus: (id, status) =>
      request('PUT', `/api/admin/channels/${id}/status`, { status }),
    /**
     * Retires a channel or brings it back. Archiving disables it server-side
     * in the same transaction; unarchiving only clears the flag, so the
     * channel returns to the listing still disabled.
     */
    setChannelArchived: (id, archived) =>
      request('PUT', `/api/admin/channels/${id}/archive`, { archived }),
    /**
     * Priority and weight only, so the table can edit them in place. The full
     * update is not usable from a listing: it replaces every field, and the
     * api_key the listing carries is masked.
     */
    setChannelRouting: (id, priority, weight) =>
      request('PUT', `/api/admin/channels/${id}/routing`, { priority, weight }),
    clearChannelUserAgent: (id, protocol) =>
      request('POST', `/api/admin/channels/${id}/user-agent/clear${qs({ protocol })}`),
    testChannel: (id, body = {}) => request('POST', `/api/admin/channels/${id}/test`, body),
    promptTemplates: () => request('GET', '/api/admin/prompt-templates'),
    /**
     * Parses a pasted credential, optionally probing the upstream for its
     * model list. `channel_id` lets the server reuse a saved credential
     * instead of re-sending it.
     */
    importChannel: (body) => request('POST', '/api/admin/channels/import', body),
    cloneChannel: (id, name) =>
      request('POST', `/api/admin/channels/${id}/clone`, { name: name ?? '' }),
    channelBalance: (id) => request('POST', `/api/admin/channels/${id}/balance`),
    channelSub2APIBalance: (id) => request('POST', `/api/admin/channels/${id}/balance/sub2api`),
    batchChannelStatus: (ids, status) =>
      request('POST', '/api/admin/channels/batch/status', { ids, status }),
    batchDeleteChannels: (ids) => request('POST', '/api/admin/channels/batch/delete', { ids }),
    batchTestChannels: (ids) => request('POST', '/api/admin/channels/batch/test', { ids }),
    fetchModels: (id, apply) =>
      request('POST', `/api/admin/channels/${id}/fetch-models${qs({ apply })}`),
    setChannelModels: (id, models) =>
      request('PUT', `/api/admin/channels/${id}/models`, { models }),
    rebuild: () => request('POST', '/api/admin/channels/rebuild'),

    listPrices: () => request('GET', '/api/admin/prices'),
    upsertPrice: (body) => request('POST', '/api/admin/prices', body),
    deletePrice: (model) => request('DELETE', `/api/admin/prices/${encodeURIComponent(model)}`),
    /** Models a channel serves that nothing prices yet. */
    unpricedModels: () => request('GET', '/api/admin/prices/unpriced'),
    /**
     * Pulls the models.dev catalogue and reports what a write would change,
     * without writing. The returned plan goes back to `applyPriceImport` once
     * the operator has confirmed the diff.
     */
    previewPriceImport: (overwrite) =>
      request('POST', `/api/admin/prices/import${qs({ overwrite, dry_run: true })}`),
    /**
     * Applies exactly the plan that was previewed. The server answers 409 if
     * it has since fetched a different catalogue, so what the operator
     * confirmed is what lands.
     */
    applyPriceImport: (plan) => request('POST', '/api/admin/prices/import', plan),

    updateSettings: (body) => request('PUT', '/api/admin/settings', body),

    billingSettings: () => request('GET', '/api/admin/billing/settings'),
    updateBillingSettings: (body) => request('PUT', '/api/admin/billing/settings', body),

    listRedemptions: (params) => request('GET', `/api/admin/redemptions${qs(params)}`),
    createRedemptions: (body) => request('POST', '/api/admin/redemptions', body),
    setRedemptionStatus: (id, status) =>
      request('PUT', `/api/admin/redemptions/${id}/status`, { status }),
    // Bulk by design, single rows included: the server applies the same
    // "spent codes are kept" rule either way, so one id is a selection of one.
    deleteRedemptions: (ids) => request('POST', '/api/admin/redemptions/delete', { ids }),

    listInvites: (params) => request('GET', `/api/admin/invites${qs(params)}`),
    createInvites: (body) => request('POST', '/api/admin/invites', body),
    setInviteStatus: (id, status) => request('PUT', `/api/admin/invites/${id}/status`, { status }),
    deleteInvites: (ids) => request('POST', '/api/admin/invites/delete', { ids }),
  },
}
