import { Tag, Tooltip } from "antd";

import { statusTone } from "./tone";

interface Props {
  status: number;
  /** The upstream's own code, when a channel rule rewrote it. */
  upstream?: number;
  error?: string;
  style?: React.CSSProperties;
}

/**
 * The status of a finished call.
 *
 * An upstream can answer 200 and then break inside the body — an SSE stream
 * that ends with an error event is the common case. The code stays recoverable
 * (in the tooltip), but the label says 失败: a green 200 on a failed call is
 * exactly what hides these rows.
 */
export default function StatusTag({ status, upstream = 0, error, style }: Props) {
  const failed = Boolean(error) && status < 400;
  const code = upstream > 0 ? `${upstream}→${status}` : String(status);

  if (failed) {
    return (
      <Tooltip
        title={
          <>
            <div>
              {upstream > 0 ? `上游 ${upstream}，映射后返回 ${status}` : `返回 ${status}`}
              ，响应体中带错误
            </div>
            <div>{error?.split("\n")[0]}</div>
          </>
        }
      >
        <Tag color="red" style={style}>
          失败
        </Tag>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      title={
        upstream > 0
          ? `上游返回 ${upstream}，按渠道状态码映射返回调用方 ${status}`
          : undefined
      }
    >
      <Tag color={statusTone(status)} style={style}>
        {code}
      </Tag>
    </Tooltip>
  );
}
