import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Button,
  Drawer,
  Space,
  Tabs,
  Tooltip,
  Typography,
} from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";

import { api, ApiError } from "../../api/client";
import type { RequestLog, RequestLogDetail } from "../../api/types";
import LogBody from "./LogBody";
import LogMeta from "./LogMeta";
import StatusTag from "./StatusTag";

const EMPTY_ROWS: RequestLog[] = [];

// Widgets that move their own selection with ← and →.
const ARROW_OWNERS = [
  "tab",
  "tablist",
  "slider",
  "radiogroup",
  "listbox",
  "menu",
  "menubar",
  "grid",
  "tree",
  "spinbutton",
  "combobox",
]
  .map((role) => `[role="${role}"]`)
  .join(", ");

/** Opening a row is the table's business; what happens afterwards is ours. */
export interface LogDetailHandle {
  open(row: RequestLog): void;
}

interface Props {
  admin?: boolean;
  narrow: boolean;
  /** The page's settled rows, in display order: what ← and → walk through. */
  siblings?: RequestLog[];
}

const LogDetailDrawer = forwardRef<LogDetailHandle, Props>(function LogDetailDrawer(
  { admin, narrow, siblings = EMPTY_ROWS },
  ref,
) {
  const [detail, setDetail] = useState<RequestLog | null>(null);
  // The bodies live in a separate table with its own retention window, so they
  // are fetched when a row is opened and may legitimately be gone.
  const [bodies, setBodies] = useState<RequestLogDetail | null>(null);
  const [bodiesState, setBodiesState] = useState<
    "idle" | "loading" | "expired" | "missing" | "failed"
  >("idle");
  // Which row the visible drawer belongs to. A slow response for a row the
  // operator already clicked past must not paint under the new one.
  const openId = useRef<number | null>(null);

  const openDetail = useCallback((row: RequestLog) => {
    openId.current = row.id;
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
        if (openId.current !== row.id) return;
        setBodies(result);
        setBodiesState("idle");
      })
      .catch((error: unknown) => {
        if (openId.current !== row.id) return;
        // 410 is the ordinary outcome for anything past the window, so it is
        // reported as a state rather than as an error; 404 means the row
        // itself is gone.
        setBodiesState(
          error instanceof ApiError && error.status === 410
            ? "expired"
            : error instanceof ApiError && error.status === 404
              ? "missing"
              : "failed",
        );
      });
  }, [admin]);

  // Only rows that have landed in the database can be opened, and the order is
  // the table's own.
  const navigable = useMemo(
    () => siblings.filter((row) => row.id > 0),
    [siblings],
  );
  const position = useMemo(() => {
    if (!detail) return -1;
    return navigable.findIndex((row) => row.id === detail.id);
  }, [detail, navigable]);
  const prev = position > 0 ? navigable[position - 1] : undefined;
  const next =
    position >= 0 && position < navigable.length - 1
      ? navigable[position + 1]
      : undefined;

  // ← and → move through the page while the drawer is open. Arrows that belong
  // to something else are left alone: a text cursor, a tab strip or a slider
  // moving its own selection, and modified arrows — Alt+← is the browser's back.
  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.closest(ARROW_OWNERS))
      )
        return;
      const target_row = event.key === "ArrowLeft" ? prev : next;
      if (!target_row) return;
      event.preventDefault();
      openDetail(target_row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, next, prev, openDetail]);

  useImperativeHandle(ref, () => ({ open: openDetail }));

  return (
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
          <Space size={8} wrap>
            <span>调用详情 #{detail.id}</span>
            <StatusTag
              status={detail.status_code}
              upstream={detail.upstream_status}
              error={detail.error}
              cancelled={detail.cancelled}
              style={{ marginInlineEnd: 0 }}
            />
            {/* Walking the page without closing the drawer: the point of
                opening a failure is usually to see the ones next to it. */}
            <Tooltip title="上一条（←）">
              <Button
                type="text"
                size="small"
                aria-label="上一条调用"
                icon={<LeftOutlined />}
                disabled={!prev}
                onClick={() => prev && openDetail(prev)}
              />
            </Tooltip>
            <Tooltip title="下一条（→）">
              <Button
                type="text"
                size="small"
                aria-label="下一条调用"
                icon={<RightOutlined />}
                disabled={!next}
                onClick={() => next && openDetail(next)}
              />
            </Tooltip>
          </Space>
        ) : (
          "调用详情"
        )
      }
      onClose={() => setDetail(null)}
    >
      {/* The error is the first thing anyone opening a failed call wants; at
          the bottom of the metadata it read as a footnote. */}
      {detail?.error && (
        <Alert
          // Hung up or stopped by an operator: worth saying, but not a failure.
          type={detail.cancelled ? "info" : "error"}
          showIcon
          style={{ marginBottom: 16 }}
          message={detail.cancelled ? "调用已中断" : "这次调用失败了"}
          description={
            <Typography.Paragraph
              copyable={{ text: detail.error, tooltips: ["复制错误", "已复制"] }}
              style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}
            >
              {detail.error}
            </Typography.Paragraph>
          }
        />
      )}
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
  );
});

export default LogDetailDrawer;
