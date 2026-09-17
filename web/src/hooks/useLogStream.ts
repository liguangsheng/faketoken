import { useEffect, useRef, useState } from 'react'

import { session, type RequestLog } from '../api/client'

/**
 * Subscribes to the server-sent log feed.
 *
 * Deliberately not EventSource: that API cannot send an Authorization header,
 * and the session token is a bearer credential kept in localStorage. Passing it
 * in the query string instead would write it into every access log and proxy
 * trace along the way. fetch + ReadableStream gives the same protocol with a
 * proper header.
 */
export type StreamState = 'connecting' | 'live' | 'offline'

/**
 * A call the server has started but not finished. The entry is a partial
 * RequestLog: no id, no status code, no usage, and created_at is when the call
 * started rather than when it will settle.
 */
export interface InflightCall {
  /** Ties this announcement to the row that eventually replaces it. */
  key: string
  entry: RequestLog
}

interface Options {
  /** Absolute path of the SSE endpoint, filters included. */
  url: string
  /** Set false to disconnect, e.g. while the user is reading an old page. */
  enabled: boolean
  /** A settled row. The key names the in-flight placeholder it retires, and is
   *  empty for a call that was answered before it ever reached an upstream. */
  onEntry: (entry: RequestLog, key: string) => void
  /** A call that is still running. Raised repeatedly for one key as the call is
   *  routed and retried, so callers upsert rather than append. */
  onInflight?: (call: InflightCall) => void
  /** The complete set of calls still running server-side, restated on every
   *  heartbeat. Authoritative in both directions: adopt it wholesale and a
   *  start that never arrived is recovered just as an end that never arrived
   *  is. */
  onInflightSync?: (calls: InflightCall[]) => void
  /** Called after a dropped connection is re-established, so the caller can
   *  reload the list to recover entries missed while the stream was down. */
  onReconnect?: () => void
}

// Backoff between reconnection attempts. A dropped stream is normal (laptop
// sleeps, proxy recycles); reconnecting immediately in a tight loop is not.
const RETRY_MS = [1000, 2000, 5000, 10000]

export function useLogStream({
  url,
  enabled,
  onEntry,
  onInflight,
  onInflightSync,
  onReconnect,
}: Options): StreamState {
  const [state, setState] = useState<StreamState>('offline')
  // Kept in a ref so a changing callback identity does not tear the stream
  // down and reconnect on every render.
  const onEntryRef = useRef(onEntry)
  onEntryRef.current = onEntry
  const onInflightRef = useRef(onInflight)
  onInflightRef.current = onInflight
  const onInflightSyncRef = useRef(onInflightSync)
  onInflightSyncRef.current = onInflightSync
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect

  useEffect(() => {
    if (!enabled) {
      setState('offline')
      return
    }

    const controller = new AbortController()
    let attempt = 0
    let wasLive = false
    let stopped = false
    let retryTimer: number | undefined

    const connect = async () => {
      setState('connecting')
      try {
        const token = session.get()
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        })
        if (!response.ok || !response.body) {
          throw new Error(`stream failed: HTTP ${response.status}`)
        }

        // Recovering from a dropped connection: reload the list to fill the
        // gap that formed while we were offline.
        if (wasLive && onReconnectRef.current) {
          onReconnectRef.current()
        }
        setState('live')
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
            // A frame names its event and carries one data line; lines that are
            // neither are comments, which is what the keepalive rides on.
            let name = 'message'
            let data = ''
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) name = line.slice(7).trim()
              else if (line.startsWith('data: ')) data = line.slice(6)
            }
            if (!data) continue

            try {
              const payload: unknown = JSON.parse(data)
              if (name === 'inflight_sync') {
                const calls = (payload as { calls?: InflightCall[] }).calls
                if (Array.isArray(calls)) {
                  onInflightSyncRef.current?.(calls.filter((call) => call?.entry))
                }
                continue
              }
              const { key = '', entry } = payload as { key?: string; entry?: RequestLog }
              if (!entry) continue
              if (name === 'inflight') onInflightRef.current?.({ key, entry })
              else onEntryRef.current(entry, key)
            } catch {
              // A truncated frame is not worth surfacing; the next one is fine.
            }
          }
        }
        throw new Error('stream ended')
      } catch (error) {
        if (stopped || controller.signal.aborted) return
        setState('offline')
        const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
        attempt += 1
        retryTimer = window.setTimeout(() => void connect(), delay)
        void error
      }
    }

    void connect()

    return () => {
      stopped = true
      controller.abort()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [url, enabled])

  return state
}
