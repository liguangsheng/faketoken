import { memo, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Input,
  Segmented,
  Skeleton,
  Space,
  Tooltip,
  Typography,
} from "antd";
import { CopyOutlined, DownOutlined, SearchOutlined, UpOutlined } from "@ant-design/icons";

import type { RequestLog, RequestLogDetail } from "../../api/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useSettings } from "../../settings/SettingsContext";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  parseRequestConversation,
  parseResponseConversation,
} from "../../utils/conversation";
import { formatBytes, formatNumber } from "../../utils/format";
import { summarizeRequest, type RequestSummary } from "../../utils/requestSummary";
import {
  Conversation,
  PART_CLAMP,
  foldedTurns,
  partKey,
  type ConversationFold,
} from "./Conversation";
import ResponseTimeline from "./ResponseTimeline";
import { MAX_HITS, escapeRegExp, useTextSearch } from "./useTextSearch";

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

// About 64 KB per chunk. Big enough that the per-chunk bookkeeping is
// negligible, small enough that the browser can skip most of a multi-megabyte
// body without giving up on the text.
const CHUNK_CHARS = 64 * 1024;

/**
 * Splits a text into chunks that each end on a line boundary.
 *
 * The chunks are drawn as blocks, so the boundary must be a newline: the text
 * that follows has to start on its own line, exactly as it did in the single
 * block. A tail with no line break at all stays inline — breaking it would
 * put a line break where the text had none. The text itself is untouched:
 * every character stays in the DOM, so find-in-page still reaches it.
 */
const chunkText = (text: string): { text: string; block: boolean }[] => {
  if (!text) return [];
  const chunks: { text: string; block: boolean }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const newline = text.indexOf("\n", end);
      if (newline === -1) {
        chunks.push({ text: text.slice(start), block: false });
        break;
      }
      end = newline + 1;
    }
    chunks.push({ text: text.slice(start, end), block: true });
    start = end;
  }
  return chunks;
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
  onOpenCall,
}: {
  kind: "request" | "response";
  state: "idle" | "loading" | "expired" | "missing" | "failed";
  bodies: RequestLogDetail | null;
  entry: RequestLog;
  /** Opens another call in the same drawer: the parent a request repeats. */
  onOpenCall?: (id: number) => void;
}) {
  const { message } = App.useApp();
  const { settings } = useSettings();
  const [view, setView] = useState<BodyView>("chat");
  const [queryInput, setQueryInput] = useState("");
  const query = useDebouncedValue(queryInput.trim(), 250);
  const bodyRef = useRef<HTMLDivElement>(null);

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
  // Non-chat calls (embeddings, audio, …) have nothing to show in the chat
  // view; they land on the raw message instead of an apology.

  // The raw message, and the blocks it is drawn in. Both are computed before
  // the early returns below, so the hooks keep their order.
  const headers =
    kind === "request" ? bodies?.request_headers : bodies?.response_headers;
  const body = kind === "request" ? bodies?.request_body : bodies?.response_body;
  const httpText = httpMessage(kind, entry, headers, body);
  const chunks = useMemo(() => chunkText(httpText), [httpText]);
  const summary = useMemo(
    () => (kind === "request" ? summarizeRequest(rawBody) : null),
    [kind, rawBody],
  );

  // What the request repeats from its parent folds away in the chat view.
  const fold = useMemo<ConversationFold | undefined>(() => {
    if (kind !== "request" || entry.parent_id <= 0 || entry.shared_messages <= 0) return undefined;
    return {
      messages: entry.shared_messages,
      label: (
        <>
          与上一次调用 <span className="mono">#{entry.parent_id}</span> 相同：system
          提示和前 {formatNumber(entry.shared_messages)} 条消息
        </>
      ),
      actions: onOpenCall && (
        <Button size="small" type="link" onClick={() => onOpenCall(entry.parent_id)}>
          打开 #{entry.parent_id}
        </Button>
      ),
    };
  }, [entry.parent_id, entry.shared_messages, kind, onOpenCall]);

  // A hit inside a clamped part or the fold has to be rendered to be found.
  const forced = useMemo(() => {
    const parts = new Set<string>();
    let foldOpen = false;
    if (!query || !turns) return { parts, foldOpen };
    const pattern = new RegExp(escapeRegExp(query), "i");
    const folded = foldedTurns(turns, fold);
    turns.forEach((turn, position) =>
      turn.parts.forEach((part, index) => {
        if (!pattern.test(part.text) && !(part.name && pattern.test(part.name))) return;
        if (part.text.length > PART_CLAMP) parts.add(partKey(position, index));
        if (position < folded) foldOpen = true;
      }),
    );
    return { parts, foldOpen };
  }, [fold, query, turns]);

  const effectiveView: BodyView = turns ? view : "raw";
  // A new token only when the text under the search changes: rescanning a
  // multi-megabyte body on every render would freeze the drawer.
  const rendered = useMemo(
    () => [effectiveView, httpText, forced],
    [effectiveView, httpText, forced],
  );
  const search = useTextSearch(bodyRef, query, rendered);

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
  if (state === "missing")
    return (
      <Alert
        type="info"
        showIcon
        message="这次调用已经结束，正文不再可读"
        description="行还在列表里，但服务端已没有它的记录（常见的是一次还没落库就被取消的调用）。"
      />
    );
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

  const truncated =
    kind === "request" ? bodies.request_truncated : bodies.response_truncated;

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
      {summary && <RequestShape summary={summary} />}
      {kind === "response" && bodies.response_timing && (
        <ResponseTimeline timing={bodies.response_timing} />
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
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder="在正文中查找"
          aria-label="在正文中查找"
          style={{ width: 200 }}
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          onPressEnter={(event) => (event.shiftKey ? search.prev() : search.next())}
          suffix={
            query ? (
              <span className="text-muted" style={{ fontSize: 12 }}>
                {search.count
                  ? `${search.current + 1}/${search.count >= MAX_HITS ? `${MAX_HITS}+` : search.count}`
                  : "0"}
              </span>
            ) : undefined
          }
        />
        {query && search.count > 1 && (
          <Space.Compact>
            <Button size="small" icon={<UpOutlined />} aria-label="上一处" onClick={search.prev} />
            <Button size="small" icon={<DownOutlined />} aria-label="下一处" onClick={search.next} />
          </Space.Compact>
        )}
      </Space>
      <div ref={bodyRef}>
        {effectiveView === "raw" ? (
          // No inner max-height: the drawer body is the scroll container. The
          // chunks are blocks so the browser can skip the ones below the fold;
          // the text stays whole in the DOM either way.
          <pre className="code-block">
            {chunks.map((chunk, index) => (
              <span
                key={index}
                className={chunk.block ? "code-chunk" : "code-chunk code-chunk--inline"}
              >
                {chunk.text}
              </span>
            ))}
          </pre>
        ) : (
          <Conversation
            turns={turns ?? []}
            fold={fold}
            forceFoldOpen={forced.foldOpen}
            forceExpanded={forced.parts}
          />
        )}
      </div>
    </Space>
  );
}

/**
 * The request's makeup on one line: system prompt, tools, conversation,
 * images, cache breakpoints, and the parameters that shape the answer.
 */
function RequestShape({ summary }: { summary: RequestSummary }) {
  const { tools, messages, images, breakpoints, params } = summary;
  const roles = Object.entries(messages.byRole)
    .map(([role, n]) => `${role} ${n}`)
    .join(" · ");
  return (
    <div className="request-shape">
      {summary.systemChars > 0 && <span>system {formatBytes(summary.systemChars)}</span>}
      {tools.count > 0 && (
        <Tooltip title={tools.names.join("、")}>
          <span>
            工具 {tools.count} 个 · {formatBytes(tools.chars)}
          </span>
        </Tooltip>
      )}
      <Tooltip title={roles}>
        <span>
          消息 {formatNumber(messages.count)} 条 · {formatBytes(messages.chars)}
        </span>
      </Tooltip>
      {images.count > 0 && (
        <span className="request-shape__heavy">
          图片 {images.count} 张 · {formatBytes(images.bytes)}
        </span>
      )}
      {breakpoints.length > 0 && (
        <Tooltip title={breakpoints.join("、")}>
          <span>缓存断点 {breakpoints.length} 处</span>
        </Tooltip>
      )}
      {params.map((param) => (
        <span key={param.label} className="mono">
          {param.label} {param.value}
        </span>
      ))}
    </div>
  );
}

// The body is rebuilt only when the opened row or its text changes.
export default memo(LogBody);
