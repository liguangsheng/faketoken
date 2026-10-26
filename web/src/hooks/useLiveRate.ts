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
  /** Folds in rows a list load returned; rows already counted are skipped. */
  merge(entries: RequestLog[]): void
  add(entry: RequestLog): void
  /** Forgets every sample: the filters changed, or the meter was parked. */
  clear(): void
  snapshot(): { rpm: number; tpm: number }
}

export function createLiveRateStore(): LiveRateStore {
  // By log id: the same call arrives over the feed and again in the next page
  // load, and counts once.
  const samples = new Map<number, Sample>()

  // Not a queue: a page load comes newest first, so arrival order says nothing
  // about age.
  const prune = () => {
    const cutoff = Date.now() - WINDOW_MS
    for (const [id, sample] of samples) {
      if (sample.ts < cutoff) samples.delete(id)
    }
  }

  const add = (entry: RequestLog) => {
    if (!samples.has(entry.id)) {
      samples.set(entry.id, { ts: new Date(entry.created_at).getTime(), tokens: entry.total_tokens })
    }
  }

  return {
    merge(entries) {
      for (const entry of entries) add(entry)
      prune()
    },
    add(entry) {
      add(entry)
      prune()
    },
    clear() {
      samples.clear()
    },
    snapshot() {
      prune()
      let tpm = 0
      for (const sample of samples.values()) tpm += sample.tokens
      return { rpm: samples.size, tpm }
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
      store.clear()
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
