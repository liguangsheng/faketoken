import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  App,
  Badge,
  Button,
  DatePicker,
  Drawer,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ApiOutlined,
  ClockCircleOutlined,
  FieldTimeOutlined,
  KeyOutlined,
  LoadingOutlined,
  NumberOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  StopOutlined,
  UserOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

import {
  api,
  type Page,
  type RequestLog,
  type RequestLogDetail,
} from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useLiveRate } from "../../hooks/useLiveRate";
import { useLogStream } from "../../hooks/useLogStream";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  useTableScrollX,
  type TableGeometry,
} from "../../hooks/useTableScrollX";
import { useSettings } from "../../settings/SettingsContext";
import EmptyState from "../EmptyState";
import RateCard from "../RateCard";
import LogBody from "./LogBody";
import LogMeta from "./LogMeta";
import { useLiveRowAnimation } from "./useLiveRowAnimation";
import {
  isLive,
  rowKeyOf,
  useInflightCalls,
  type LogRow,
} from "./useInflightCalls";
import { REASONING_TONE, rowTone } from "./tone";
import {
  formatCompact,
  formatDuration,
  formatNumber,
  formatTime,
  formatTimeShort,
  formatUSD,
} from "../../utils/format";

type RangeValue = [Dayjs | null, Dayjs | null] | null;

interface Props {
  admin?: boolean;
  fetcher: (params: Record<string, unknown>) => Promise<Page<RequestLog>>;
  extra?: ReactNode;
  /** Show a live RPM/TPM pulse bar above the table (admin first-page only). */
  showRate?: boolean;
  /** Bump to force a data reload without remounting (filters survive). */
  reloadToken?: number;
}

// Past this, a call that is still running is worth a second look rather than
// just being slow. Deliberately generous: a long agentic completion legitimately
// runs this long, so it colours the number instead of flagging an error.
const SLOW_CALL_MS = 60_000;

// A stable empty list, so the table memo does not recompute on every render
// when nothing live is being drawn.
const EMPTY_ROWS: LogRow[] = [];

// The card's left stripe reads pass/fail down a phone list without parsing any
// number. Maps the same tone the status tag uses to a card modifier class.
const cardTone = (row: LogRow): string => {
  if (isLive(row)) return "live";
  const tone = rowTone(row);
  return tone === "green" ? "ok" : tone === "orange" ? "warn" : "err";
};

/**
 * A log is read to find out what happened and when, so the timestamp, the
 * status and the error text hold their place at every width. The model and
 * the channel answer "to whom", which is the next question, not the first.
 *
 * 错误 declares no width and takes whatever is left over; the floor here is
 * what the hand-tuned scroll.x used to leave it (1670 less the 1440 of fixed
 * columns), so a wide window looks exactly as it did before.
 */
/**
 * Column widths and their reveal breakpoints, for the desktop/tablet table.
 * On a phone the table drops to a single full-width column (see phoneColumns),
 * so this geometry only drives the md+ layout and its scroll width.
 */
const COLUMN_GEOMETRY = {
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

export default function LogTable({
  admin,
  fetcher,
  extra,
  showRate,
  reloadToken,
}: Props) {
  const { message } = App.useApp();
  // A Drawer is not clamped to the viewport the way a Modal is.
  const narrow = useMediaQuery("(max-width: 768px)");
  const scrollX = useTableScrollX(COLUMN_GEOMETRY);
  const [rows, setRows] = useState<RequestLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Overlapping fetches race (slow filter query vs fast one); only the newest
  // request may write state.
  const requestSeq = useRef(0);
  // While the pointer is over the table, live arrivals are parked instead of
  // inserted: rows that keep sliding away from the cursor cannot be clicked.
  const hoveringRef = useRef(false);
  const hoverBuffer = useRef<RequestLog[]>([]);
  const [hoverPending, setHoverPending] = useState(0);
  const [page, setPage] = useState(1);
  const { defaultPageSize } = useSettings();
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [keywordInput, setKeywordInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [channelInput, setChannelInput] = useState("");
  const [onlyError, setOnlyError] = useState(false);
  const [range, setRange] = useState<RangeValue>(null);
  const [live, setLive] = useState(true);
  const [detail, setDetail] = useState<RequestLog | null>(null);
  // The bodies live in a separate table with its own retention window, so they
  // are fetched when a row is opened and may legitimately be gone.
  const [bodies, setBodies] = useState<RequestLogDetail | null>(null);
  const [bodiesState, setBodiesState] = useState<
    "idle" | "loading" | "expired" | "failed"
  >("idle");


  // The rate pulse only makes sense on page 1, in the live window, on the
  // admin surface — for a regular user it would reflect their own traffic
  // only and read as a low, useless number.
  const rateActive = Boolean(showRate && admin && page === 1 && live && !range);
  const rate = useLiveRate(rateActive);
  // Why the meter is parked, so a zero never reads as "no traffic".
  const idleHint = live
    ? range
      ? "已选时间范围"
      : "非首页"
    : "实时推送已关闭";
  // Seed whenever the first page finishes loading; the SSE additions pile on
  // top. Not seeded on other pages — the bar is hidden there anyway.
  useEffect(() => {
    if (rateActive) rate.seed(rows);
    // rows is intentional: re-seed on every load. rate.seed is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateActive, rows]);

  const openDetail = (row: RequestLog) => {
    setDetail(row);
    setBodies(null);
    // Only the administrator surface serves them; asking as a regular user
    // would just draw a 403.
    if (!admin) {
      setBodiesState("idle");
      return;
    }
    setBodiesState("loading");
    api.admin
      .logDetail(row.id)
      .then((result) => {
        setBodies(result);
        setBodiesState("idle");
      })
      .catch((error: unknown) => {
        // 410 is the ordinary outcome for anything past the window, so it is
        // reported as a state rather than as an error.
        const gone =
          error instanceof Error && error.message.includes("保留范围");
        setBodiesState(gone ? "expired" : "failed");
      });
  };

  const keyword = useDebouncedValue(keywordInput);
  const model = useDebouncedValue(modelInput);
  const tokenName = useDebouncedValue(tokenInput);
  const username = useDebouncedValue(usernameInput);
  const channelID = useDebouncedValue(channelInput);

  // Any filter change invalidates the current page number.
  useEffect(() => {
    setPage(1);
  }, [keyword, model, tokenName, username, channelID, onlyError, range]);

  // silent: refresh the data without the table-wide loading veil — used by
  // stream reconnects, where a periodic grey flash reads as something broken.
  const load = useCallback(
    async (silent = false) => {
      const seq = ++requestSeq.current;
      if (!silent) setLoading(true);
      try {
        const result = await fetcher({
          page,
          page_size: pageSize,
          keyword: keyword || undefined,
          model: model || undefined,
          token_name: tokenName || undefined,
          username: admin && username ? username : undefined,
          // The backend has always supported this filter; now that the table
          // shows ids, it is finally useful.
          channel_id: Number(channelID) > 0 ? Number(channelID) : undefined,
          only_error: onlyError || undefined,
          start: range?.[0]?.toISOString(),
          end: range?.[1]?.toISOString(),
        });
        if (seq !== requestSeq.current) return;
        const data = result.data ?? [];
        // Anything parked during a hover is part of the truth just fetched;
        // flushing it later would push stale rows into the fresh page.
        hoverBuffer.current = [];
        setHoverPending(0);
        setRows(data);
        setTotal(result.total);
        setLoadError(null);
        // A purge (or anything else shrinking the data) can strand a deep page
        // number pointing past the end; walk back to the last real page.
        if (data.length === 0 && result.total > 0 && page > 1) {
          setPage(Math.max(1, Math.ceil(result.total / pageSize)));
        }
      } catch (error) {
        if (seq !== requestSeq.current) return;
        const text = error instanceof Error ? error.message : "加载失败";
        // Both surfaces on purpose: the empty-state branch is invisible while
        // stale rows are still on screen, and the toast alone evaporates.
        setLoadError(text);
        message.error(text);
      } finally {
        if (!silent && seq === requestSeq.current) setLoading(false);
      }
    },
    [
      admin,
      channelID,
      fetcher,
      keyword,
      message,
      model,
      onlyError,
      page,
      pageSize,
      range,
      tokenName,
      username,
    ],
  );

  useEffect(() => {
    void load();
    // reloadToken is an external "data changed" signal (e.g. after purge).
  }, [load, reloadToken]);

  // The stream carries the same filters as the list, so what arrives live is
  // what a reload would show. A time range is the exception: it bounds history,
  // while the feed is always "now".
  const streamURL = useMemo(() => {
    const params = new URLSearchParams();
    // Carried into the feed too, so a live row appears only when it matches
    // what is on screen.
    if (keyword) params.set("keyword", keyword);
    if (model) params.set("model", model);
    if (tokenName) params.set("token_name", tokenName);
    if (admin && username) params.set("username", username);
    if (Number(channelID) > 0) params.set("channel_id", channelID);
    if (onlyError) params.set("only_error", "true");
    const query = params.toString();
    return `${admin ? "/api/admin/logs/stream" : "/api/logs/stream"}${query ? `?${query}` : ""}`;
  }, [admin, channelID, keyword, model, onlyError, tokenName, username]);

  // Live only makes sense on the first page of a "newest first" list: on any
  // other page every arrival would shift the rows the user is reading. Nothing
  // is lost — the counter says how many piled up, and page 1 is one click away.
  const canStream = live && page === 1 && !range;
  const streamEnabled = live && !range;
  // Reserved for the global board. On one account's page nearly every row would
  // flicker through a placeholder without telling anyone anything; here, "what
  // is running right now" is the question the page exists to answer.
  //
  // This gates the drawing only. The set itself is tracked whenever the feed is
  // connected, so stepping to page four and back shows what is running now
  // rather than an empty block waiting on the next announcement.
  const showLive = Boolean(admin) && canStream;
  // The concurrency meter reads the tracked set rather than the drawn rows, so
  // it survives paging away: only a disconnected feed can park it. Declared
  // after streamEnabled because it is derived from it.
  const concurrencyActive = Boolean(admin) && streamEnabled;
  const concurrencyIdleHint = live ? "已选时间范围" : "实时推送已关闭";
  const [pending, setPending] = useState(0);

  // Keys with a cancel in flight. A set rather than a single key because the
  // operator clearing out a stuck upstream presses several in a row, and a
  // shared flag would put every button into the same spinner.
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());

  const cancelCall = useCallback(
    async (key: string) => {
      setCancelling((current) => new Set(current).add(key));
      try {
        await api.admin.cancelInflight(key);
        // "发出" rather than "已取消": the row settles when the request
        // goroutine unwinds, which is the event worth believing.
        message.success("已发出取消");
      } catch (error) {
        const text = error instanceof Error ? error.message : "取消失败";
        // Losing the race with a call that finished on its own is the ordinary
        // outcome of pressing cancel late, not a fault to alarm anyone with.
        if (text.includes("已经结束")) message.info(text);
        else message.error(text);
      } finally {
        setCancelling((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [message],
  );

  // The set of calls the server says are running. Tracked whenever the feed
  // is connected; drawn only where showLive says so.
  const inflight = useInflightCalls({
    enabled: Boolean(admin),
    hoveringRef,
    // A first sighting inserts a row, so the layout is snapshotted before it
    // lands — but only where the row will actually be drawn.
    onFirstSighting: (key) => {
      if (showLive) captureLiveLayout(`live:${key}`);
    },
  });
  // Announced calls and settled arrivals both push the list down; both are
  // named so the shift is measured after either commit.
  const {
    tableRef: liveTableRoot,
    enteringRowIDs,
    capture: captureLiveLayout,
    enter: animateLiveRow,
  } = useLiveRowAnimation(Boolean(admin), [rows, inflight.liveCalls]);

  const flushHoverBuffer = useCallback(() => {
    inflight.publish();
    const buffered = hoverBuffer.current;
    if (!buffered.length) return;
    hoverBuffer.current = [];
    setHoverPending(0);
    // Live entries only belong at the top of the first page; anywhere else
    // they would displace historical rows.
    if (page !== 1) return;
    setRows((current) => {
      let next = current;
      for (const entry of buffered) {
        if (!next.some((row) => row.id === entry.id)) next = [entry, ...next];
      }
      return next.slice(0, pageSize);
    });
  }, [inflight.publish, page, pageSize]);

  const streamState = useLogStream({
    url: streamURL,
    enabled: streamEnabled,
    onInflight: ({ key, entry }) => inflight.announce(key, entry),
    onInflightSync: inflight.sync,
    onEntry: (entry, key) => {
      // Retire the placeholder first, and on every page: the settled row is the
      // same call, and listing it twice is the one outcome worth ruling out.
      if (key) inflight.retire(key);
      if (page !== 1) {
        setPending((count) => count + 1);
        return;
      }
      setTotal((count) => count + 1);
      rate.add(entry);
      if (admin && hoveringRef.current) {
        if (!hoverBuffer.current.some((row) => row.id === entry.id)) {
          hoverBuffer.current.push(entry);
          setHoverPending(hoverBuffer.current.length);
        }
        return;
      }
      captureLiveLayout(String(entry.id));
      animateLiveRow(entry.id);
      setRows((current) => {
        // The list request may already have returned this row; the stream and
        // the initial fetch race by design.
        if (current.some((row) => row.id === entry.id)) return current;
        return [entry, ...current].slice(0, pageSize);
      });
    },
    onReconnect: () => {
      // The stream dropped and came back; quietly reload the first page to
      // recover entries that were published while the connection was down.
      if (page === 1) void load(true);
      // Whatever was running when the connection dropped may well have finished
      // in the meantime. The reconnect is answered with a fresh set, so drop
      // the stale one rather than waiting for it to be reconciled away.
      inflight.reset();
    },
  });

  // Returning to the first page adopts whatever accumulated while away.
  useEffect(() => {
    if (page === 1 && pending > 0) {
      setPending(0);
      void load();
    }
  }, [load, page, pending]);

  // A new stream is a new set: the filters it was opened with decide what gets
  // announced, so rows admitted by the previous ones are no longer news. The
  // server states whatever is still running as soon as the feed connects.
  //
  // Keyed to the feed rather than to the page, so paging away and back keeps
  // the set that is still on the wire.
  useEffect(() => {
    inflight.reset();
  }, [inflight.reset, streamURL, streamEnabled]);

  // Drawn only where showLive says so; the set itself is tracked regardless.
  const liveRows = showLive ? inflight.liveRows : EMPTY_ROWS;
  const hasLive = liveRows.length > 0;
  const { liveCalls } = inflight;

  // A running call's only moving part is how long it has been running, so the
  // clock ticks for as long as one is on screen and stops when none is.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLive]);

  // Live rows sit above the newest settled row, and the page is trimmed back to
  // the size the operator chose: a burst of traffic pushes history down instead
  // of growing the table past its own pagination.
  const tableRows = useMemo<LogRow[]>(
    () => (hasLive ? [...liveRows, ...rows].slice(0, pageSize) : rows),
    [hasLive, liveRows, pageSize, rows],
  );

  const dirty = Boolean(
    keywordInput ||
      modelInput ||
      tokenInput ||
      usernameInput ||
      channelInput ||
      onlyError ||
      range,
  );

  const presets = useMemo(
    () => [
      {
        label: "最近 1 小时",
        value: [dayjs().subtract(1, "hour"), dayjs()] as [Dayjs, Dayjs],
      },
      {
        label: "今天",
        value: [dayjs().startOf("day"), dayjs()] as [Dayjs, Dayjs],
      },
      {
        label: "最近 7 天",
        value: [dayjs().subtract(7, "day"), dayjs()] as [Dayjs, Dayjs],
      },
      {
        label: "最近 30 天",
        value: [dayjs().subtract(30, "day"), dayjs()] as [Dayjs, Dayjs],
      },
    ],
    [],
  );

  // The toggle belongs next to the meters it governs, but those only render on
  // the admin board; elsewhere it falls back into the filter row.
  const liveToggle = (
    <Tooltip
      title={
        range
          ? "选择了时间范围，实时推送已暂停"
          : "由服务端推送新记录，无需轮询"
      }
    >
      {/* The label element makes the caption part of the toggle's hit area. */}
      <label
        style={{
          alignItems: "center",
          cursor: range ? "not-allowed" : "pointer",
          display: "inline-flex",
        }}
      >
        <Space size={6}>
          <Switch
            size="small"
            checked={live}
            disabled={Boolean(range)}
            aria-label="实时推送"
            onChange={(value) => {
              setLive(value);
              // Re-enabling reconnects a fresh stream, which cannot know
              // what it missed; reload the first page to close the gap.
              if (value && page === 1) void load();
            }}
          />
          <Badge
            status={
              !live || range
                ? "default"
                : streamState === "live"
                  ? "processing"
                  : streamState === "connecting"
                    ? "warning"
                    : "error"
            }
            text={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {!live || range
                  ? "实时推送"
                  : streamState === "live"
                    ? canStream
                      ? "实时推送中"
                      : "已暂停（非首页）"
                    : streamState === "connecting"
                      ? "连接中…"
                      : "已断开，重试中"}
              </Typography.Text>
            }
          />
        </Space>
      </label>
    </Tooltip>
  );

  // On a phone a horizontally scrolling table can only ever show a slice of a
  // row at once. Collapse it instead to one full-width column whose cell packs
  // every field a log is read for — model, status, cost, timing, tokens,
  // channel, error — into a compact card. Nothing is hidden behind a swipe.
  const phoneColumns = [
    {
      title: "调用记录",
      key: "row",
      render: (_: unknown, row: LogRow) => {
        const live = isLive(row);
        const mapped = row.upstream_model && row.upstream_model !== row.model;
        const elapsed = live
          ? Math.max(0, now - new Date(row.created_at).getTime())
          : 0;
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
                <Tag color={rowTone(row)} style={{ marginInlineEnd: 0 }}>
                  {row.status_code}
                </Tag>
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
                  {live
                    ? formatDuration(elapsed)
                    : formatDuration(row.duration_ms)}
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
                    #{row.channel_id}
                    {row.channel_name ? ` ${row.channel_name}` : ""}
                  </span>
                </span>
              )}
              <span className="log-card__meta-item log-card__meta-item--wide">
                <KeyOutlined />
                <span className="log-card__meta-text">
                  {admin && row.username ? `${row.username} · ` : ""}
                  {row.token_name || "-"}
                </span>
              </span>
            </div>

            {row.error && (
              <div className="log-card__error">{row.error}</div>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      {showRate && admin && (
        <Space size={8} style={{ marginBottom: 12 }}>
          <RateCard
            label="RPM"
            value={rate.rpm}
            active={rateActive}
            idleHint={idleHint}
          />
          <RateCard
            label="TPM"
            value={rate.tpm}
            format={formatCompact}
            active={rateActive}
            idleHint={idleHint}
          />
          {/* Not a sample of the page like the two beside it: the feed states
              the whole running set, so this stays right on page four, where a
              meter drawn from the visible rows cannot. Hence its own active
              condition — the feed being connected, not the first page. */}
          <RateCard
            label="并发"
            value={liveCalls.size}
            active={concurrencyActive}
            idleHint={concurrencyIdleHint}
            activeHint="此刻已转发给上游、尚未结束的调用数 · 跟随筛选条件"
          />
          {liveToggle}
        </Space>
      )}
      <Space wrap className="filter-bar" style={{ marginBottom: 12 }} size={8}>
        <Input
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder={
            admin
              ? "搜索 ID、用户、密钥、模型、渠道、IP、错误"
              : "搜索 ID、密钥、模型、接口、错误"
          }
          aria-label="搜索日志"
          style={{ width: 300 }}
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        {/* Prefix icons keep the filters tellable-apart once they hold text
            and the placeholder is gone. */}
        <Input
          allowClear
          prefix={<RobotOutlined className="text-muted" />}
          placeholder="模型"
          aria-label="按模型过滤"
          style={{ width: 160 }}
          value={modelInput}
          onChange={(event) => setModelInput(event.target.value)}
        />
        <Input
          allowClear
          prefix={<KeyOutlined className="text-muted" />}
          placeholder="令牌"
          aria-label="按令牌名过滤"
          style={{ width: 140 }}
          value={tokenInput}
          onChange={(event) => setTokenInput(event.target.value)}
        />
        {admin && (
          <Input
            allowClear
            prefix={<UserOutlined className="text-muted" />}
            placeholder="用户名"
            aria-label="按用户名过滤"
            style={{ width: 150 }}
            value={usernameInput}
            onChange={(event) => setUsernameInput(event.target.value)}
          />
        )}
        <Input
          allowClear
          prefix={<span className="text-muted">#</span>}
          placeholder="渠道 ID"
          aria-label="按渠道 ID 过滤，仅支持数字"
          style={{ width: 110 }}
          value={channelInput}
          onChange={(event) =>
            setChannelInput(event.target.value.replace(/\D/g, ""))
          }
        />
        <Select
          value={onlyError}
          style={{ width: 110 }}
          aria-label="按结果过滤"
          onChange={setOnlyError}
          options={[
            { value: false, label: "全部请求" },
            { value: true, label: "仅失败" },
          ]}
        />
        <DatePicker.RangePicker
          showTime={{ format: "HH:mm" }}
          format="MM-DD HH:mm"
          value={range}
          presets={presets}
          onChange={(value) => setRange(value as RangeValue)}
          style={{ width: 300 }}
        />
        {dirty && (
          <Button
            type="link"
            onClick={() => {
              setKeywordInput("");
              setModelInput("");
              setTokenInput("");
              setUsernameInput("");
              setChannelInput("");
              setOnlyError(false);
              setRange(null);
            }}
          >
            重置
          </Button>
        )}
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load()}
        >
          刷新
        </Button>
        {!(showRate && admin) && liveToggle}
        {pending > 0 && (
          <Button type="link" size="small" onClick={() => setPage(1)}>
            有 {pending} 条新记录
          </Button>
        )}
        {hoverPending > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hoverPending} 条新记录待插入（悬停时暂停）
          </Typography.Text>
        )}
        {extra}
      </Space>

      <div
        // Pointer events, filtered to mice: a touch tap synthesizes mouseenter
        // with no matching leave, which would park the stream forever.
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") hoveringRef.current = true;
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse") return;
          hoveringRef.current = false;
          flushHoverBuffer();
        }}
      >
        <Table
          ref={liveTableRoot}
          rowKey={rowKeyOf}
          size="small"
          className={`table-clickable${admin ? " log-table--live" : ""}${narrow ? " log-table--phone" : ""}`}
          loading={loading}
          dataSource={tableRows}
          rowClassName={(row) =>
            isLive(row)
              ? "log-row--running"
              : enteringRowIDs.has(row.id)
                ? "log-row--enter"
                : ""
          }
          scroll={narrow ? undefined : { x: scrollX }}
          onRow={(row) => {
            // A call that has not finished has no stored exchange to read, so
            // it is not a click target: the drawer would open on nothing.
            if (isLive(row)) return {};
            return {
            onClick: (event) => {
              // A drag-select also emits a click on the row in some browsers.
              // Only suppress that click when the active selection touches this
              // row, so a selection elsewhere on the page never blocks a normal
              // single-click open.
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed) {
                const rowElement = event.currentTarget;
                const touchesRow = [
                  selection.anchorNode,
                  selection.focusNode,
                ].some((node) => node !== null && rowElement.contains(node));
                if (touchesRow) return;
              }
              openDetail(row);
            },
            // Rows are the only way into the detail drawer, so they must be
            // reachable without a mouse.
            tabIndex: 0,
            "aria-label": `查看调用 #${row.id} 详情`,
            onKeyDown: (event) => {
              if (event.key === "Enter") openDetail(row);
            },
            };
          }}
          locale={{
            emptyText: loadError ? (
              <EmptyState
                title="加载失败"
                description={loadError}
                action={
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={() => void load()}
                  >
                    重试
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="没有匹配的调用记录"
                description={
                  dirty
                    ? "试试放宽筛选条件或时间范围。"
                    : "发起一次请求后这里就会有记录。"
                }
              />
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${formatNumber(count)} 条`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          columns={narrow ? phoneColumns : [
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
                      {isLive(row) ? "在途" : `#${row.id}`}
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
                id > 0 ? (
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
              render: (tokenName: string, row: RequestLog) => (
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
                      {mapped ? (
                        <span className="mono text-muted cell-stack__sub cell-stack__clip">
                          → {row.upstream_model}
                        </span>
                      ) : admin ? null : (
                        <span className="text-muted cell-stack__sub">
                          未映射
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
            {
              ...COLUMN_GEOMETRY.clientIP,
              title: "来源 IP",
              dataIndex: "client_ip",
              ellipsis: true,
              render: (value: string) =>
                value ? (
                  <Tooltip title={value}>
                    <span className="mono">{value}</span>
                  </Tooltip>
                ) : (
                  <span className="text-muted">-</span>
                ),
            },
            {
              ...COLUMN_GEOMETRY.status,
              title: "状态",
              dataIndex: "status_code",
              render: (code: number, row: LogRow) => (
                <Space size={4}>
                  {isLive(row) ? (
                    <Tooltip title="已转发给上游，还在等待回应">
                      <Tag color="processing" icon={<LoadingOutlined />}>
                        进行中
                      </Tag>
                    </Tooltip>
                  ) : (
                  <Tooltip
                    title={
                      row.error && code < 400
                        ? "上游返回 200，但响应体中带有错误"
                        : undefined
                    }
                  >
                    <Tag color={rowTone(row)}>{code}</Tag>
                  </Tooltip>
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
                  const elapsed = Math.max(
                    0,
                    now - new Date(row.created_at).getTime(),
                  );
                  return (
                    <Tooltip title={`已运行 ${formatDuration(elapsed)}`}>
                      <div className="duration-cell">
                        <span className="duration-bar duration-bar--running" aria-hidden />
                        <div className="cell-stack">
                          <span
                            className="mono"
                            style={
                              elapsed >= SLOW_CALL_MS
                                ? { color: "var(--app-warning)" }
                                : undefined
                            }
                          >
                            {formatDuration(elapsed)}
                          </span>
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
                <Tooltip title="Tokens：↑ 输入 · ↓ 输出，合计悬停单元格可见">
                  <span>Tokens</span>
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
                    <span style={{ color: "var(--app-danger)" }}>{value}</span>
                  </Tooltip>
                ) : (
                  <span className="text-muted">-</span>
                ),
            },
          ]}
        />
      </div>

      <Drawer
        className="detail-drawer"
        open={Boolean(detail)}
        // Wider than the metadata alone needs: request bodies are the reason
        // this drawer is opened, and they read badly in a narrow column.
        // min() guards the 769–860px window, where a fixed 860 overflows.
        width={
          narrow ? "100%" : admin ? "min(860px, 100vw)" : "min(560px, 100vw)"
        }
        title={
          detail ? (
            <Space size={8}>
              <span>调用详情 #{detail.id}</span>
              <Tag color={rowTone(detail)} style={{ marginInlineEnd: 0 }}>
                {detail.status_code}
              </Tag>
            </Space>
          ) : (
            "调用详情"
          )
        }
        onClose={() => setDetail(null)}
      >
        {detail && admin && (
          <Tabs
            style={{ marginBottom: 16 }}
            items={[
              { key: "meta", label: "概览" },
              { key: "request", label: "请求正文" },
              { key: "response", label: "响应正文" },
            ].map((tab) => ({
              ...tab,
              children:
                tab.key === "meta" ? (
                  <LogMeta detail={detail} admin={admin} />
                ) : (
                  <LogBody
                    kind={tab.key === "request" ? "request" : "response"}
                    state={bodiesState}
                    bodies={bodies}
                    entry={detail}
                  />
                ),
            }))}
          />
        )}
        {detail && !admin && <LogMeta detail={detail} admin={admin} />}
      </Drawer>
    </>
  );
}
