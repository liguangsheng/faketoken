import { useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Image,
  Segmented,
  Skeleton,
  Space,
  Typography,
} from "antd";
import { CopyOutlined } from "@ant-design/icons";

import type { RequestLog, RequestLogDetail } from "../../api/types";
import { useSettings } from "../../settings/SettingsContext";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  parseRequestConversation,
  parseResponseConversation,
  type ConversationPart,
  type ConversationTurn,
  type PartKind,
} from "../../utils/conversation";
import { formatBytes, formatNumber } from "../../utils/format";

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

export default function LogBody({
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
  // A rendered image speaks for itself; the label is for placeholders.
  const label = part.src ? "" : PART_LABEL[part.kind];

  return (
    <div className={`chat-part chat-part--${part.kind}`}>
      {(label || part.name) && (
        <div className="chat-part__label">
          {label}
          {part.name && <span className="mono"> {part.name}</span>}
        </div>
      )}
      {/* Click opens antd's viewer at full size: a data: URL cannot be
          opened in a new tab, browsers block top-level data: navigation.
          Wrapped rather than given rootClassName, which antd also puts on
          the viewer's root. */}
      {part.src && (
        <div className="chat-part__image checkerboard">
          <Image
            src={part.src}
            alt="图片"
            preview={{ rootClassName: "checkerboard" }}
          />
        </div>
      )}
      {shown && <pre className="chat-part__text">{shown}</pre>}
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
