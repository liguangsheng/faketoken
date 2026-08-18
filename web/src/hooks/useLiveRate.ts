import { useCallback, useEffect, useRef, useState } from 'react'

import type { RequestLog } from '../api/client'

const WINDOW_MS = 60_000

interface Sample {
  ts: number
  tokens: number
}

/**
 * Rolling 60-second window of request counts and token totals, computed
 * entirely on the client from what the first page already shows. Not a
 * precise cluster-wide meter — rows fall off when they leave the page —
 * but a faithful "what is happening right now" pulse for the logs view.
 */
export function useLiveRate(enabled: boolean) {
  const samples = useRef<Sample[]>([])
  // Re-render once a second so the window slides even when the stream is
  // quiet (a silent minute should roll the count back to zero, not freeze).
  const [, setTick] = useState(0)

  const prune = useCallback(() => {
    const cutoff = Date.now() - WINDOW_MS
    while (samples.current.length && samples.current[0].ts < cutoff) {
      samples.current.shift()
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      samples.current = []
      setTick((t) => t + 1)
      return
    }
    const id = window.setInterval(() => {
      prune()
      setTick((t) => t + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [enabled, prune])

  const seed = useCallback(
    (entries: RequestLog[]) => {
      const cutoff = Date.now() - WINDOW_MS
      samples.current = entries
        .map((e) => ({ ts: new Date(e.created_at).getTime(), tokens: e.total_tokens }))
        .filter((s) => s.ts >= cutoff)
      setTick((t) => t + 1)
    },
    [],
  )

  const add = useCallback((entry: RequestLog) => {
    samples.current.push({ ts: new Date(entry.created_at).getTime(), tokens: entry.total_tokens })
    prune()
  }, [prune])

  prune()
  const count = samples.current.length
  const tokens = samples.current.reduce((sum, s) => sum + s.tokens, 0)
  return { rpm: count, tpm: tokens, sampleCount: count, seed, add }
}
