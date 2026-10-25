import { useEffect, useState } from 'react'

import type { RequestLog } from '../api/types'

const WINDOW_MS = 60_000

interface Sample {
  ts: number
  tokens: number
}

/**
 * The rolling 60-second window of request counts and token totals, kept
 * outside React on purpose: the feed writes to it on every arrival, and the
 * meter reads it once a second. If the samples lived in component state, every
 * tick would re-render the whole log table.
 */
export interface LiveRateStore {
  seed(entries: RequestLog[]): void
  add(entry: RequestLog): void
  snapshot(): { rpm: number; tpm: number }
}

export function createLiveRateStore(): LiveRateStore {
  const samples: Sample[] = []

  const prune = () => {
    const cutoff = Date.now() - WINDOW_MS
    while (samples.length && samples[0].ts < cutoff) {
      samples.shift()
    }
  }

  return {
    seed(entries) {
      const cutoff = Date.now() - WINDOW_MS
      samples.length = 0
      for (const entry of entries) {
        const ts = new Date(entry.created_at).getTime()
        if (ts >= cutoff) samples.push({ ts, tokens: entry.total_tokens })
      }
    },
    add(entry) {
      samples.push({ ts: new Date(entry.created_at).getTime(), tokens: entry.total_tokens })
      prune()
    },
    snapshot() {
      prune()
      let tpm = 0
      for (const sample of samples) tpm += sample.tokens
      return { rpm: samples.length, tpm }
    },
  }
}

/**
 * Reads the store once a second so the window slides even when the stream is
 * quiet (a silent minute should roll the count back to zero, not freeze).
 * Only the component that calls this re-renders on the tick.
 */
export function useLiveRate(store: LiveRateStore, enabled: boolean) {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) {
      store.seed([])
      setTick((t) => t + 1)
      return
    }
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [enabled, store])

  // The tick is what makes this recompute; the samples themselves are not
  // state.
  return store.snapshot()
}
