import { useCallback, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import type { RequestLog } from "../../api/types";

/**
 * A row that is either a settled log entry or a call still in flight.
 *
 * The two share a shape on purpose: an in-flight call is the same record with
 * everything it has not produced yet left at zero, so every column renders it
 * without a parallel set of components. live_key is what tells them apart, and
 * it is also the handle the settled row uses to replace this one.
 */
export type LogRow = RequestLog & { live_key?: string };

// A type predicate, so the branches that draw a running row can reach its
// handle without asserting it back into existence.
export const isLive = (row: LogRow): row is LogRow & { live_key: string } =>
  row.live_key !== undefined;

/** Table row key. Live rows have no id yet, so they key off their own handle. */
export const rowKeyOf = (row: LogRow) =>
  row.live_key !== undefined ? `live:${row.live_key}` : String(row.id);

// How many consecutive reconciliations may miss a placeholder before it is
// dropped. One is not enough: a call leaves the server's live set as soon as the
// caller has been answered, a moment before its row is written.
const INFLIGHT_SYNC_GRACE = 2;

interface Options {
  /** Whether the set is tracked at all; false on a regular user's page. */
  enabled: boolean;
  /**
   * While the pointer is over the table the committed view is frozen: rows
   * that keep sliding away from the cursor cannot be clicked. The ref is
   * always current; `publish` releases what accumulated.
   */
  hoveringRef: MutableRefObject<boolean>;
  /**
   * Called before a key is committed for the first time, so the caller can
   * snapshot the layout the new row is about to push down. Not called while
   * hovering: nothing moves then.
   */
  onFirstSighting: (key: string) => void;
}

/**
 * The calls the server says are running right now, reconciled against what
 * it announces and what it lists on every heartbeat.
 */
export function useInflightCalls({ enabled, hoveringRef, onFirstSighting }: Options) {
  // The ref is always current; the state is the committed view.
  const [liveCalls, setLiveCalls] = useState<ReadonlyMap<string, LogRow>>(
    () => new Map(),
  );
  const liveRef = useRef<ReadonlyMap<string, LogRow>>(new Map());
  // Per placeholder, how many reconciliations in a row have not mentioned it.
  const missedSyncs = useRef(new Map<string, number>());

  const commit = useCallback(
    (next: ReadonlyMap<string, LogRow>) => {
      liveRef.current = next;
      if (!hoveringRef.current) setLiveCalls(next);
    },
    [hoveringRef],
  );

  /** Adopts what accumulated while the view was frozen. */
  const publish = useCallback(() => {
    setLiveCalls((current) =>
      current === liveRef.current ? current : liveRef.current,
    );
  }, []);

  /** A call was announced, or re-announced with the channel it is now on. */
  const announce = useCallback(
    (key: string, entry: RequestLog) => {
      if (!enabled) return;
      // Only a first sighting moves the rows below it; a re-announcement of a
      // call already on screen rewrites one row in place.
      if (!hoveringRef.current && !liveRef.current.has(key)) {
        onFirstSighting(key);
      }
      // Upsert, not append: the same key is announced again each time the call
      // is routed or retried, so the row names the upstream being waited on.
      const next = new Map(liveRef.current);
      next.set(key, { ...entry, live_key: key });
      commit(next);
    },
    [commit, enabled, hoveringRef, onFirstSighting],
  );

  /** The heartbeat's complete set. */
  const sync = useCallback(
    (calls: { key: string; entry: RequestLog }[]) => {
      if (!enabled) return;
      if (!calls.length && !liveRef.current.size) return;
      // Adopted wholesale: the server is naming the complete set this feed
      // should be showing, which recovers a start that never arrived as well as
      // an end that never did.
      const next = new Map<string, LogRow>();
      for (const { key, entry } of calls) {
        next.set(key, { ...entry, live_key: key });
        missedSyncs.current.delete(key);
      }
      for (const [key, row] of liveRef.current) {
        if (next.has(key)) continue;
        // A grace period before dropping: a call leaves the server's live set
        // the moment the caller has been answered, a beat before its row is
        // written, and a sync landing in that window must not erase a
        // placeholder whose real row is already on its way.
        const misses = (missedSyncs.current.get(key) ?? 0) + 1;
        if (misses < INFLIGHT_SYNC_GRACE) {
          missedSyncs.current.set(key, misses);
          next.set(key, row);
          continue;
        }
        missedSyncs.current.delete(key);
      }
      commit(next);
    },
    [commit, enabled],
  );

  /** The settled row arrived; its placeholder is retired on every page. */
  const retire = useCallback(
    (key: string) => {
      if (!liveRef.current.has(key)) return;
      const next = new Map(liveRef.current);
      next.delete(key);
      missedSyncs.current.delete(key);
      commit(next);
    },
    [commit],
  );

  /** Drops everything: a new feed will state what is still running. */
  const reset = useCallback(() => {
    liveRef.current = new Map();
    missedSyncs.current.clear();
    setLiveCalls((current) => (current.size ? new Map() : current));
  }, []);

  // Newest first, like the rows below them, so the time column still reads
  // top-to-bottom as one descending sequence.
  const liveRows = useMemo(
    () =>
      [...liveCalls.values()].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [liveCalls],
  );

  return {
    /** Committed view, for the concurrency meter. */
    liveCalls,
    liveRows,
    announce,
    sync,
    retire,
    reset,
    publish,
  };
}
