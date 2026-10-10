import { useEffect, useState } from "react";

// The number steps in tenths, so the clock ticks at the same rate.
const TICK_MS = 100;

// One clock for every running row: they all step in the same render, and the
// page holds a single timer however many calls are live. It stops when the
// last subscriber leaves.
const subscribers = new Set<(now: number) => void>();
let timer: number | undefined;

const subscribe = (setNow: (now: number) => void) => {
  subscribers.add(setNow);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      const now = Date.now();
      subscribers.forEach((notify) => notify(now));
    }, TICK_MS);
  }

  return () => {
    subscribers.delete(setNow);
    if (subscribers.size > 0) return;
    window.clearInterval(timer);
    timer = undefined;
  };
};

// "12.3 s". Floored like a stopwatch, so it never reads ahead of the clock;
// seconds throughout, so the number does not jump from "937 ms" to "1.0 s".
const format = (ms: number) => `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;

interface Props {
  /** When the call started. */
  since: string;
  className?: string;
  /** From this many milliseconds on, the number is drawn in warning orange. */
  warnAfter?: number;
}

/**
 * How long a running call has been going.
 *
 * A component of its own so a tick re-renders this span alone: driven from the
 * table, the same tick would redraw every row ten times a second.
 */
export default function Elapsed({ since, className, warnAfter }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribe(setNow), []);

  // Clamped: a browser clock behind the server's would start below zero.
  const elapsed = Math.max(0, now - new Date(since).getTime());
  const slow = warnAfter !== undefined && elapsed >= warnAfter;

  return (
    <span
      className={className}
      style={slow ? { color: "var(--app-warning)" } : undefined}
    >
      {format(elapsed)}
    </span>
  );
}
