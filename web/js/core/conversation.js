/**
 * Turns a captured request or response body back into the conversation it
 * carried.
 *
 * The relay is dialect-agnostic on the wire, so this has to recognise every
 * shape it forwards: OpenAI chat completions, Anthropic Messages, Gemini
 * generateContent, and the Responses API — each in both buffered and streamed
 * form. Anything unrecognised returns null so the caller can fall back to the
 * raw view rather than render a confidently wrong transcript.
 *
 * A part is { kind, text, name? } with kind one of text / reasoning /
 * tool_call / tool_result / image / other. A turn is { role, parts }.
 */

const isDict = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const safeParse = (text) => {
  const trimmed = text?.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

const asText = (value) => {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value, null, 2)
}

/** Tool arguments travel as a JSON string; show them formatted when they parse. */
const prettyJSON = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return value
    }
  }
  if (value == null) return ''
  return JSON.stringify(value, null, 2)
}

/**
 * Gemini says "model" where everyone else says "assistant". OpenAI's
 * reasoning models say "developer" where everyone else says "system" — same
 * slot, same meaning, renamed. Both fold into the common name so the
 * transcript reads as one conversation rather than four dialects.
 */
const ROLE_ALIAS = { model: 'assistant', developer: 'system' }

const normaliseRole = (role) => {
  const value = String(role ?? '').toLowerCase()
  return ROLE_ALIAS[value] ?? (value || 'user')
}

const nonEmpty = (parts) => parts.filter((part) => part.text.trim() !== '' || part.name)

// ------------------------------------------------------------------ content

/**
 * Flattens one message's content. Covers plain strings, OpenAI content
 * arrays, Anthropic blocks, Gemini parts and Responses items, since a single
 * request may legitimately mix several of these shapes across its turns.
 */
function partsFromContent(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : []
  if (!Array.isArray(content)) return [{ kind: 'other', text: prettyJSON(content) }]

  const out = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      out.push({ kind: 'text', text: raw })
      continue
    }
    if (!isDict(raw)) continue
    out.push(...partsFromBlock(raw))
  }
  return out
}

function partsFromBlock(block) {
  switch (String(block.type ?? '')) {
    case 'text':
    case 'input_text':
    case 'output_text':
      return [{ kind: 'text', text: asText(block.text) }]

    case 'thinking':
    case 'redacted_thinking':
      return [{ kind: 'reasoning', text: asText(block.thinking ?? block.data ?? block.text) }]

    case 'tool_use': // Anthropic
      return [{ kind: 'tool_call', name: String(block.name ?? ''), text: prettyJSON(block.input) }]

    case 'tool_result': // Anthropic
      return [
        {
          kind: 'tool_result',
          name: String(block.tool_use_id ?? ''),
          text: partsFromContent(block.content)
            .map((part) => part.text)
            .join('\n'),
        },
      ]

    case 'function_call': // Responses API
      return [{ kind: 'tool_call', name: String(block.name ?? ''), text: prettyJSON(block.arguments) }]

    case 'function_call_output': // Responses API
      return [{ kind: 'tool_result', name: String(block.call_id ?? ''), text: asText(block.output) }]

    case 'image':
    case 'image_url':
    case 'input_image':
      return [{ kind: 'image', text: '[图片]' }]

    case 'input_audio':
    case 'audio':
      return [{ kind: 'image', text: '[音频]' }]

    default:
      break
  }

  // Gemini parts carry no discriminator, so they are recognised by shape.
  if (typeof block.text === 'string') {
    return [{ kind: block.thought === true ? 'reasoning' : 'text', text: block.text }]
  }
  if (isDict(block.functionCall)) {
    const call = block.functionCall
    return [{ kind: 'tool_call', name: String(call.name ?? ''), text: prettyJSON(call.args) }]
  }
  if (isDict(block.functionResponse)) {
    const response = block.functionResponse
    return [{ kind: 'tool_result', name: String(response.name ?? ''), text: prettyJSON(response.response) }]
  }
  if (isDict(block.inlineData) || isDict(block.fileData)) {
    return [{ kind: 'image', text: '[内联数据]' }]
  }

  // Responses API wraps assistant output in a message item.
  if (block.type === 'message' && block.content != null) return partsFromContent(block.content)
  if (block.type === 'reasoning') {
    const summary = partsFromContent(block.summary ?? block.content)
      .map((part) => part.text)
      .join('\n')
    return summary ? [{ kind: 'reasoning', text: summary }] : []
  }

  return [{ kind: 'other', text: prettyJSON(block) }]
}

/** OpenAI keeps tool calls beside the content rather than inside it. */
function partsFromToolCalls(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!isDict(raw)) return []
    const fn = isDict(raw.function) ? raw.function : {}
    return [
      {
        kind: 'tool_call',
        name: String(fn.name ?? raw.name ?? ''),
        text: prettyJSON(fn.arguments ?? raw.arguments),
      },
    ]
  })
}

/** One entry of a messages / contents / input array. */
function turnFromMessage(raw) {
  if (!isDict(raw)) return null

  // Responses API mixes bare tool items into the same array as role messages.
  if (raw.role == null && typeof raw.type === 'string') {
    const parts = nonEmpty(partsFromBlock(raw))
    if (!parts.length) return null
    return { role: parts[0].kind === 'tool_result' ? 'tool' : 'assistant', parts }
  }

  const parts = [...partsFromContent(raw.content ?? raw.parts), ...partsFromToolCalls(raw.tool_calls)]
  // reasoning_content is a de-facto standard among OpenAI-compatible gateways.
  const reasoning = raw.reasoning_content ?? raw.reasoning
  if (typeof reasoning === 'string' && reasoning) {
    parts.unshift({ kind: 'reasoning', text: reasoning })
  }

  const role = normaliseRole(raw.role)
  const kept = nonEmpty(parts)
  if (!kept.length) return null
  // A tool reply is a result even when the transport calls its payload content.
  if (role === 'tool' || role === 'function') {
    return {
      role: 'tool',
      parts: kept.map((part) =>
        part.kind === 'text' ? { ...part, kind: 'tool_result', name: String(raw.tool_call_id ?? '') } : part,
      ),
    }
  }
  // Anthropic and Gemini have no tool role on the wire: results ride inside a
  // user message. When that message carries nothing but results, the speaker
  // is the tool, whatever the transport had to label it.
  if (role === 'user' && kept.every((part) => part.kind === 'tool_result')) {
    return { role: 'tool', parts: kept }
  }
  return { role, parts: kept }
}

function turnsFromList(value) {
  if (typeof value === 'string') return value ? [{ role: 'user', parts: [{ kind: 'text', text: value }] }] : []
  if (!Array.isArray(value)) return []
  return value.map(turnFromMessage).filter((turn) => turn !== null)
}

// ------------------------------------------------------------------ request

export function parseRequestConversation(body) {
  const root = safeParse(body)
  if (!isDict(root)) return null

  const turns = []

  // Every dialect keeps its system prompt outside the message list, each in
  // its own place.
  const instruction = (holder) => (isDict(holder) ? (holder.parts ?? holder.content) : undefined)
  const system =
    root.system ??
    root.instructions ??
    instruction(root.systemInstruction) ??
    instruction(root.system_instruction)
  const systemParts = nonEmpty(partsFromContent(system))
  if (systemParts.length) turns.push({ role: 'system', parts: systemParts })

  // `input` is the Responses API message list, but an embeddings request uses
  // the same key for a bare string. Requiring an array (or the instructions
  // field that only Responses sends) keeps embeddings out of the transcript.
  const responsesInput = Array.isArray(root.input) || root.instructions != null ? root.input : undefined
  turns.push(...turnsFromList(root.messages ?? root.contents ?? responsesInput))

  return turns.length ? turns : null
}

// ----------------------------------------------------------------- response

/** Pulls the JSON payloads out of an SSE transcript, ignoring keepalives. */
function eventsFromSSE(body) {
  const out = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    const parsed = safeParse(payload)
    if (isDict(parsed)) out.push(parsed)
  }
  return out
}

/** Ordered accumulator: streamed deltas arrive interleaved but land in place. */
class Blocks {
  #order = []
  #byKey = new Map()

  at(key, kind, name) {
    let part = this.#byKey.get(key)
    if (!part) {
      part = { kind, text: '' }
      if (name) part.name = name
      this.#byKey.set(key, part)
      this.#order.push(part)
    }
    if (name && !part.name) part.name = name
    return part
  }

  parts() {
    return this.#order.map((part) =>
      part.kind === 'tool_call' ? { ...part, text: prettyJSON(part.text) } : part,
    )
  }
}

const ANTHROPIC_KIND = { tool_use: 'tool_call', thinking: 'reasoning' }

function turnsFromStream(events) {
  // The Responses API repeats the finished output in its terminal event, which
  // is more reliable than replaying every delta.
  const completed = events.find((event) => event.type === 'response.completed')
  if (completed && isDict(completed.response)) {
    const parts = nonEmpty(partsFromContent(completed.response.output))
    if (parts.length) return [{ role: 'assistant', parts }]
  }

  const blocks = new Blocks()
  const anthropicKinds = new Map()

  for (const event of events) {
    const type = String(event.type ?? '')

    // ---- OpenAI chat completions
    const choices = event.choices
    if (Array.isArray(choices) && isDict(choices[0])) {
      const choice = choices[0]
      let delta = null
      if (isDict(choice.delta)) delta = choice.delta
      else if (isDict(choice.message)) delta = choice.message
      if (delta) {
        if (typeof delta.content === 'string') blocks.at('text', 'text').text += delta.content
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string') blocks.at('reasoning', 'reasoning').text += reasoning
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach((raw, fallbackIndex) => {
            if (!isDict(raw)) return
            const fn = isDict(raw.function) ? raw.function : {}
            const key = `tool:${raw.index ?? raw.id ?? fallbackIndex}`
            const part = blocks.at(key, 'tool_call', String(fn.name ?? '') || undefined)
            if (typeof fn.arguments === 'string') part.text += fn.arguments
          })
        }
      }
    }

    // ---- Anthropic Messages
    if (type === 'content_block_start' && isDict(event.content_block)) {
      const block = event.content_block
      const key = `ab:${event.index ?? 0}`
      const kind = ANTHROPIC_KIND[String(block.type ?? '')] ?? 'text'
      anthropicKinds.set(key, kind)
      const part = blocks.at(key, kind, String(block.name ?? '') || undefined)
      if (typeof block.text === 'string') part.text += block.text
    }
    if (type === 'content_block_delta' && isDict(event.delta)) {
      const delta = event.delta
      const key = `ab:${event.index ?? 0}`
      const part = blocks.at(key, anthropicKinds.get(key) ?? 'text')
      const chunk = delta.text ?? delta.partial_json ?? delta.thinking
      if (typeof chunk === 'string') part.text += chunk
    }

    // ---- Gemini
    if (Array.isArray(event.candidates) && isDict(event.candidates[0])) {
      const candidate = event.candidates[0]
      const content = isDict(candidate.content) ? candidate.content : null
      for (const part of nonEmpty(partsFromContent(content?.parts))) {
        if (part.kind === 'tool_call') {
          blocks.at(`gem:${part.name}`, 'tool_call', part.name).text = part.text
        } else {
          blocks.at(part.kind === 'reasoning' ? 'reasoning' : 'text', part.kind).text += part.text
        }
      }
    }

    // ---- Responses API deltas, for upstreams that omit response.completed
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      blocks.at('text', 'text').text += event.delta
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      blocks.at('reasoning', 'reasoning').text += event.delta
    }
    if (type === 'response.output_item.added' && isDict(event.item) && event.item.type === 'function_call') {
      blocks.at(`fc:${event.item.id ?? event.output_index ?? 0}`, 'tool_call', String(event.item.name ?? ''))
    }
    if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      blocks.at(`fc:${event.item_id ?? event.output_index ?? 0}`, 'tool_call').text += event.delta
    }
  }

  const parts = nonEmpty(blocks.parts())
  return parts.length ? [{ role: 'assistant', parts }] : []
}

function turnsFromBufferedResponse(root) {
  // OpenAI
  if (Array.isArray(root.choices) && isDict(root.choices[0])) {
    const turn = turnFromMessage(root.choices[0].message ?? root.choices[0].delta)
    if (turn) return [{ ...turn, role: 'assistant' }]
  }
  // Anthropic Messages
  if (Array.isArray(root.content)) {
    const parts = nonEmpty(partsFromContent(root.content))
    if (parts.length) return [{ role: 'assistant', parts }]
  }
  // Responses API
  if (Array.isArray(root.output)) {
    const parts = nonEmpty(partsFromContent(root.output))
    if (parts.length) return [{ role: 'assistant', parts }]
  }
  if (isDict(root.response) && Array.isArray(root.response.output)) {
    const parts = nonEmpty(partsFromContent(root.response.output))
    if (parts.length) return [{ role: 'assistant', parts }]
  }
  // Gemini
  if (Array.isArray(root.candidates) && isDict(root.candidates[0])) {
    const content = root.candidates[0].content
    const parts = nonEmpty(partsFromContent(isDict(content) ? content.parts : content))
    if (parts.length) return [{ role: 'assistant', parts }]
  }
  // An upstream error is the most useful thing to show when nothing else fits.
  if (isDict(root.error) || typeof root.error === 'string') {
    return [{ role: 'assistant', parts: [{ kind: 'other', text: prettyJSON(root.error) }] }]
  }
  return []
}

export function parseResponseConversation(body) {
  const text = body?.trim()
  if (!text) return null

  const buffered = safeParse(text)
  if (isDict(buffered)) {
    const turns = turnsFromBufferedResponse(buffered)
    return turns.length ? turns : null
  }

  const events = eventsFromSSE(text)
  if (!events.length) return null
  const turns = turnsFromStream(events)
  return turns.length ? turns : null
}
