import {
  Button,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
} from "antd";
import type { TableProps } from "antd";
import {
  ApiOutlined,
  ClockCircleOutlined,
  FieldTimeOutlined,
  KeyOutlined,
  LoadingOutlined,
  NumberOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { RequestLog } from "../../api/types";
import {
  formatCompact,
  formatDuration,
  formatNumber,
  formatTime,
  formatTimeShort,
  formatUSD,
} from "../../utils/format";
import type { TableGeometry } from "../../hooks/useTableScrollX";
import Elapsed from "./Elapsed";
import StatusTag from "./StatusTag";
import { isLive, type LogRow } from "./useInflightCalls";
import { REASONING_TONE, rowTone } from "./tone";

// Past this, a call that is still running is worth a second look rather than
// just being slow. Deliberately generous: a long agentic completion legitimately
// runs this long, so it colours the number instead of flagging an error.
const SLOW_CALL_MS = 60_000;

// The card's left stripe reads pass/fail down a phone list without parsing any
// number. Maps the same tone the status tag uses to a card modifier class.
const cardTone = (row: LogRow): string => {
  if (isLive(row)) return "live";
  const tone = rowTone(row);
  return tone === "green" ? "ok" : tone === "red" ? "err" : "warn";
};

/**
 * Column widths and their reveal breakpoints, for the desktop/tablet table.
 * On a phone the table drops to a single full-width column (see phoneColumns),
 * so this geometry only drives the md+ layout and its scroll width.
 */
export const COLUMN_GEOMETRY = {
  createdAt: { width: 150 },
  // Sized for the widest run of tags the cell can hold at once:
  // "进行中" (icon + 3 characters) · "流" · "×3". The in-flight tag is the
  // long one and it co-occurs with the other two — a streaming call that
  // switched channels shows all three while it is still running.
  status: { width: 172 },
  error: { flexMin: 230 },
  model: { width: 210, responsive: ["md"] },
  channel: { width: 140, responsive: ["md"] },
  duration: { width: 120, responsive: ["md"] },
  cost: { width: 100, responsive: ["md"] },
  token: { width: 130, responsive: ["lg"] },
  client: { width: 110, responsive: ["lg"] },
  // Two compact numbers stacked ("↑1.2M" over "↓845"), so the header is the
  // widest thing in the column. The slack goes to status and to the error
  // text, which is the column that actually runs out of room.
  tokens: { width: 80, responsive: ["lg"] },
  reasoning: { width: 110, responsive: ["xl"] },
  clientIP: { width: 130, responsive: ["xl"] },
} satisfies TableGeometry;

// An account's own view has no source address (the server withholds it), so
// its scroll width must not reserve that column either.
export const OWNER_GEOMETRY: TableGeometry = Object.fromEntries(
  Object.entries(COLUMN_GEOMETRY).filter(([name]) => name !== "clientIP"),
);

interface DesktopDeps {
  admin?: boolean;
  /** Keys with a cancel in flight. */
  cancelling: ReadonlySet<string>;
  cancelCall: (key: string) => void;
  /** 隐私模式：渠道、用户/密钥、来源 IP 三列只显示占位符。 */
  redacted?: boolean;
}

/**
 * A log is read to find out what happened and when, so the timestamp, the
 * status and the error text hold their place at every width. The model and
 * the channel answer "to whom", which is the next question, not the first.
 *
 * 错误 declares no width and takes whatever is left over; the floor here is
 * what the hand-tuned scroll.x used to leave it (1670 less the 1440 of fixed
 * columns), so a wide window looks exactly as it did before.
 */
export function logColumns({
  admin,
  cancelling,
  cancelCall,
  redacted,
}: DesktopDeps): TableProps<LogRow>["columns"] {
  return [
    {
      // The id identifies the row and the timestamp places it; they are
      // read together and neither needs a column of its own.
      //
      // Absolute time, not relative: a log is read to line events up
      // against an incident, and "3 分钟前" cannot be compared with
      // anything.
      ...COLUMN_GEOMETRY.createdAt,
      title: "时间 / ID",
      dataIndex: "created_at",
      render: (value: string, row: LogRow) => (
        <Tooltip
          title={
            isLive(row)
              ? `开始于 ${formatTime(value)}，尚未结束`
              : formatTime(value)
          }
        >
          <div className="cell-stack">
            <span className="mono">{formatTimeShort(value)}</span>
            {/* A running call has no id yet — the row number is minted
                by the database when the call settles. */}
            <span className="mono text-muted cell-stack__sub">
              {isLive(row) ? "进行中" : `#${row.id}`}
            </span>
          </div>
        </Tooltip>
      ),
    },
    {
      // Id above (stable, matches other admin surfaces), name below —
      // reading traffic distribution should not require hovering every
      // row to learn which upstream #12 is.
      ...COLUMN_GEOMETRY.channel,
      title: "渠道",
      dataIndex: "channel_id",
      render: (id: number, row: RequestLog) =>
        // 隐私模式保留列宽与可读性，只抹掉渠道身份。
        redacted ? (
          <span className="text-muted">•••</span>
        ) : id > 0 ? (
          <div className="cell-stack" style={{ minWidth: 0 }}>
            <span>
              <Tag className="mono" style={{ marginInlineEnd: 0 }}>
                #{id}
              </Tag>
            </span>
            {row.channel_name && (
              <Tooltip title={row.channel_name}>
                <span
                  className="text-muted cell-stack__sub"
                  style={{
                    maxWidth: 120,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {row.channel_name}
                </span>
              </Tooltip>
            )}
          </div>
        ) : (
          <span className="text-muted">-</span>
        ),
    },
    {
      // Who called, and with which of their keys. On the user's own page
      // the account is implied, so only the key is worth the space.
      ...COLUMN_GEOMETRY.token,
      title: admin ? "用户 / 密钥" : "密钥",
      dataIndex: "token_name",
      render: (tokenName: string, row: RequestLog) =>
        redacted ? (
          <span className="text-muted">•••</span>
        ) : (
          <div className="cell-stack">
            {admin && <span>{row.username || "-"}</span>}
            <span
              className={admin ? "text-muted cell-stack__sub" : undefined}
            >
              {tokenName || "-"}
            </span>
          </div>
        ),
    },
    {
      ...COLUMN_GEOMETRY.client,
      title: "客户端",
      dataIndex: "client_type",
      ellipsis: true,
      render: (type: string) =>
        type && type !== "unknown" ? (
          <Tag>{type}</Tag>
        ) : (
          <span className="text-muted">未知</span>
        ),
    },
    {
      // A mapped model puts the requested name on top and the forwarded
      // one under it. Collapsing the two into one name hides the rewrite,
      // which is exactly the thing you are looking for when a model
      // behaves unlike its name; side by side on one line, the pair also
      // truncated exactly where it mattered on the busy admin table.
      // Only the administrator's rows carry the forwarded name.
      ...COLUMN_GEOMETRY.model,
      title: "模型",
      dataIndex: "model",
      render: (value: string, row: RequestLog) => {
        const mapped =
          row.upstream_model && row.upstream_model !== value;
        return (
          <Tooltip
            title={
              mapped
                ? `客户端请求 ${value}，实际转发 ${row.upstream_model}`
                : value
            }
          >
            {/* nowrap is deliberate: a model name broken across lines
              cannot be compared against its neighbours at a glance. */}
            <div className="cell-stack" style={{ minWidth: 0 }}>
              <span className="mono cell-stack__clip">{value}</span>
              {mapped && (
                <span className="mono text-muted cell-stack__sub cell-stack__clip">
                  → {row.upstream_model}
                </span>
              )}
            </div>
          </Tooltip>
        );
      },
    },
    {
      ...COLUMN_GEOMETRY.reasoning,
      title: "思考强度",
      dataIndex: "reasoning_effort",
      render: (value: string) =>
        value ? (
          <Tag
            color={REASONING_TONE[value] ?? "default"}
            style={{ marginInlineEnd: 0 }}
          >
            {value}
          </Tag>
        ) : admin ? null : (
          <span className="text-muted">未指定</span>
        ),
    },
    ...(admin
      ? [
          {
            ...COLUMN_GEOMETRY.clientIP,
            title: "来源 IP",
            dataIndex: "client_ip",
            ellipsis: true,
            render: (value: string) =>
              redacted ? (
                <span className="text-muted">•••</span>
              ) : value ? (
                <Tooltip title={value}>
                  <span className="mono">{value}</span>
                </Tooltip>
              ) : (
                <span className="text-muted">-</span>
              ),
          },
        ]
      : []),
    {
      ...COLUMN_GEOMETRY.status,
      title: "状态",
      dataIndex: "status_code",
      render: (_code: number, row: LogRow) => (
        <Space size={4}>
          {isLive(row) ? (
            <Tooltip title="已转发给上游，还在等待回应">
              <Tag color="processing" icon={<LoadingOutlined />}>
                进行中
              </Tag>
            </Tooltip>
          ) : (
          <StatusTag
            status={row.status_code}
            upstream={row.upstream_status}
            error={row.error}
            cancelled={row.cancelled}
          />
          )}
          {/* Streaming used to be its own column; it is one bit, so it
            rides along with the status it qualifies. */}
          {row.stream && (
            <Tooltip title="流式响应">
              <Tag color="blue">流</Tag>
            </Tooltip>
          )}
          {row.retries > 0 && (
            <Tooltip
              title={`共尝试 ${row.retries + 1} 次（切换 ${row.retries} 次渠道）`}
            >
              <Tag color="gold">×{row.retries + 1}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      // Total above, first-byte below, with a vertical progress bar that
      // fills with the fraction of time-to-first-byte of the total — the
      // longer the bar, the more the caller waited before anything came
      // back. Clamped to a 30s ceiling so a single slow outlier does
      // not flatten everyone else into a sliver.
      title: (
        <Tooltip title="总耗时 / 首字时间">
          <span>耗时 / 首字</span>
        </Tooltip>
      ),
      ...COLUMN_GEOMETRY.duration,
      dataIndex: "duration_ms",
      align: "left",
      render: (value: number, row: LogRow) => {
        if (isLive(row)) {
          return (
            <Tooltip
              title={
                <>
                  已运行 <Elapsed since={row.created_at} />
                </>
              }
            >
              <div className="duration-cell">
                <span className="duration-bar duration-bar--running" aria-hidden />
                <div className="cell-stack">
                  <Elapsed
                    since={row.created_at}
                    className="mono"
                    warnAfter={SLOW_CALL_MS}
                  />
                  <span className="text-muted cell-stack__sub">…</span>
                </div>
              </div>
            </Tooltip>
          );
        }
        const ratio =
          value > 0 && row.ttfb_ms > 0
            ? Math.min(row.ttfb_ms / value, 1)
            : 0;
        return (
          <Tooltip
            title={
              row.ttfb_ms > 0
                ? `总耗时 ${formatDuration(value)} · 首字 ${formatDuration(row.ttfb_ms)}`
                : `总耗时 ${formatDuration(value)}`
            }
          >
            <div className="duration-cell">
              <span
                className="duration-bar"
                style={{
                  // Brand = waiting for the first byte, neutral = the
                  // stream itself. Warning orange here made every slow
                  // stream look like an incident.
                  background: `linear-gradient(to top, var(--app-brand) ${ratio * 100}%, var(--app-border-strong) ${ratio * 100}%)`,
                }}
                aria-hidden
              />
              <div className="cell-stack">
                <span className="mono">{formatDuration(value)}</span>
                {row.ttfb_ms > 0 ? (
                  <span className="mono text-muted cell-stack__sub">
                    {formatDuration(row.ttfb_ms)}
                  </span>
                ) : (
                  <span className="text-muted cell-stack__sub">-</span>
                )}
              </div>
            </div>
          </Tooltip>
        );
      },
    },
    {
      // Stacked, not side by side: on one line the column had to fit
      // "1.2M→128k" and cost the 错误 column the width it needed more.
      // Stacked, the widest thing in the cell is one compact number, so
      // both directions remain readable without making this column
      // compete with the error text for the table's spare width.
      // ↑ input, ↓ output; the total is their sum and lives in the cell
      // tooltip, with the cache split in the detail drawer.
      ...COLUMN_GEOMETRY.tokens,
      title: (
        <Tooltip title="Token：↑ 输入 · ↓ 输出，合计悬停单元格可见">
          <span>Token</span>
        </Tooltip>
      ),
      align: "right",
      render: (_: unknown, row: LogRow) =>
        // Usage is only known once the upstream has answered, and a
        // running call showing 0 would read as a call that used none.
        isLive(row) ? (
          <span className="text-muted">-</span>
        ) : (
        <Tooltip
          title={`输入 ${formatNumber(row.prompt_tokens)} · 输出 ${formatNumber(
            row.completion_tokens,
          )} · 合计 ${formatNumber(row.total_tokens)}`}
        >
          <div className="cell-stack">
            <span className="mono">
              <span className="text-muted">↑</span>
              {formatCompact(row.prompt_tokens)}
            </span>
            <span className="mono text-muted cell-stack__sub">
              ↓{formatCompact(row.completion_tokens)}
            </span>
          </div>
        </Tooltip>
        ),
    },
    {
      ...COLUMN_GEOMETRY.cost,
      title: "费用",
      dataIndex: "cost",
      align: "right",
      render: (value: number, row: LogRow) =>
        isLive(row) ? (
          <span className="text-muted">-</span>
        ) : (
          formatUSD(value)
        ),
    },
    {
      ...COLUMN_GEOMETRY.error,
      title: "错误",
      dataIndex: "error",
      ellipsis: true,
      // A running call has no error yet, and it is the only kind of row
      // that can still be acted on — so the column that would otherwise
      // show a dash carries the stop button instead of costing the
      // table a whole column that is empty on every settled row.
      render: (value: string, row: LogRow) =>
        isLive(row) ? (
          <Popconfirm
            title="取消这次调用？"
            description="只停掉本网关的等待与转发。上游可能继续生成并照常计费。"
            okText="取消调用"
            okButtonProps={{ danger: true }}
            cancelText="再等等"
            onConfirm={() => cancelCall(row.live_key)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<StopOutlined />}
              loading={cancelling.has(row.live_key)}
            >
              取消
            </Button>
          </Popconfirm>
        ) : value ? (
          <Tooltip title={value}>
            {/* An interrupted call says why it ended; nothing failed. */}
            <span
              style={{
                color: row.cancelled ? "var(--app-text-muted)" : "var(--app-danger)",
              }}
            >
              {value}
            </span>
          </Tooltip>
        ) : (
          <span className="text-muted">-</span>
        ),
    },
  ];
}

/**
 * On a phone a horizontally scrolling table can only ever show a slice of a
 * row at once. Collapse it instead to one full-width column whose cell packs
 * every field a log is read for — model, status, cost, timing, tokens,
 * channel, error — into a compact card. Nothing is hidden behind a swipe.
 */
export function phoneColumns({
  admin,
  redacted,
}: {
  admin?: boolean;
  redacted?: boolean;
}): TableProps<LogRow>["columns"] {
  return [
    {
      title: "调用记录",
      key: "row",
      render: (_: unknown, row: LogRow) => {
        const live = isLive(row);
        const mapped = row.upstream_model && row.upstream_model !== row.model;
        return (
          <div className={`log-card log-card--${cardTone(row)}`}>
            <div className="log-card__top">
              <span className="log-card__model mono">{row.model}</span>
              <span className="log-card__cost mono">
                {live ? "" : formatUSD(row.cost)}
              </span>
            </div>

            {mapped && (
              <div className="log-card__mapped mono text-muted">
                → {row.upstream_model}
              </div>
            )}

            <div className="log-card__tags">
              {live ? (
                <Tag color="processing" icon={<LoadingOutlined />}>
                  进行中
                </Tag>
              ) : (
                <StatusTag
                  status={row.status_code}
                  upstream={row.upstream_status}
                  error={row.error}
                  cancelled={row.cancelled}
                  style={{ marginInlineEnd: 0 }}
                />
              )}
              {row.stream && <Tag color="blue">流</Tag>}
              {row.retries > 0 && <Tag color="gold">×{row.retries + 1}</Tag>}
              {row.reasoning_effort && (
                <Tag color={REASONING_TONE[row.reasoning_effort] ?? "default"}>
                  {row.reasoning_effort}
                </Tag>
              )}
              {row.client_type && row.client_type !== "unknown" && (
                <Tag>{row.client_type}</Tag>
              )}
            </div>

            <div className="log-card__meta">
              <span className="log-card__meta-item">
                <ClockCircleOutlined />
                <span className="log-card__meta-text">
                  {formatTimeShort(row.created_at)}
                </span>
              </span>
              {!live && (
                <span className="log-card__meta-item log-card__meta-item--end">
                  <span className="log-card__meta-text log-card__meta-id">
                    #{row.id}
                  </span>
                </span>
              )}
              <span className="log-card__meta-item">
                <FieldTimeOutlined />
                <span className="log-card__meta-text">
                  {live ? (
                    <Elapsed since={row.created_at} />
                  ) : (
                    formatDuration(row.duration_ms)
                  )}
                </span>
              </span>
              {!live && (
                <span className="log-card__meta-item log-card__meta-item--end">
                  <NumberOutlined />
                  <span className="log-card__meta-text">
                    {formatCompact(row.prompt_tokens)}/
                    {formatCompact(row.completion_tokens)}
                  </span>
                </span>
              )}
              {row.channel_id > 0 && (
                <span className="log-card__meta-item log-card__meta-item--wide">
                  <ApiOutlined />
                  <span className="log-card__meta-text">
                    {redacted
                      ? "•••"
                      : `#${row.channel_id}${row.channel_name ? ` ${row.channel_name}` : ""}`}
                  </span>
                </span>
              )}
              <span className="log-card__meta-item log-card__meta-item--wide">
                <KeyOutlined />
                <span className="log-card__meta-text">
                  {redacted
                    ? "•••"
                    : `${admin && row.username ? `${row.username} · ` : ""}${row.token_name || "-"}`}
                </span>
              </span>
            </div>

            {row.error && (
              <div
                className={`log-card__error${row.cancelled ? " log-card__error--muted" : ""}`}
              >
                {row.error}
              </div>
            )}
          </div>
        );
      },
    },
  ];
}
