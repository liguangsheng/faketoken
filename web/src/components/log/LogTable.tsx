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
  Button,
  Table,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import { api, type Page, type RequestLog } from "../../api/client";
import { createLiveRateStore } from "../../hooks/useLiveRate";
import { useLogStream } from "../../hooks/useLogStream";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTableScrollX } from "../../hooks/useTableScrollX";
import EmptyState from "../EmptyState";
import LogDetailDrawer, { type LogDetailHandle } from "./LogDetailDrawer";
import LogFilterBar from "./LogFilterBar";
import LiveRateMeter from "./LiveRateMeter";
import LiveToggle from "./LiveToggle";
import { useLiveRowAnimation } from "./useLiveRowAnimation";
import {
  isLive,
  rowKeyOf,
  useInflightCalls,
  type LogRow,
} from "./useInflightCalls";
import { useLogFilters } from "./useLogFilters";
import {
  COLUMN_GEOMETRY,
  OWNER_GEOMETRY,
  logColumns,
  phoneColumns,
} from "./logColumns";
import { formatNumber } from "../../utils/format";

interface Props {
  admin?: boolean;
  fetcher: (params: Record<string, unknown>) => Promise<Page<RequestLog>>;
  extra?: ReactNode;
  /** Show a live RPM/TPM pulse bar above the table (admin first-page only). */
  showRate?: boolean;
  /** Bump to force a data reload without remounting (filters survive). */
  reloadToken?: number;
}

// A stable empty list, so the table memo does not recompute on every render
// when nothing live is being drawn.
const EMPTY_ROWS: LogRow[] = [];

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
  const scrollX = useTableScrollX(admin ? COLUMN_GEOMETRY : OWNER_GEOMETRY);
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
  const [live, setLive] = useState(true);
  const filters = useLogFilters(Boolean(admin));
  const {
    keyword,
    model,
    tokenName,
    username,
    channelID,
    onlyError,
    range,
    dirty,
    // The page and its size live in the address with the filters (附录 A),
    // so a reload lands on the same slice of the list.
    page,
    pageSize,
    setPage,
    // The filter row reads and writes the whole hook result.
  } = filters;
  const detailRef = useRef<LogDetailHandle>(null);

  // The rate pulse only makes sense on page 1, in the live window, on the
  // admin surface — for a regular user it would reflect their own traffic
  // only and read as a low, useless number.
  const rateActive = Boolean(showRate && admin && page === 1 && live && !range);
  // The samples live outside React: the feed writes on every arrival, the
  // meter reads once a second, and the table in between never re-renders for
  // either.
  const rateStore = useMemo(() => createLiveRateStore(), []);
  // Why the meter is parked, so a zero never reads as "no traffic".
  const idleHint = live
    ? range
      ? "已选时间范围"
      : "非首页"
    : "实时推送已关闭";

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
        // The first page is what the rate meter starts from: calls of the last
        // minute the feed did not deliver, because it was down or not yet open.
        if (page === 1) rateStore.merge(data);
        // A purge, a narrower filter or an old link can strand a page number
        // past the end; walk back to the last real page, or the first.
        if (data.length === 0 && page > 1) {
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
      rateStore,
      setPage,
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

  // Stable references: the hook memoises each of them.
  const { publish: publishInflight, reset: resetInflight } = inflight;

  const flushHoverBuffer = useCallback(() => {
    publishInflight();
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
  }, [publishInflight, page, pageSize]);

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
      rateStore.add(entry);
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
    resetInflight();
  }, [resetInflight, streamURL, streamEnabled]);

  // Same for the rate samples: they were counted under the old filters. The
  // next first-page load and the new feed fill them again.
  useEffect(() => {
    rateStore.clear();
  }, [rateStore, streamURL]);

  // Drawn only where showLive says so; the set itself is tracked regardless.
  const liveRows = showLive ? inflight.liveRows : EMPTY_ROWS;
  const hasLive = liveRows.length > 0;
  const { liveCalls } = inflight;

  // Live rows sit above the newest settled row, and the page is trimmed back to
  // the size the operator chose: a burst of traffic pushes history down instead
  // of growing the table past its own pagination.
  const tableRows = useMemo<LogRow[]>(
    () => (hasLive ? [...liveRows, ...rows].slice(0, pageSize) : rows),
    [hasLive, liveRows, pageSize, rows],
  );

  // Column definitions are the table's most expensive prop: rebuilt every
  // render, rc-table re-derives the whole grid from them. `cancelling` is a Set
  // held in state, so its identity is the signal that they really changed.
  const columns = useMemo(
    () =>
      narrow
        ? phoneColumns({ admin })
        : logColumns({ admin, cancelling, cancelCall }),
    [admin, cancelCall, cancelling, narrow],
  );

  // The toggle belongs next to the meters it governs, but those only render on
  // the admin board; elsewhere it falls back into the filter row.
  // Re-enabling reconnects a fresh stream, which cannot know what it missed;
  // reload the first page to close the gap.
  const toggleLive = (value: boolean) => {
    setLive(value);
    if (value && page === 1) void load();
  };

  return (
    <>
      {showRate && admin && (
        <LiveRateMeter
          store={rateStore}
          rateActive={rateActive}
          idleHint={idleHint}
          concurrencyActive={concurrencyActive}
          concurrencyIdleHint={concurrencyIdleHint}
          liveCalls={liveCalls.size}
        >
          <LiveToggle
            live={live}
            range={Boolean(range)}
            streamState={streamState}
            canStream={canStream}
            onChange={toggleLive}
          />
        </LiveRateMeter>
      )}
      <LogFilterBar
        admin={admin}
        narrow={narrow}
        filters={filters}
        loading={loading}
        onReload={() => void load()}
        liveToggle={
          !(showRate && admin) ? (
            <LiveToggle
              live={live}
              range={Boolean(range)}
              streamState={streamState}
              canStream={canStream}
              onChange={toggleLive}
            />
          ) : undefined
        }
        pending={pending}
        hoverPending={hoverPending}
        onBackToFirstPage={() => setPage(1)}
        extra={extra}
      />

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
          // The header stays under the app bar while the page scrolls: columns
          // are wide, and reading a value out of view of its heading is the
          // main way this table gets misread. Cards carry their own labels, so
          // phones get nothing here.
          sticky={narrow ? undefined : { offsetHeader: 56 }}
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
              detailRef.current?.open(row);
            },
            // Rows are the only way into the detail drawer, so they must be
            // reachable without a mouse.
            tabIndex: 0,
            "aria-label": `查看调用 #${row.id} 详情`,
            onKeyDown: (event) => {
              if (event.key === "Enter") detailRef.current?.open(row);
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
            onChange: (nextPage, nextSize) => setPage(nextPage, nextSize),
          }}
          columns={columns}
        />
      </div>

      <LogDetailDrawer
        ref={detailRef}
        admin={admin}
        narrow={narrow}
        // The page's settled rows: what the drawer's ← and → walk through.
        siblings={rows}
      />
    </>
  );
}
