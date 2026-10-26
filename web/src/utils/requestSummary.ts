/**
 * What a request is made of, measured: how much is system prompt, tool
 * definitions, conversation and images, where the cache breakpoints sit, and
 * the parameters that shape the answer. Answers "why is this call so big" at
 * a glance: an 11 MB request that is 7 screenshots reads as exactly that.
 *
 * Sizes are characters of the stored JSON, which for ASCII-heavy bodies is the
 * byte count; images are the decoded size of their base64.
 */

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const size = (value: unknown) => (value == null ? 0 : JSON.stringify(value).length)

export interface RequestSummary {
  systemChars: number
  tools: { count: number; chars: number; names: string[] }
  messages: { count: number; chars: number; byRole: Record<string, number> }
  images: { count: number; bytes: number }
  /** Where cache_control sits: "system", "工具 Read", "消息 #12". */
  breakpoints: string[]
  /** The knobs that change the answer, as label / value. */
  params: { label: string; value: string }[]
}

// base64 carries 3 bytes in every 4 characters.
const base64Bytes = (data: unknown) =>
  typeof data === 'string' ? Math.floor((data.length - (data.indexOf(',') + 1)) * 0.75) : 0

/** The decoded size of an image block in any dialect, or 0 when it is not one. */
const imageBytes = (block: Dict): number => {
  const type = String(block.type ?? '')
  if (type === 'image' && isDict(block.source)) return base64Bytes(block.source.data)
  if (type === 'image_url') {
    const url = isDict(block.image_url) ? block.image_url.url : block.image_url
    return typeof url === 'string' && url.startsWith('data:') ? base64Bytes(url) : 1
  }
  if (type === 'input_image') {
    const url = block.image_url
    return typeof url === 'string' && url.startsWith('data:') ? base64Bytes(url) : 1
  }
  const inline = block.inlineData ?? block.inline_data
  if (isDict(inline) && String(inline.mimeType ?? inline.mime_type ?? '').startsWith('image/'))
    return base64Bytes(inline.data)
  return 0
}

/** Walks a value, reporting images and whether a cache breakpoint sits inside. */
const walk = (value: unknown, images: { count: number; bytes: number }): boolean => {
  let marked = false
  if (Array.isArray(value)) {
    for (const child of value) marked = walk(child, images) || marked
  } else if (isDict(value)) {
    if ('cache_control' in value) marked = true
    const bytes = imageBytes(value)
    if (bytes > 0) {
      images.count++
      images.bytes += bytes
      return marked
    }
    for (const child of Object.values(value)) marked = walk(child, images) || marked
  }
  return marked
}

const textLength = (value: unknown): number => {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textLength(item), 0)
  if (isDict(value)) return textLength(value.text ?? value.parts ?? value.content)
  return 0
}

export function summarizeRequest(body: string | undefined): RequestSummary | null {
  let root: unknown
  try {
    root = JSON.parse(body ?? '')
  } catch {
    return null
  }
  if (!isDict(root)) return null

  const system = root.system ?? root.instructions ?? root.systemInstruction ?? root.system_instruction
  const list = root.messages ?? root.contents ?? (Array.isArray(root.input) ? root.input : undefined)
  const tools = Array.isArray(root.tools) ? root.tools : []
  if (!Array.isArray(list) && !tools.length && system == null) return null

  const images = { count: 0, bytes: 0 }
  const breakpoints: string[] = []
  if (walk(system, images)) breakpoints.push('system')
  for (const tool of tools) {
    if (!isDict(tool)) continue
    if ('cache_control' in tool) {
      const name = tool.name ?? (isDict(tool.function) ? tool.function.name : undefined)
      breakpoints.push(`工具 ${String(name ?? '?')}`)
    }
  }

  const byRole: Record<string, number> = {}
  const messages = Array.isArray(list) ? list : []
  messages.forEach((message, index) => {
    const role = isDict(message) ? String(message.role ?? message.type ?? 'other') : 'other'
    byRole[role] = (byRole[role] ?? 0) + 1
    if (walk(message, images)) breakpoints.push(`消息 #${index + 1}`)
  })

  const params: { label: string; value: string }[] = []
  const put = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    params.push({ label, value: typeof value === 'object' ? JSON.stringify(value) : String(value) })
  }
  put('max_tokens', root.max_tokens ?? root.max_completion_tokens ?? root.max_output_tokens)
  if (isDict(root.thinking)) {
    put('思考', [root.thinking.type, root.thinking.budget_tokens].filter((v) => v != null).join(' '))
  }
  put('思考强度', isDict(root.reasoning) ? root.reasoning.effort : root.reasoning_effort)
  if (isDict(root.output_config)) put('输出', root.output_config)
  put('temperature', root.temperature)
  put('top_p', root.top_p)
  put('top_k', root.top_k)
  put('tool_choice', root.tool_choice)

  return {
    systemChars: textLength(system),
    tools: {
      count: tools.length,
      chars: size(tools),
      names: tools
        .map((tool) => (isDict(tool) ? tool.name ?? (isDict(tool.function) ? tool.function.name : '') : ''))
        .map(String)
        .filter(Boolean),
    },
    messages: { count: messages.length, chars: size(messages), byRole },
    images,
    breakpoints,
    params,
  }
}
