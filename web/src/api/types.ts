/**
 * Wire types shared with the Go API. Field names mirror the JSON the server
 * sends; comments explain the ones whose meaning is not obvious from the name.
 */

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
  /** Extra attempts this channel gets before the request moves to another one. 0 = one shot. */
  retry_count: number
  /** Base delay between this channel's own retries in ms. 0 = the global interval. */
  retry_backoff_ms: number
  test_model: string
  supported_protocols: string[]
  /**
   * Thinking-level renames, keyed by which models they apply to: "*" is every
   * model the channel serves, "gpt-5*" a prefix, a bare name only itself.
   */
  reasoning_effort_mapping: Record<string, Record<string, string>>
  /**
   * Upstream error code -> the code the caller is sent, e.g. { "429": 503 }.
   * Retries and failover still read the upstream's own code.
   */
  status_code_mapping: Record<string, number>
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
  /** What the caller was answered. */
  status_code: number
  /**
   * What the upstream said, when a channel rule rewrote it into status_code;
   * 0 when no rule fired. Administrator rows only.
   */
  upstream_status: number
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

/** Where the price catalogue comes from, and when it was last imported. */
export interface PriceCatalog {
  source: string
  /** Empty when MODELS_DEV_URL is unset: the deployment has no egress. */
  url: string
  synced_at: string | null
}

/** One existing price an import would rewrite. */
export interface PriceChange {
  model: string
  old: ModelPrice
  new: ModelPrice
}

/** What pulling the catalogue would do to the price table. */
export interface PriceImportPlan {
  /** True when nothing was written — the preview the console asks for first. */
  dry_run: boolean
  overwrite: boolean
  /** How many models the catalogue offered. */
  total: number
  added: ModelPrice[]
  changed: PriceChange[]
  /** Existing rows left alone because the import was additive. */
  kept: number
  /** Existing rows already at the catalogue's rate. */
  unchanged: number
  /**
   * Identifies the feed this plan was computed from. Sending the plan back
   * applies it only if the catalogue is still these bytes; otherwise 409.
   */
  feed_sha256?: string
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
