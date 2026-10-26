import { Fragment, useState, type ReactNode } from "react";
import { Button, Image } from "antd";

import type {
  ConversationPart,
  ConversationTurn,
  PartKind,
} from "../../utils/conversation";
import { formatNumber } from "../../utils/format";

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
export const PART_CLAMP = 1600;

/** Names one part for forced expansion: "turn position:part index". */
export const partKey = (position: number, part: number) => `${position}:${part}`;

/**
 * The leading turns a call repeats from its parent, drawn as one folded block:
 * a coding agent resends the whole conversation, and the turns that are new
 * are the reason anyone opened the call.
 */
export interface ConversationFold {
  /** Messages repeated from the start; the system prompt folds with them. */
  messages: number;
  label: ReactNode;
  actions?: ReactNode;
}

/** How many leading turns a fold covers: the system prompt, then messages
 *  below its count. */
export const foldedTurns = (turns: ConversationTurn[], fold?: ConversationFold) => {
  if (!fold || fold.messages <= 0) return 0;
  let n = 0;
  while (n < turns.length && (turns[n].index === undefined || turns[n].index! < fold.messages)) n++;
  return n;
};

export function Conversation({
  turns,
  fold,
  forceFoldOpen,
  forceExpanded,
  before,
}: {
  turns: ConversationTurn[];
  fold?: ConversationFold;
  /** A search hit inside the fold opens it. */
  forceFoldOpen?: boolean;
  /** Parts a search hit inside must show whole; see partKey. */
  forceExpanded?: ReadonlySet<string>;
  /** Drawn ahead of a turn, given its position in `turns`. */
  before?: (turn: ConversationTurn, position: number) => ReactNode;
}) {
  const [foldOpen, setFoldOpen] = useState(false);
  const folded = foldedTurns(turns, fold);
  const open = foldOpen || forceFoldOpen;

  return (
    <div className="chat-log">
      {folded > 0 && (
        <div className="chat-fold">
          <div className="chat-fold__label">{fold!.label}</div>
          <div className="chat-fold__actions">
            {fold!.actions}
            <Button size="small" onClick={() => setFoldOpen((value) => !value)}>
              {open ? "收起" : "展开"}
            </Button>
          </div>
        </div>
      )}
      {turns.map((turn, position) =>
        position < folded && !open ? null : (
          <Fragment key={position}>
            {before?.(turn, position)}
            <div className={`chat-turn chat-turn--${turn.role}`}>
              <div className="chat-turn__role">
                {ROLE_LABEL[turn.role] ?? turn.role}
                {turn.index !== undefined && (
                  <span className="chat-turn__index">#{turn.index + 1}</span>
                )}
              </div>
              <div className="chat-turn__parts">
                {turn.parts.map((part, partIndex) => (
                  <ChatPart
                    key={partIndex}
                    part={part}
                    forced={forceExpanded?.has(partKey(position, partIndex))}
                  />
                ))}
              </div>
            </div>
          </Fragment>
        ),
      )}
    </div>
  );
}

function ChatPart({ part, forced }: { part: ConversationPart; forced?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = part.text.length > PART_CLAMP;
  const whole = expanded || forced;
  const shown = long && !whole ? part.text.slice(0, PART_CLAMP) : part.text;
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
            loading="lazy"
            decoding="async"
            preview={{ rootClassName: "checkerboard" }}
          />
        </div>
      )}
      {shown && <pre className="chat-part__text">{shown}</pre>}
      {long && !forced && (
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
