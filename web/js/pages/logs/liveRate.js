/**
 * Rolling 60-second window of request counts and token totals, computed
 * entirely on the client from what the first page already shows.
 *
 * Not a precise cluster-wide meter — rows fall off when they leave the page
 * — but a faithful "what is happening right now" pulse for the logs view.
 */

const WINDOW_MS = 60_000

/** `onTick` fires once a second so the window slides even when the stream is quiet. */
export function createLiveRate({ onTick }) {
  let samples = []
  let timer = null

  const prune = () => {
    const cutoff = Date.now() - WINDOW_MS
    while (samples.length && samples[0].ts < cutoff) samples.shift()
  }

  return {
    rpm: () => {
      prune()
      return samples.length
    },
    tpm: () => {
      prune()
      return samples.reduce((sum, sample) => sum + sample.tokens, 0)
    },

    /** Re-seeded on every first-page load; the SSE additions pile on top. */
    seed(entries) {
      const cutoff = Date.now() - WINDOW_MS
      samples = entries
        .map((entry) => ({ ts: new Date(entry.created_at).getTime(), tokens: entry.total_tokens }))
        .filter((sample) => sample.ts >= cutoff)
    },

    add(entry) {
      samples.push({ ts: new Date(entry.created_at).getTime(), tokens: entry.total_tokens })
      prune()
    },

    start() {
      if (timer) return
      timer = window.setInterval(() => {
        prune()
        onTick()
      }, 1000)
    },

    stop() {
      if (timer) window.clearInterval(timer)
      timer = null
      samples = []
    },
  }
}
