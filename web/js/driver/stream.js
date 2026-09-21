/**
 * Server-sent events driver.
 *
 * Deliberately not EventSource: that API cannot send an Authorization header,
 * and the session token is a bearer credential kept in localStorage. Passing
 * it in the query string instead would write it into every access log and
 * proxy trace along the way. fetch + ReadableStream gives the same protocol
 * with a proper header.
 */

import { session } from './http.js'

// Backoff between reconnection attempts. A dropped stream is normal (laptop
// sleeps, proxy recycles); reconnecting immediately in a tight loop is not.
const RETRY_MS = [1000, 2000, 5000, 10000]

/**
 * Opens a stream and keeps it open.
 *
 *   { url, onEvent(name, payload), onState(state), onReconnect() }
 *
 * state is 'connecting' | 'live' | 'offline'. onReconnect fires after a
 * dropped connection is re-established, so the caller can reload whatever it
 * missed while the stream was down. Returns a stop function.
 */
export function openStream({ url, onEvent, onState, onReconnect }) {
  const controller = new AbortController()
  let attempt = 0
  let wasLive = false
  let stopped = false
  let retryTimer = null

  const connect = async () => {
    onState('connecting')
    try {
      const token = session.get()
      const headers = { Accept: 'text/event-stream' }
      if (token) headers.Authorization = `Bearer ${token}`

      const response = await fetch(url, { signal: controller.signal, headers })
      if (!response.ok || !response.body) {
        throw new Error(`stream failed: HTTP ${response.status}`)
      }

      // Recovering from a drop: the caller reloads the gap that formed.
      if (wasLive) onReconnect?.()
      onState('live')
      wasLive = true
      attempt = 0

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        // Events are separated by a blank line; anything after the last one
        // is a partial frame and stays in the buffer.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''

        for (const frame of frames) {
          // A frame names its event and carries one data line; lines that
          // are neither are comments, which is what the keepalive rides on.
          let name = 'message'
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7).trim()
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!data) continue

          let payload
          try {
            payload = JSON.parse(data)
          } catch {
            // A truncated frame is not worth surfacing; the next one is fine.
            continue
          }
          onEvent(name, payload)
        }
      }
      throw new Error('stream ended')
    } catch {
      if (stopped || controller.signal.aborted) return
      onState('offline')
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
      attempt += 1
      retryTimer = window.setTimeout(() => void connect(), delay)
    }
  }

  void connect()

  return () => {
    stopped = true
    controller.abort()
    if (retryTimer) window.clearTimeout(retryTimer)
  }
}
