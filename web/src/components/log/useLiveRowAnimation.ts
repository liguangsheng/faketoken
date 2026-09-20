import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TableRef } from "antd/es/table";

// Keep the class around until the highlight has fully faded. The CSS motion is
// shorter, but the small cushion also covers its per-cell stagger.
const LIVE_ROW_ANIMATION_MS = 1000;
const LIVE_ROW_SHIFT_MS = 620;
const LIVE_ROW_SHIFT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

interface LiveRowLayout {
  /** Row key of the record being inserted, settled or still running. */
  rowKey: string;
  tops: Map<string, number>;
}

/**
 * The motion for a row arriving at the top of the live feed: the newcomer is
 * highlighted, and every row below it slides down from where it was (FLIP)
 * instead of jumping.
 *
 * Reserved for the high-traffic global feed: `enabled` is false on the regular
 * user's page and for historical loads, which stay still.
 *
 * Usage: call `capture(rowKey)` right before the state change that inserts the
 * row, `enter(id)` for a settled row that should be highlighted, and pass
 * `layoutDeps` — the state whose commit moves the rows — so the shift is
 * measured after React lays them out.
 */
export function useLiveRowAnimation(enabled: boolean, layoutDeps: unknown[]) {
  const [enteringRowIDs, setEnteringRowIDs] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const enteringRowTimers = useRef(new Map<number, number>());
  const tableRef = useRef<TableRef>(null);
  const pendingLayout = useRef<LiveRowLayout | null>(null);
  const shiftAnimations = useRef(new Map<string, Animation>());

  // FLIP starts before React inserts the new record: remember where every
  // visible row is right now. getBoundingClientRect includes any in-flight
  // transform, which lets a busy feed continue smoothly from the exact visual
  // position reached by the previous push.
  const capture = useCallback(
    (rowKey: string) => {
      const root = tableRef.current?.nativeElement;
      if (
        !enabled ||
        !root ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        pendingLayout.current = null;
        return;
      }

      const tops = new Map<string, number>();
      root
        .querySelectorAll<HTMLElement>(".ant-table-tbody > tr[data-row-key]")
        .forEach((row) => {
          const key = row.dataset.rowKey;
          if (key) tops.set(key, row.getBoundingClientRect().top);
        });
      pendingLayout.current = { rowKey, tops };
    },
    [enabled],
  );

  const enter = useCallback(
    (id: number) => {
      if (!enabled) return;

      setEnteringRowIDs((current) => new Set(current).add(id));

      const previousTimer = enteringRowTimers.current.get(id);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);

      const timer = window.setTimeout(() => {
        enteringRowTimers.current.delete(id);
        setEnteringRowIDs((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, LIVE_ROW_ANIMATION_MS);
      enteringRowTimers.current.set(id, timer);
    },
    [enabled],
  );

  useEffect(
    () => () => {
      enteringRowTimers.current.forEach((timer) => window.clearTimeout(timer));
      enteringRowTimers.current.clear();
      pendingLayout.current = null;
      const animations = [...shiftAnimations.current.values()];
      shiftAnimations.current.clear();
      animations.forEach((animation) => animation.cancel());
    },
    [],
  );

  // React has committed the new table layout, but the browser has not painted
  // it yet. Move every old row back to its captured position, then animate to
  // the new one. Visually, the incoming row now pushes the whole list down.
  useLayoutEffect(() => {
    const snapshot = pendingLayout.current;
    const root = tableRef.current?.nativeElement;
    if (!snapshot || !root) return;

    const visibleRows = [
      ...root.querySelectorAll<HTMLElement>(
        ".ant-table-tbody > tr[data-row-key]",
      ),
    ];
    const entryKey = snapshot.rowKey;
    const entryExists = visibleRows.some(
      (row) => row.dataset.rowKey === entryKey,
    );

    // State updates are normally batched. If React happens to commit the
    // animation marker first, wait for the following rows commit; an entry
    // already present in the snapshot is merely an SSE/list race (no shift).
    if (!entryExists && !snapshot.tops.has(entryKey)) return;
    pendingLayout.current = null;

    // Cancel after capturing the old visual positions, so the next delta is
    // measured against each row's clean, final layout position.
    const previousAnimations = [...shiftAnimations.current.values()];
    shiftAnimations.current.clear();
    previousAnimations.forEach((animation) => animation.cancel());

    visibleRows.forEach((row) => {
      const key = row.dataset.rowKey;
      if (!key) return;
      const previousTop = snapshot.tops.get(key);
      if (previousTop === undefined) return;

      const deltaY = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 0.5) return;

      const animation = row.animate(
        [
          { transform: `translate3d(0, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: LIVE_ROW_SHIFT_MS, easing: LIVE_ROW_SHIFT_EASING },
      );
      shiftAnimations.current.set(key, animation);

      const release = () => {
        if (shiftAnimations.current.get(key) === animation) {
          shiftAnimations.current.delete(key);
        }
      };
      animation.onfinish = release;
      animation.oncancel = release;
    });
    // The caller names the state whose commit moves the rows; the marker set
    // is part of it because a highlight commit can land first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enteringRowIDs, ...layoutDeps]);

  return { tableRef, enteringRowIDs, capture, enter };
}
