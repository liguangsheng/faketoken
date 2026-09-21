/**
 * The calls the server says are running right now.
 *
 * Reconciled against what the feed announces and what it lists on every
 * heartbeat. A running call is drawn as a placeholder row that the settled
 * row eventually replaces; `live_key` is what ties the two together.
 */

// How many consecutive reconciliations may miss a placeholder before it is
// dropped. One is not enough: a call leaves the server's live set as soon as
// the caller has been answered, a moment before its row is written.
const INFLIGHT_SYNC_GRACE = 2

/** Table row key. Live rows have no id yet, so they key off their own handle. */
export const rowKeyOf = (row) => (row.live_key !== undefined ? `live:${row.live_key}` : String(row.id))

export const isLive = (row) => row.live_key !== undefined

/**
 * Creates the tracker.
 *
 *   { isFrozen(), onChange() }
 *
 * While `isFrozen()` is true (the pointer is over the table) the committed
 * view stays put and changes accumulate; `publish()` releases them. That is
 * what lets a row be clicked on a busy feed: rows that keep sliding away from
 * the cursor cannot be.
 */
export function createInflight({ isFrozen, onChange }) {
  // `live` is always current; `committed` is what the table draws.
  let live = new Map()
  let committed = new Map()
  // Per placeholder, how many reconciliations in a row have not mentioned it.
  const missedSyncs = new Map()

  const commit = (next) => {
    live = next
    if (!isFrozen()) {
      committed = next
      onChange()
    }
  }

  return {
    /** The committed view, newest first, like the rows beneath them. */
    rows: () =>
      [...committed.values()].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    /** How many are running, from the tracked set rather than the drawn one. */
    size: () => live.size,

    /** Adopts what accumulated while the view was frozen. */
    publish() {
      if (committed === live) return
      committed = live
      onChange()
    },

    /** A call was announced, or re-announced with the channel it is now on. */
    announce(key, entry) {
      // Upsert, not append: the same key is announced again each time the
      // call is routed or retried, so the row names the upstream being waited
      // on. The table tells a first sighting from a rewrite by itself.
      const next = new Map(live)
      next.set(key, { ...entry, live_key: key })
      commit(next)
    },

    /** The heartbeat's complete set. */
    sync(calls) {
      if (!calls.length && !live.size) return
      // Adopted wholesale: the server is naming the complete set this feed
      // should be showing, which recovers a start that never arrived as well
      // as an end that never did.
      const next = new Map()
      for (const { key, entry } of calls) {
        next.set(key, { ...entry, live_key: key })
        missedSyncs.delete(key)
      }
      for (const [key, row] of live) {
        if (next.has(key)) continue
        // A grace period before dropping: a sync landing between "answered"
        // and "written" must not erase a placeholder whose real row is
        // already on its way.
        const misses = (missedSyncs.get(key) ?? 0) + 1
        if (misses < INFLIGHT_SYNC_GRACE) {
          missedSyncs.set(key, misses)
          next.set(key, row)
          continue
        }
        missedSyncs.delete(key)
      }
      commit(next)
    },

    /** The settled row arrived; its placeholder is retired. */
    retire(key) {
      if (!live.has(key)) return
      const next = new Map(live)
      next.delete(key)
      missedSyncs.delete(key)
      commit(next)
    },

    /** Drops everything: a new feed will state what is still running. */
    reset() {
      live = new Map()
      missedSyncs.clear()
      if (committed.size) {
        committed = new Map()
        onChange()
      }
    },
  }
}
