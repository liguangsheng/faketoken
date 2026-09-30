/**
 * Images API results, read the same way by the log's conversation view and
 * the image playground.
 */

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The Images API returns bare base64 and does not say which format it chose,
// so the type is read off the leading bytes: "iVBORw0KGgo" is PNG's magic.
const IMAGE_SIGNATURES: Array<[string, string]> = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['UklGR', 'image/webp'],
]

export const imageDataURL = (base64: string): string => {
  const type = IMAGE_SIGNATURES.find(([prefix]) => base64.startsWith(prefix))?.[1] ?? 'image/png'
  return `data:${type};base64,${base64}`
}

export interface GeneratedImage {
  /** A data: URL, or an http(s) URL when the upstream returned only a link. */
  src: string
  /** The prompt the model actually drew from, when it rewrote the one sent. */
  revisedPrompt: string
}

/**
 * Reads `data: [{ b64_json | url, revised_prompt }]`. The inline bytes win over
 * the URL, which often points at a host only the upstream can reach (a LAN
 * address). Embeddings and model lists share the `data` key but carry neither
 * field, so they yield nothing.
 */
export const imagesFromData = (value: unknown): GeneratedImage[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!isDict(raw)) return []
    let src = ''
    if (typeof raw.b64_json === 'string' && raw.b64_json) src = imageDataURL(raw.b64_json)
    else if (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) src = raw.url
    if (!src) return []
    const revisedPrompt = typeof raw.revised_prompt === 'string' ? raw.revised_prompt : ''
    return [{ src, revisedPrompt }]
  })
}

/**
 * "png", "jpg" or "webp": from the MIME type when there is one (a Blob's),
 * else from a data: URL's type or a link's file name.
 */
export const imageExtension = (src: string, type?: string): string => {
  const subtype = (
    type?.startsWith('image/') ? type.slice('image/'.length) : /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(src)?.[1]
  )?.toLowerCase()
  if (subtype) return subtype === 'jpeg' ? 'jpg' : subtype
  try {
    return /\.([a-z0-9]+)$/i.exec(new URL(src).pathname)?.[1]?.toLowerCase() ?? 'png'
  } catch {
    return 'png'
  }
}
