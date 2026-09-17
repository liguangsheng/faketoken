export interface User {
  id: number
  username: string
  display_name: string
  email: string
  role: number
  status: number
  group: string
  quota: number
  used_quota: number
  request_count: number
  created_at: string
}

export interface Token {
  id: number
  user_id: number
  name: string
  key_prefix: string
  status: number
  unlimited_quota: boolean
  quota: number
  used_quota: number
  /** Requests-per-minute cap for this key; 0 means unlimited. */
  rpm_limit: number
  allowed_models: string[]
  /** Routes and prices this key; empty follows the owning account's group. */
  group: string
  expires_at: string | null
  last_used_at: string | null
  created_at: string
}

/** Write-only fields for a token's secret; never returned by the API. */
export interface TokenKeyInput {
  quota_usd?: number
  /**
   * Sets the secret by hand. Empty generates one on create and keeps the
   * existing one on update, so an edit never has to round-trip the key.
   */
  key?: string
  /** Acknowledges a key below the recommended length. Re-checked server-side. */
  confirm_weak_key?: boolean
}

export interface Channel {
  id: number
  name: string
  base_url: string
  auth_style: 'auto' | 'bearer' | 'x-api-key' | 'x-goog-api-key'
  api_key?: string
  status: number
  priority: number
  weight: number
  groups: string[]
  models: string[]
  model_prefixes: string[]
  model_mapping: Record<string, string>
  headers: Record<string, string>
  timeout_secs: number
  proxy_url: string
  price_ratio: number
  rpm_limit: number
  test_model: string
  supported_protocols: string[]
  convert_messages_to_chat: boolean
  convert_responses_to_chat: boolean
  /** Renames the thinking level on the way upstream, e.g. `{max: 'xhigh'}`. */
  /**
   * Thinking-level renames, keyed by which models they apply to: "*" is every
   * model the channel serves, "gpt-5*" a prefix, a bare name only itself.
   */
  reasoning_effort_mapping: Record<string, Record<string, string>>
  allow_attachments: boolean
  lock_user_agent: boolean
  locked_user_agents: Record<string, string>
  /**
   * Retired without being deleted: folded into the console's collapsed section
   * instead of the main listing. Archiving always disables, so an archived
   * channel never serves traffic from behind the fold.
   */
  archived: boolean
  used_quota: number
  request_count: number
  error_count: number
  last_error: string
  last_error_at: string | null
  tested_at: string | null
  models_synced_at: string | null
  note: string
  created_at: string
  /** Opens the channel daily and closes it again after enough successes. */
  keepalive_enabled: boolean
  /** "HH:MM" in the server's timezone. */
  keepalive_at: string
  keepalive_target: number
  /** Whether a window is currently counting. Server-owned; never submitted. */
  keepalive_open: boolean
  keepalive_success: number
  keepalive_opened_at: string | null
}

export interface RequestLog {
  id: number
  created_at: string
  user_id: number
  username: string
  token_name: string
  channel_id: number
  channel_name: string
  model: string
  upstream_model: string
  endpoint: string
  method: string
  status_code: number
  stream: boolean
  prompt_tokens: number
  completion_tokens: number
  /** Prompt tokens served from cache; already part of prompt_tokens. */
  cached_tokens: number
  /** Prompt tokens written into the cache; also part of prompt_tokens. */
  cache_creation_tokens: number
  total_tokens: number
  cost: number
  duration_ms: number
  ttfb_ms: number
  retries: number
  error: string
  /** What the caller asked the model to spend on thinking; "" when unset. */
  reasoning_effort: string
  /** Tool that made the call, guessed from its headers. */
  client_type: string
  /**
   * Address the call came from. Taken from X-Forwarded-For when a proxy sets
   * it, so a direct caller can put anything here; treat it as a hint.
   */
  client_ip: string
}

/** Buys exactly one account; an administrator generates and hands it out. */
export interface InviteCode {
  id: number
  code: string
  name: string
  status: number
  used_by: number | null
  used_by_name: string
  used_at: string | null
  expires_at: string | null
  created_at: string
}

export interface ChannelTestResult {
  ok: boolean
  model: string
  latency_ms: number
  status: number
  message: string
  /** Only present for a prompted probe. */
  prompt?: string
  reply?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens: number
    total_tokens: number
  }
  /** Where the probe actually went: model after model_mapping, and the path. */
  upstream_model?: string
  endpoint?: string
}

/** A built-in probe prompt, compiled into the server. */
export interface PromptTemplate {
  id: string
  name: string
  prompt: string
}

export interface BatchTestResult extends ChannelTestResult {
  channel_id: number
  name: string
}

/** A channel draft parsed out of pasted text. Nothing is persisted yet. */
export interface ChannelImportPreview {
  base_url: string
  api_key: string
  auth_style: 'auto' | 'bearer' | 'x-api-key' | 'x-goog-api-key'
  suggested_name: string
  supported_protocols: string[]
  models: string[]
  model_error?: string
  existing_channel?: { id: number; name: string; status: number }
}

/** Credit left on the upstream account. Only aggregators report this. */
export interface ChannelBalance {
  ok: boolean
  provider: string
  total_usd: number | null
  used_usd: number | null
  remaining_usd: number | null
  currency: string
  plan_name?: string
  message?: string
}

export interface ModelPrice {
  model: string
  input_price: number
  output_price: number
  cached_price: number
  per_request_price: number
  updated_at?: string
}

/** What the gateway does with a model that has no price entry. */
export type UnpricedPolicy = 'reject' | 'fallback' | 'free'

export interface BillingSettings {
  unpriced_policy: UnpricedPolicy
  fallback: {
    input_price: number
    output_price: number
    cached_price: number
    per_request_price: number
  }
}

export interface UnpricedReport {
  data: string[]
  total: number
  policy: UnpricedPolicy
}

/** Metadata about the price table compiled into the server. */
export interface PriceCatalog {
  total: number
  source: string
  generated_at: string
}

/** One model in the plaza: reachable by the caller's group, with base prices. */
export interface PlazaModel {
  model: string
  input_price: number
  output_price: number
  cached_price: number
  per_request_price: number
  /** "exact" configured entry; "fallback" operator default; "missing" unpriced. */
  price_status: 'exact' | 'fallback' | 'missing'
}

export interface PlazaResponse {
  data: PlazaModel[]
  group: string
  /** Billing multiplier of the caller's group; prices above are before it. */
  group_rate: number
  unpriced_policy: UnpricedPolicy
}

export interface UserGroup {
  name: string
  rate: number
  description: string
  /** Whether a regular account may point one of its own keys at this group. */
  user_selectable: boolean
  created_at?: string
}

export interface Page<T> {
  data: T[]
  total: number
}

/** One category of prompts to intercept, with the replies it is answered from. */
export interface BlockRule {
  /** Labels the group in the operator's log; never sent to a caller. */
  name: string
  enabled: boolean
  /** Case-insensitive substrings of the request body. */
  keywords: string[]
  /** The pool a match is answered from, one drawn at random per request. */
  replies: string[]
  /** Overrides the global status for this group; 0 inherits it. */
  status: number
}

/** Console-wide preferences, stored server-side and shared by every browser. */
export interface ConsoleSettings {
  default_page_size: number
  /** Balance granted to a self-registered account, in USD. */
  init_quota_usd: number
  /** How much of a request or response is kept, in bytes. */
  log_body_limit: number
  /** Whether visitors may create their own account. */
  allow_register: boolean
  /** Seeds the channel form when a quick import creates a new channel. */
  import_priority: number
  import_weight: number
  /** How many recent calls keep their full request and reply. 0 records none. */
  log_detail_keep: number
  /** Whether self-registration needs a code an administrator generated. */
  require_invite_code: boolean
  /** The default a group inherits when it sets no status of its own: 2xx
   *  delivers its reply as a model answer, anything else as an error. */
  blocked_status: number
  /** The keyword groups a request body is checked against. */
  block_rules: BlockRule[]
  /** Max upstream attempts per request. Each retry picks a different channel. */
  max_retries: number
  /** Base delay between retries, in milliseconds. */
  retry_backoff_ms: number
}

/** The full request and reply for one call, kept only for recent ones. */
export interface RequestLogDetail {
  log_id: number
  created_at: string
  request_headers?: Record<string, string[]>
  request_body?: string
  request_truncated: boolean
  response_headers?: Record<string, string[]>
  response_body?: string
  response_truncated: boolean
}

/** Prepaid credit an administrator generates and a user exchanges once. */
export interface Redemption {
  id: number
  code: string
  name: string
  /** Campaign tag; a user may claim only one code per non-empty group. */
  group: string
  quota: number
  status: number
  used_by: number | null
  used_by_name: string
  used_at: string | null
  expires_at: string | null
  created_at: string
}

export interface Stats {
  summary: {
    requests: number
    errors: number
    cost: number
    total_tokens: number
  }
  series: {
    bucket: string
    requests: number
    errors: number
    cost: number
    total_tokens: number
  }[]
  by_model: {
    name: string
    requests: number
    cost: number
    total_tokens: number
  }[]
  by_channel?: {
    name: string
    requests: number
    cost: number
    total_tokens: number
  }[]
  by_user?: {
    name: string
    requests: number
    cost: number
    total_tokens: number
  }[]
  user_count?: number
  channel_count?: number
}

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
    /** Writes the built-in models.dev snapshot into the price table. */
    importPrices: (overwrite: boolean) =>
      request<{ imported: number; skipped: number } & PriceCatalog>(
        'POST',
        `/api/admin/prices/import${qs({ overwrite })}`,
      ),
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
    stats: (params: Record<string, unknown>) =>
      request<Stats>('GET', `/api/admin/stats${qs(params)}`),
  },
}
