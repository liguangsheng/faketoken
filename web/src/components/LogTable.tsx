import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CopyOutlined,
  KeyOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { TableRef } from "antd/es/table";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

import {
  api,
  type Page,
  type RequestLog,
  type RequestLogDetail,
} from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useLiveRate } from "../hooks/useLiveRate";
import { useLogStream } from "../hooks/useLogStream";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  useTableScrollX,
  type TableGeometry,
} from "../hooks/useTableScrollX";
import { useSettings } from "../settings/SettingsContext";
import { copyTextToClipboard } from "../utils/clipboard";
import EmptyState from "./EmptyState";
import RateCard from "./RateCard";
import {
  parseRequestConversation,
  parseResponseConversation,
  type ConversationPart,
  type ConversationTurn,
  type PartKind,
} from "../utils/conversation";
import {
  formatBytes,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
  formatTimeShort,
  formatUSD,
} from "../utils/format";

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

/**
 * A row that is either a settled log entry or a call still in flight.
 *
 * The two share a shape on purpose: an in-flight call is the same record with
 * everything it has not produced yet left at zero, so every column renders it
 * without a parallel set of components. live_key is what tells them apart, and
 * it is also the handle the settled row uses to replace this one.
 */
type LogRow = RequestLog & { live_key?: string };

const isLive = (row: LogRow) => row.live_key !== undefined;

/** Table row key. Live rows have no id yet, so they key off their own handle. */
const rowKeyOf = (row: LogRow) =>
  row.live_key !== undefined ? `live:${row.live_key}` : String(row.id);

// Past this, a call that is still running is worth a second look rather than
// just being slow. Deliberately generous: a long agentic completion legitimately
// runs this long, so it colours the number instead of flagging an error.
const SLOW_CALL_MS = 60_000;

// How many consecutive reconciliations may miss a placeholder before it is
// dropped. One is not enough: a call leaves the server's live set as soon as the
// caller has been answered, a moment before its row is written.
const INFLIGHT_SYNC_GRACE = 2;

const statusTone = (code: number) =>
  code < 400 ? "green" : code < 500 ? "orange" : "red";

// An upstream can answer 200 and then fail inside the body — an SSE stream
// that ends with an error event is the common case. The status code we
// relayed is still the truth, so it is shown unchanged; only the colour
// follows the error field, because a green 200 on a failed call is what
// hides these rows entirely.
const rowTone = (row: { status_code: number; error: string }) =>
  row.error && row.status_code < 400 ? "orange" : statusTone(row.status_code);

// Only the named levels get a colour; a token budget stays neutral because
// "16k tokens" carries no ordering against "high".
const REASONING_TONE: Record<string, string> = {
  minimal: "default",
  low: "blue",
  medium: "gold",
  high: "red",
};

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
 * A log is read to find out what happened and when, so the timestamp, the
 * status and the error text hold their place at every width. The model and
 * the channel answer "to whom", which is the next question, not the first.
 *
 * 错误 declares no width and takes whatever is left over; the floor here is
 * what the hand-tuned scroll.x used to leave it (1670 less the 1440 of fixed
 * columns), so a wide window looks exactly as it did before.
 */
const COLUMN_GEOMETRY = {
  createdAt: { width: 150 },
  status: { width: 140 },
  error: { flexMin: 230 },
  model: { width: 210, responsive: ["md"] },
  channel: { width: 140, responsive: ["md"] },
  duration: { width: 120, responsive: ["md"] },
  cost: { width: 100, responsive: ["md"] },
  token: { width: 130, responsive: ["lg"] },
  client: { width: 110, responsive: ["lg"] },
  tokens: { width: 100, responsive: ["lg"] },
  reasoning: { width: 110, responsive: ["xl"] },
  clientIP: { width: 130, responsive: ["xl"] },
} satisfies TableGeometry;

/** Share of the input that came from cache. Zero input means zero rate. */
const cacheRate = (entry: RequestLog) =>
  entry.prompt_tokens > 0 ? entry.cached_tokens / entry.prompt_tokens : 0;

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
  // Calls the server has announced and not yet settled. The ref is always
  // current; the state is the committed view, which is what lets the hover
  // pause cover placeholders as well as arrivals.
  const [liveCalls, setLiveCalls] = useState<ReadonlyMap<string, LogRow>>(
    () => new Map(),
  );
  const liveRef = useRef<ReadonlyMap<string, LogRow>>(new Map());
  // Per placeholder, how many reconciliations in a row have not mentioned it.
  const missedSyncs = useRef(new Map<string, number>());
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
  const [enteringRowIDs, setEnteringRowIDs] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const enteringRowTimers = useRef(new Map<number, number>());
  const liveTableRoot = useRef<TableRef>(null);
  const pendingLiveLayout = useRef<LiveRowLayout | null>(null);
  const rowShiftAnimations = useRef(new Map<string, Animation>());

  // FLIP starts before React inserts the new record: remember where every
  // visible row is right now. getBoundingClientRect includes any in-flight
  // transform, which lets a busy feed continue smoothly from the exact visual
  // position reached by the previous push.
  const captureLiveLayout = useCallback(
    (rowKey: string) => {
      const root = liveTableRoot.current?.nativeElement;
      if (
        !admin ||
        !root ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        pendingLiveLayout.current = null;
        return;
      }

      const tops = new Map<string, number>();
      root
        .querySelectorAll<HTMLElement>(".ant-table-tbody > tr[data-row-key]")
        .forEach((row) => {
          const key = row.dataset.rowKey;
          if (key) tops.set(key, row.getBoundingClientRect().top);
        });
      pendingLiveLayout.current = { rowKey, tops };
    },
    [admin],
  );

  const animateLiveRow = useCallback(
    (id: number) => {
      // This treatment is intentionally reserved for the high-traffic global
      // feed. Historical loads and the regular user's log page stay still.
      if (!admin) return;

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
    [admin],
  );

  useEffect(
    () => () => {
      enteringRowTimers.current.forEach((timer) => window.clearTimeout(timer));
      enteringRowTimers.current.clear();
      pendingLiveLayout.current = null;
      const animations = [...rowShiftAnimations.current.values()];
      rowShiftAnimations.current.clear();
      animations.forEach((animation) => animation.cancel());
    },
    [],
  );

  // React has committed the new table layout, but the browser has not painted
  // it yet. Move every old row back to its captured position, then animate to
  // the new one. Visually, the incoming row now pushes the whole list down.
  useLayoutEffect(() => {
    const snapshot = pendingLiveLayout.current;
    const root = liveTableRoot.current?.nativeElement;
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
    pendingLiveLayout.current = null;

    // Cancel after capturing the old visual positions, so the next delta is
    // measured against each row's clean, final layout position.
    const previousAnimations = [...rowShiftAnimations.current.values()];
    rowShiftAnimations.current.clear();
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
      rowShiftAnimations.current.set(key, animation);

      const release = () => {
        if (rowShiftAnimations.current.get(key) === animation) {
          rowShiftAnimations.current.delete(key);
        }
      };
      animation.onfinish = release;
      animation.oncancel = release;
    });
    // liveCalls belongs here with rows: a call announced as running inserts a
    // row of its own, and that push has to be absorbed the same way.
  }, [enteringRowIDs, rows, liveCalls]);

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
  const [pending, setPending] = useState(0);

  // Live rows are held in a ref and published to state only when the pointer is
  // away, for the same reason arrivals are parked.
  const commitLive = useCallback((next: ReadonlyMap<string, LogRow>) => {
    liveRef.current = next;
    if (!hoveringRef.current) setLiveCalls(next);
  }, []);

  const flushHoverBuffer = useCallback(() => {
    setLiveCalls((current) =>
      current === liveRef.current ? current : liveRef.current,
    );
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
  }, [page, pageSize]);

  const streamState = useLogStream({
    url: streamURL,
    enabled: streamEnabled,
    onInflight: ({ key, entry }) => {
      if (!admin) return;
      // Only a first sighting moves the rows below it; a re-announcement of a
      // call already on screen rewrites one row in place.
      if (showLive && !hoveringRef.current && !liveRef.current.has(key)) {
        captureLiveLayout(`live:${key}`);
      }
      // Upsert, not append: the same key is announced again each time the call
      // is routed or retried, so the row names the upstream being waited on.
      const next = new Map(liveRef.current);
      next.set(key, { ...entry, live_key: key });
      commitLive(next);
    },
    onInflightSync: (calls) => {
      if (!admin) return;
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
      commitLive(next);
    },
    onEntry: (entry, key) => {
      // Retire the placeholder first, and on every page: the settled row is the
      // same call, and listing it twice is the one outcome worth ruling out.
      if (key && liveRef.current.has(key)) {
        const next = new Map(liveRef.current);
        next.delete(key);
        missedSyncs.current.delete(key);
        commitLive(next);
      }
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
      missedSyncs.current.clear();
      commitLive(new Map());
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
    liveRef.current = new Map();
    missedSyncs.current.clear();
    setLiveCalls((current) => (current.size ? new Map() : current));
  }, [streamURL, streamEnabled]);

  // Newest first, like the rows below them, so the time column still reads
  // top-to-bottom as one descending sequence.
  const liveRows = useMemo(() => {
    if (!showLive) return [] as LogRow[];
    return [...liveCalls.values()].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [liveCalls, showLive]);
  const hasLive = liveRows.length > 0;

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
          {liveToggle}
        </Space>
      )}
      <Space wrap style={{ marginBottom: 12 }} size={8}>
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
        {/* Worth stating even though the rows are visible: a busy moment can
            push some of them past the end of the page. */}
        {hasLive && (
          <Tooltip title="已转发给上游、尚未结束的调用，结束后会就地换成正式记录">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {liveRows.length} 条进行中
            </Typography.Text>
          </Tooltip>
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
          className={`table-clickable${admin ? " log-table--live" : ""}`}
          loading={loading}
          dataSource={tableRows}
          rowClassName={(row) =>
            isLive(row)
              ? "log-row--running"
              : enteringRowIDs.has(row.id)
                ? "log-row--enter"
                : ""
          }
          scroll={{ x: scrollX }}
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
          columns={[
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
              render: (value: string) =>
                value ? (
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

// Standard reason phrases for the status codes a relay realistically returns.
// Anything unlisted simply omits the phrase, which is valid HTTP.
const REASON_PHRASE: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  499: "Client Closed Request",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * Renders one side of the call as it would appear on the wire: start line,
 * folded headers, blank line, body. Reading a relayed call means comparing it
 * against the upstream's own docs and curl output, and both speak raw HTTP —
 * a JSON rendering of the header map forces a mental translation every time.
 */
const httpMessage = (
  kind: "request" | "response",
  entry: RequestLog,
  headers: Record<string, string[]> | undefined,
  body: string | undefined,
) => {
  const startLine =
    kind === "request"
      ? `${entry.method || "POST"} ${entry.endpoint || "/"} HTTP/1.1`
      : `HTTP/1.1 ${entry.status_code}${
          REASON_PHRASE[entry.status_code]
            ? ` ${REASON_PHRASE[entry.status_code]}`
            : ""
        }`;

  // Repeated headers stay on separate lines, which is how they travel.
  const lines = Object.entries(headers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, values]) => values.map((value) => `${name}: ${value}`));

  return `${[startLine, ...lines].join("\n")}\n\n${body ?? ""}`;
};

// LogBody shows one side of a call. The bodies are held for a limited number
// of recent calls, so "not here" is a normal outcome and is spelled out rather
// than shown as an empty panel.
type BodyView = "raw" | "chat";

function LogBody({
  kind,
  state,
  bodies,
  entry,
}: {
  kind: "request" | "response";
  state: "idle" | "loading" | "expired" | "failed";
  bodies: RequestLogDetail | null;
  entry: RequestLog;
}) {
  const { message } = App.useApp();
  const { settings } = useSettings();
  const [view, setView] = useState<BodyView>("chat");

  // Parsing walks the whole body, which for a streamed response is every SSE
  // frame; keep it off the render path unless the body actually changed.
  const rawBody =
    kind === "request" ? bodies?.request_body : bodies?.response_body;
  const turns = useMemo(
    () =>
      kind === "request"
        ? parseRequestConversation(rawBody)
        : parseResponseConversation(rawBody),
    [kind, rawBody],
  );

  if (state === "loading") return <Skeleton active paragraph={{ rows: 6 }} />;
  if (state === "expired") {
    return (
      <Alert
        type="info"
        showIcon
        message="这次调用的正文已不再保留"
        description={`只保留最近 ${formatNumber(settings.log_detail_keep)} 次调用的完整正文，这条已经滚出该范围。可在「全局设置 → 完整日志」调整条数。`}
      />
    );
  }
  if (state === "failed")
    return <Alert type="error" showIcon message="加载正文失败" />;
  if (!bodies) {
    return (
      <Alert
        type="info"
        showIcon
        message="未记录正文"
        description="完整日志当前处于关闭状态，可在「全局设置 → 完整日志」开启。"
      />
    );
  }

  const headers =
    kind === "request" ? bodies.request_headers : bodies.response_headers;
  const body = kind === "request" ? bodies.request_body : bodies.response_body;
  const truncated =
    kind === "request" ? bodies.request_truncated : bodies.response_truncated;
  const httpText = httpMessage(kind, entry, headers, body);

  // Non-chat calls (embeddings, audio, …) have nothing to show in the chat
  // view; land them on the raw message instead of an apology.
  const effectiveView: BodyView = turns ? view : "raw";

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          message={`正文超过 ${formatBytes(settings.log_body_limit)}，已截断或省略`}
          description="上限可在「全局设置 → 正文捕获」调整。"
        />
      )}
      <Space size={8} wrap>
        <Segmented
          size="small"
          value={effectiveView}
          onChange={(value) => setView(value as BodyView)}
          options={[
            { label: "报文", value: "raw" },
            { label: "会话", value: "chat", disabled: !turns },
          ]}
        />
        {effectiveView === "raw" ? (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              敏感头已脱敏{turns ? "" : " · 该正文不是可识别的对话"}
            </Typography.Text>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                void copyTextToClipboard(httpText).then((copied) =>
                  copied
                    ? message.success("已复制报文")
                    : message.warning("浏览器拒绝了剪贴板访问，请手动选中复制"),
                );
              }}
            >
              复制报文
            </Button>
          </>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`${turns?.length ?? 0} 条消息${truncated ? "（正文被截断，可能不完整）" : ""}`}
          </Typography.Text>
        )}
      </Space>
      {effectiveView === "raw" ? (
        // No inner max-height: the drawer body is the scroll container.
        <pre className="code-block">{httpText}</pre>
      ) : (
        <Conversation turns={turns ?? []} />
      )}
    </Space>
  );
}

const ROLE_LABEL: Record<string, string> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
};

const PART_LABEL: Record<PartKind, string> = {
  text: "",
  reasoning: "思考",
  tool_call: "调用工具",
  tool_result: "工具结果",
  image: "附件",
  other: "其他",
};

// Long system prompts dominate a transcript, so anything past this is folded
// away behind a toggle. The threshold is generous enough that ordinary turns
// are never clipped.
const PART_CLAMP = 1600;

function Conversation({ turns }: { turns: ConversationTurn[] }) {
  return (
    <div className="chat-log">
      {turns.map((turn, index) => (
        <div key={index} className={`chat-turn chat-turn--${turn.role}`}>
          <div className="chat-turn__role">
            {ROLE_LABEL[turn.role] ?? turn.role}
          </div>
          <div className="chat-turn__parts">
            {turn.parts.map((part, partIndex) => (
              <ChatPart key={partIndex} part={part} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatPart({ part }: { part: ConversationPart }) {
  const [expanded, setExpanded] = useState(false);
  const long = part.text.length > PART_CLAMP;
  const shown = long && !expanded ? part.text.slice(0, PART_CLAMP) : part.text;
  const label = PART_LABEL[part.kind];

  return (
    <div className={`chat-part chat-part--${part.kind}`}>
      {(label || part.name) && (
        <div className="chat-part__label">
          {label}
          {part.name && <span className="mono"> {part.name}</span>}
        </div>
      )}
      <pre className="chat-part__text">{shown}</pre>
      {long && (
        <Button
          type="link"
          size="small"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "收起"
            : `展开剩余 ${formatNumber(part.text.length - PART_CLAMP)} 字`}
        </Button>
      )}
    </div>
  );
}

// LogMeta renders the metadata a log row already carries; no fetch needed.
function LogMeta({ detail, admin }: { detail: RequestLog; admin?: boolean }) {
  return (
    <Descriptions column={1} size="small" bordered>
      <Descriptions.Item label="ID">
        <span className="mono">{detail.id}</span>
      </Descriptions.Item>
      <Descriptions.Item label="时间">
        {formatTime(detail.created_at)}
      </Descriptions.Item>
      {admin && (
        <Descriptions.Item label="用户">{detail.username}</Descriptions.Item>
      )}
      <Descriptions.Item label="密钥">
        {detail.token_name || "-"}
      </Descriptions.Item>
      <Descriptions.Item label="接口">
        <span className="mono">{detail.endpoint}</span>
      </Descriptions.Item>
      <Descriptions.Item label="请求模型">
        <span className="mono">{detail.model}</span>
      </Descriptions.Item>
      {(!admin ||
        (detail.upstream_model && detail.upstream_model !== detail.model)) && (
        <Descriptions.Item label="上游模型">
          <span className="mono">{detail.upstream_model || detail.model}</span>
        </Descriptions.Item>
      )}
      <Descriptions.Item label="渠道">
        {detail.channel_id > 0 ? (
          <>
            <Tag className="mono">#{detail.channel_id}</Tag>
            {detail.channel_name || "（已删除）"}
          </>
        ) : (
          "-"
        )}
        {detail.retries > 0 && (
          <Tag color="gold" style={{ marginInlineStart: 8 }}>
            重试 {detail.retries} 次
          </Tag>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="状态码">
        <Tag color={rowTone(detail)}>{detail.status_code}</Tag>
        {detail.stream ? <Tag color="blue">流式</Tag> : <Tag>非流式</Tag>}
      </Descriptions.Item>
      {(!admin || detail.reasoning_effort) && (
        <Descriptions.Item label="思考强度">
          {detail.reasoning_effort ? (
            <Tag color={REASONING_TONE[detail.reasoning_effort] ?? "default"}>
              {detail.reasoning_effort}
            </Tag>
          ) : (
            <span className="text-muted">未指定</span>
          )}
        </Descriptions.Item>
      )}
      <Descriptions.Item label="客户端">
        {detail.client_type && detail.client_type !== "unknown" ? (
          <Tag>{detail.client_type}</Tag>
        ) : (
          <span className="text-muted">未识别</span>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="来源 IP">
        {detail.client_ip ? (
          <Tooltip title="来自 X-Forwarded-For；直连本服务的调用方可以自行设置该头，仅供参考">
            <span className="mono">{detail.client_ip}</span>
          </Tooltip>
        ) : (
          <span className="text-muted">-</span>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Token 用量">
        输入 {formatNumber(detail.prompt_tokens)} · 输出{" "}
        {formatNumber(detail.completion_tokens)} · 合计{" "}
        {formatNumber(
          detail.total_tokens ||
            detail.prompt_tokens + detail.completion_tokens,
        )}
      </Descriptions.Item>
      <Descriptions.Item label="缓存命中">
        {formatNumber(detail.cached_tokens)}
        <span className="text-muted">
          {" "}
          / {formatNumber(detail.prompt_tokens)} 输入
        </span>
      </Descriptions.Item>
      <Descriptions.Item label="缓存率">
        <Tooltip title="缓存命中的输入 token 占全部输入的比例；命中部分按缓存价计费">
          <span>{formatPercent(cacheRate(detail))}</span>
        </Tooltip>
      </Descriptions.Item>
      <Descriptions.Item label="缓存创建">
        <Tooltip title="写入缓存的输入 token，已计入输入总数；上游通常按高于普通输入的价格计费">
          <span>{formatNumber(detail.cache_creation_tokens)}</span>
        </Tooltip>
      </Descriptions.Item>
      <Descriptions.Item label="费用">
        {formatUSD(detail.cost, 6)}
      </Descriptions.Item>
      <Descriptions.Item label="耗时">
        总计 {formatDuration(detail.duration_ms)}
        {detail.ttfb_ms > 0 && ` · 首字节 ${formatDuration(detail.ttfb_ms)}`}
      </Descriptions.Item>
      <Descriptions.Item label="错误">
        {detail.error ? (
          <Typography.Paragraph
            copyable={{ text: detail.error }}
            style={{
              color: "var(--app-danger)",
              marginBottom: 0,
              whiteSpace: "pre-wrap",
            }}
          >
            {detail.error}
          </Typography.Paragraph>
        ) : (
          <span className="text-muted">无</span>
        )}
      </Descriptions.Item>
    </Descriptions>
  );
}
