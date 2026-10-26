import { memo, useMemo } from "react";
import { Typography } from "antd";

import { formatBytes } from "../../utils/format";

// A pause this long between two bursts is worth pointing at: well past the
// gap between tokens of any model, short of the idle timeout.
const STALL_MS = 2000;

const W = 600;
const H = 96;

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/**
 * When the response's bytes went out, as a cumulative curve: a steep run is
 * the model writing, a flat stretch is the upstream holding back. Reads the
 * timeline the relay recorded, [ms, bytes, …] from the start of the call.
 */
function ResponseTimeline({ timing }: { timing: number[] }) {
  const view = useMemo(() => {
    const points: { ms: number; bytes: number }[] = [];
    for (let i = 0; i + 1 < timing.length; i += 2) points.push({ ms: timing[i], bytes: timing[i + 1] });
    if (points.length < 2) return null;

    const first = points.find((p) => p.bytes > 0) ?? points[points.length - 1];
    const last = points[points.length - 1];
    const stalls: { from: number; to: number }[] = [];
    for (let i = 1; i < points.length; i++) {
      if (points[i].ms - points[i - 1].ms >= STALL_MS && points[i].bytes > points[i - 1].bytes) {
        stalls.push({ from: points[i - 1].ms, to: points[i].ms });
      }
    }
    stalls.sort((a, b) => b.to - b.from - (a.to - a.from));

    const span = Math.max(last.ms, 1);
    const total = Math.max(last.bytes, 1);
    const x = (ms: number) => (ms / span) * W;
    const y = (bytes: number) => H - (bytes / total) * (H - 4) - 2;
    // A step curve: bytes arrive at a sample, flat until the next one.
    let path = `M ${x(0)} ${y(0)}`;
    let prev = points[0];
    for (const p of points) {
      path += ` L ${x(p.ms)} ${y(prev.bytes)} L ${x(p.ms)} ${y(p.bytes)}`;
      prev = p;
    }
    const streaming = Math.max(last.ms - first.ms, 1);
    return { points, first, last, stalls, path, x, rate: (last.bytes / streaming) * 1000 };
  }, [timing]);

  if (!view) return null;
  const { first, last, stalls, path, x, rate } = view;

  return (
    <div className="response-timeline">
      <div className="response-timeline__stats">
        <span>首字节 {seconds(first.ms)}</span>
        <span>结束 {seconds(last.ms)}</span>
        <span>
          共 {formatBytes(last.bytes)}，平均 {formatBytes(rate)}/s
        </span>
        {stalls.length > 0 ? (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            最长停顿 {seconds(stalls[0].to - stalls[0].from)}（第 {seconds(stalls[0].from)} 起）
            {stalls.length > 1 && `，共 ${stalls.length} 处超过 ${seconds(STALL_MS)}`}
          </Typography.Text>
        ) : (
          <span className="text-muted">没有超过 {seconds(STALL_MS)} 的停顿</span>
        )}
      </div>
      <svg
        className="response-timeline__chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`响应字节随时间累计：首字节 ${seconds(first.ms)}，结束 ${seconds(last.ms)}`}
      >
        {/* Waiting for the first byte, then the stalls. */}
        <rect className="response-timeline__wait" x={0} y={0} width={x(first.ms)} height={H} />
        {stalls.map((stall) => (
          <rect
            key={stall.from}
            className="response-timeline__stall"
            x={x(stall.from)}
            y={0}
            width={Math.max(x(stall.to) - x(stall.from), 1)}
            height={H}
          />
        ))}
        <path className="response-timeline__curve" d={path} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="response-timeline__axis">
        <span>0 s</span>
        <span>{seconds(last.ms)}</span>
      </div>
    </div>
  );
}

export default memo(ResponseTimeline);
