import type {
  User,
  Token,
  TokenKeyInput,
  Channel,
  RequestLog,
  InviteCode,
  ChannelTestResult,
  PromptTemplate,
  BatchTestResult,
  ChannelImportPreview,
  ChannelBalance,
  ModelPrice,
  BillingSettings,
  UnpricedReport,
  PriceCatalog,
  PriceImportPlan,
  PlazaResponse,
  UserGroup,
  Page,
  ConsoleSettings,
  RequestLogDetail,
  Redemption,
  Stats,
  UsageDay,
} from './types'

export type * from './types'

const TOKEN_KEY = 'faketoken-token'

export const session = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Raised when the session is gone so the app can bounce back to the login page. */
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = session.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
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

  const text = await response.text()
  // A reverse proxy or a crash can answer with HTML; never let JSON.parse
  // blow up and mask the real status code.
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const message = (payload as { message?: string } | null)?.message
    throw new ApiError(response.status, message || `请求失败（HTTP ${response.status}）`)
  }
  return payload as T
}

const qs = (params: Record<string, unknown>) => {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

export const api = {
  // auth
  /** Public: deliberately carries nothing but what the login form needs. */
  status: () =>
    request<{ allow_register: boolean; require_invite_code: boolean }>('GET', '/api/status'),
  version: () => request<{ version: string }>('GET', '/api/version'),
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/login', {
      username,
      password,
    }),
  register: (username: string, password: string, inviteCode?: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/register', {
      username,
      password,
      invite_code: inviteCode ?? '',
    }),
  me: () => request<User>('GET', '/api/me'),
  updateMe: (display_name: string, email: string) =>
    request<User>('PUT', '/api/me', { display_name, email }),
  changePassword: (old_password: string, new_password: string) =>
    request<{ message: string }>('PUT', '/api/me/password', {
      old_password,
      new_password,
    }),
  myModels: () => request<{ data: string[] }>('GET', '/api/me/models'),
  /** The model plaza: reachable models plus how they would be billed. */
  plaza: () => request<PlazaResponse>('GET', '/api/me/plaza'),
  /** Groups the caller may point a key at, plus their own group. */
  myGroups: () => request<{ data: UserGroup[]; own: string }>('GET', '/api/me/groups'),

  // settings
  settings: () => request<ConsoleSettings>('GET', '/api/settings'),

  /** Exchanges a code for balance. Every failure is a 4xx with a reason. */
  redeem: (code: string) =>
    request<{ quota: number; balance: number; message: string }>('POST', '/api/redeem', { code }),

  // tokens
  listTokens: (params: Record<string, unknown> = {}) =>
    request<Page<Token>>('GET', `/api/tokens${qs(params)}`),
  createToken: (body: Partial<Token> & TokenKeyInput) =>
    request<{ token: Token; key: string }>('POST', '/api/tokens', body),
  updateToken: (id: number, body: Partial<Token> & TokenKeyInput) =>
    request<Token>('PUT', `/api/tokens/${id}`, body),
  /** Reads one key back in plaintext. Its own call, never part of the list. */
  revealToken: (id: number) => request<{ key: string }>('GET', `/api/tokens/${id}/key`),
  deleteToken: (id: number) => request<unknown>('DELETE', `/api/tokens/${id}`),

  // logs & stats
  logs: (params: Record<string, unknown>) =>
    request<Page<RequestLog>>('GET', `/api/logs${qs(params)}`),
  // No session-log calls here on purpose: those carry conversation bodies and
  // live on the administrator surface only.
  stats: (params: Record<string, unknown>) => request<Stats>('GET', `/api/stats${qs(params)}`),
  /** The last year by day, in the zone given; days without traffic are omitted. */
  heatmap: (tz: string) =>
    request<{ days: UsageDay[] }>('GET', `/api/stats/heatmap${qs({ tz })}`),

  admin: {
    listUsers: (params: Record<string, unknown>) =>
      request<Page<User>>('GET', `/api/admin/users${qs(params)}`),
    createUser: (body: Record<string, unknown>) => request<User>('POST', '/api/admin/users', body),
    updateUser: (id: number, body: Record<string, unknown>) =>
      request<User>('PUT', `/api/admin/users/${id}`, body),
    deleteUser: (id: number) => request<unknown>('DELETE', `/api/admin/users/${id}`),
    grantQuota: (id: number, amount_usd: number) =>
      request<User>('POST', `/api/admin/users/${id}/quota`, { amount_usd }),
    resetPassword: (id: number, password: string) =>
      request<unknown>('PUT', `/api/admin/users/${id}/password`, { password }),

    listChannels: (params: Record<string, unknown>) =>
      request<Page<Channel>>('GET', `/api/admin/channels${qs(params)}`),
    getChannel: (id: number) => request<Channel>('GET', `/api/admin/channels/${id}`),
    /** The upstream connection in the clear. Its own call, never in a listing. */
    channelCredential: (id: number) =>
      request<{ base_url: string; api_key: string }>('GET', `/api/admin/channels/${id}/credential`),
    createChannel: (body: Record<string, unknown>) =>
      request<Channel>('POST', '/api/admin/channels', body),
    updateChannel: (id: number, body: Record<string, unknown>) =>
      request<Channel>('PUT', `/api/admin/channels/${id}`, body),
    deleteChannel: (id: number) => request<unknown>('DELETE', `/api/admin/channels/${id}`),
    setChannelStatus: (id: number, status: number) =>
      request<Channel>('PUT', `/api/admin/channels/${id}/status`, { status }),
    /**
     * Retires a channel or brings it back. Archiving disables it server-side in
     * the same transaction; unarchiving only clears the flag, so the channel
     * returns to the listing still disabled.
     */
    setChannelArchived: (id: number, archived: boolean) =>
      request<Channel>('PUT', `/api/admin/channels/${id}/archive`, { archived }),
    /**
     * Priority and weight only, so the table can edit them in place. The full
     * update is not usable from a listing: it replaces every field, and the
     * api_key the listing carries is masked.
     */
    setChannelRouting: (id: number, priority: number, weight: number) =>
      request<Channel>('PUT', `/api/admin/channels/${id}/routing`, { priority, weight }),
    clearChannelUserAgent: (id: number, protocol: 'responses' | 'chat_completions' | 'messages') =>
      request<Channel>(
        'POST',
        `/api/admin/channels/${id}/user-agent/clear${qs({ protocol })}`,
      ),
    testChannel: (
      id: number,
      body: {
        model?: string
        protocol?: 'responses' | 'chat_completions' | 'messages'
        prompt?: string
        prompt_template?: string
      } = {},
    ) => request<ChannelTestResult>('POST', `/api/admin/channels/${id}/test`, body),
    promptTemplates: () =>
      request<{ data: PromptTemplate[] }>('GET', '/api/admin/prompt-templates'),
    importChannel: (body: {
      text?: string
      base_url?: string
      api_key?: string
      auth_style?: 'auto' | 'bearer' | 'x-api-key' | 'x-goog-api-key'
      /** Lets the server reuse a saved credential instead of re-sending it. */
      channel_id?: number
      skip_models?: boolean
    }) => request<ChannelImportPreview>('POST', '/api/admin/channels/import', body),
    cloneChannel: (id: number, name?: string) =>
      request<Channel>('POST', `/api/admin/channels/${id}/clone`, {
        name: name ?? '',
      }),
    channelBalance: (id: number) =>
      request<ChannelBalance>('POST', `/api/admin/channels/${id}/balance`),
    channelSub2APIBalance: (id: number) =>
      request<ChannelBalance>('POST', `/api/admin/channels/${id}/balance/sub2api`),
    batchChannelStatus: (ids: number[], status: number) =>
      request<{ updated: number }>('POST', '/api/admin/channels/batch/status', {
        ids,
        status,
      }),
    batchDeleteChannels: (ids: number[]) =>
      request<{ deleted: number }>('POST', '/api/admin/channels/batch/delete', {
        ids,
      }),
    batchTestChannels: (ids: number[]) =>
      request<{ data: BatchTestResult[]; total: number; passed: number }>(
        'POST',
        '/api/admin/channels/batch/test',
        { ids },
      ),
    fetchModels: (id: number, apply: boolean) =>
      request<{ models: string[]; count: number; applied: boolean }>(
        'POST',
        `/api/admin/channels/${id}/fetch-models${qs({ apply })}`,
      ),
    channelModels: (id: number) =>
      request<{ data: { model: string; fetched_at: string }[] }>(
        'GET',
        `/api/admin/channels/${id}/models`,
      ),
    setChannelModels: (id: number, models: string[]) =>
      request<Channel>('PUT', `/api/admin/channels/${id}/models`, { models }),
    rebuild: () => request<unknown>('POST', '/api/admin/channels/rebuild'),

    listGroups: () => request<{ data: UserGroup[] }>('GET', '/api/admin/groups'),
    upsertGroup: (body: UserGroup) => request<UserGroup>('POST', '/api/admin/groups', body),
    deleteGroup: (name: string) =>
      request<unknown>('DELETE', `/api/admin/groups/${encodeURIComponent(name)}`),

    listPrices: () =>
      request<{ data: ModelPrice[]; catalog?: PriceCatalog }>('GET', '/api/admin/prices'),
    upsertPrice: (body: ModelPrice) => request<ModelPrice>('POST', '/api/admin/prices', body),
    deletePrice: (model: string) =>
      request<unknown>('DELETE', `/api/admin/prices/${encodeURIComponent(model)}`),
    /**
     * Pulls the models.dev catalogue and reports what a write would change,
     * without writing. The returned plan goes back to `applyPriceImport`
     * once the operator has confirmed the diff.
     */
    previewPriceImport: (overwrite: boolean) =>
      request<PriceImportPlan>(
        'POST',
        `/api/admin/prices/import${qs({ overwrite, dry_run: true })}`,
      ),
    /**
     * Applies exactly the plan that was previewed. The server refuses with
     * 409 when it has since fetched a different catalogue, so what the
     * operator confirmed is what lands.
     */
    applyPriceImport: (plan: PriceImportPlan) =>
      request<PriceImportPlan>('POST', '/api/admin/prices/import', plan),
    /** Models a channel serves that nothing prices yet. */
    unpricedModels: () => request<UnpricedReport>('GET', '/api/admin/prices/unpriced'),

    updateSettings: (body: ConsoleSettings) =>
      request<ConsoleSettings>('PUT', '/api/admin/settings', body),

    listRedemptions: (params: Record<string, unknown>) =>
      request<Page<Redemption>>('GET', `/api/admin/redemptions${qs(params)}`),
    createRedemptions: (body: {
      name?: string
      group?: string
      amount_usd: number
      count: number
      expires_at?: string
    }) => request<{ data: Redemption[]; total: number }>('POST', '/api/admin/redemptions', body),
    setRedemptionStatus: (id: number, status: number) =>
      request<unknown>('PUT', `/api/admin/redemptions/${id}/status`, {
        status,
      }),
    listInvites: (params: Record<string, unknown>) =>
      request<Page<InviteCode>>('GET', `/api/admin/invites${qs(params)}`),
    createInvites: (body: { name?: string; count: number; expires_at?: string }) =>
      request<{ data: InviteCode[]; total: number }>('POST', '/api/admin/invites', body),
    setInviteStatus: (id: number, status: number) =>
      request<unknown>('PUT', `/api/admin/invites/${id}/status`, { status }),
    deleteInvites: (ids: number[]) =>
      request<{ deleted: number }>('POST', '/api/admin/invites/delete', { ids }),

    deleteRedemptions: (ids: number[]) =>
      request<{ deleted: number }>('POST', '/api/admin/redemptions/delete', {
        ids,
      }),

    billingSettings: () => request<BillingSettings>('GET', '/api/admin/billing/settings'),
    updateBillingSettings: (body: BillingSettings) =>
      request<BillingSettings>('PUT', '/api/admin/billing/settings', body),

    logs: (params: Record<string, unknown>) =>
      request<Page<RequestLog>>('GET', `/api/admin/logs${qs(params)}`),
    /** Fetched on demand: the bodies are large and the listing is polled. */
    logDetail: (id: number) => request<RequestLogDetail>('GET', `/api/admin/logs/${id}/detail`),
    purgeLogs: (days: number) =>
      request<{ deleted: number }>('DELETE', `/api/admin/logs${qs({ days })}`),
    /** Aborts a call that is still running. Keyed by its live handle, because
     *  the call being stopped is the one that has no id yet. 404 means it
     *  finished on its own first. */
    cancelInflight: (key: string) =>
      request<{ key: string }>('POST', `/api/admin/logs/inflight/${encodeURIComponent(key)}/cancel`),
    stats: (params: Record<string, unknown>) =>
      request<Stats>('GET', `/api/admin/stats${qs(params)}`),
    /** Every account's traffic summed. */
    heatmap: (tz: string) =>
      request<{ days: UsageDay[] }>('GET', `/api/admin/stats/heatmap${qs({ tz })}`),
  },
}
