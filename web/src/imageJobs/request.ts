import { imagesFromData, type GeneratedImage } from '../utils/images'

export const GENERATE_PATH = '/v1/images/generations'
export const EDIT_PATH = '/v1/images/edits'

// Asks this site's relay to use one channel only; honoured for an
// administrator's key and never forwarded upstream.
const PIN_CHANNEL_HEADER = 'X-Faketoken-Channel'

type Dict = Record<string, unknown>

export const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Sent only when set. Providers disagree on what they accept, and one that
 * meets a parameter it does not know answers 400 instead of ignoring it.
 */
export interface ImageOptions {
  size?: string
  quality?: string
  background?: string
  output_format?: string
  response_format?: string
}

export interface ImageRequest {
  model: string
  prompt: string
  n: number
  options: ImageOptions
  /** Provider-specific fields, merged over everything else. */
  extra: Dict
  /** Reference images; any at all turn the call into an edit. */
  references: File[]
}

export interface ImageCall {
  path: string
  headers: Record<string, string>
  body: string | FormData
}

/**
 * Generation goes as JSON. An edit has to upload its reference images, so it
 * goes as multipart, where the relay reads `model` out of the form fields.
 * `pin` names the one channel this site's relay may use.
 */
export const buildImageCall = (request: ImageRequest, key: string, pin?: number): ImageCall => {
  const fields: Dict = { model: request.model, prompt: request.prompt, n: request.n }
  for (const [name, value] of Object.entries(request.options)) {
    if (value) fields[name] = value
  }
  Object.assign(fields, request.extra)

  const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
  if (pin !== undefined) headers[PIN_CHANNEL_HEADER] = String(pin)

  if (!request.references.length) {
    return {
      path: GENERATE_PATH,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }
  }

  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, typeof value === 'string' ? value : JSON.stringify(value))
  }
  // One file goes as `image`, the only form older models accept; several go
  // as `image[]`, the array form gpt-image models read.
  const field = request.references.length > 1 ? 'image[]' : 'image'
  for (const file of request.references) form.append(field, file, file.name)
  // No Content-Type: the browser writes it, boundary included.
  return { path: EDIT_PATH, headers, body: form }
}

export interface ImageResult {
  images: GeneratedImage[]
  usage: { input?: number; output?: number } | null
  /** The payload with its base64 folded away, for reading the rest of it. */
  raw: string
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

// Base64 runs to megabytes and reads as noise. Prose such as revised_prompt
// has spaces in it, so it never matches and is kept whole.
const BASE64_RUN = /^(data:[^,]*,)?[A-Za-z0-9+/=_-]{256,}$/

const foldBase64 = (_key: string, value: unknown) =>
  typeof value === 'string' && BASE64_RUN.test(value)
    ? `${value.slice(0, 32)}…（${value.length} 字符，已折叠）`
    : value

export const readImageResult = (payload: unknown): ImageResult => {
  const root = isDict(payload) ? payload : {}
  const usage = isDict(root.usage) ? root.usage : {}
  const input = count(usage.input_tokens)
  const output = count(usage.output_tokens)
  return {
    images: imagesFromData(root.data),
    usage: input === undefined && output === undefined ? null : { input, output },
    raw: JSON.stringify(payload, foldBase64, 2),
  }
}

// An error page (Cloudflare's runs to kilobytes of HTML) past this is cut.
const FAILURE_BODY_LIMIT = 4000

/** A failed call as text worth reading: pretty JSON when the body parses. */
export const describeFailure = (status: number, body: string): string => {
  let text = body
  try {
    text = JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    // Not JSON; shown as it came.
  }
  if (text.length > FAILURE_BODY_LIMIT) text = `${text.slice(0, FAILURE_BODY_LIMIT)}…`
  // A high-quality render can outlast a front proxy: Cloudflare gives up at
  // 100 s with a 524, nginx with a 504.
  const hint =
    status === 524 || status === 504
      ? '\n生成耗时超过了前置代理的等待上限（Cloudflare 为 100 秒），可降低质量或尺寸后重试。'
      : ''
  return `HTTP ${status}${hint}\n${text}`
}
