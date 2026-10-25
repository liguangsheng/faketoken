import { Badge, Space, Switch, Tooltip, Typography } from "antd";

import type { StreamState } from "../../hooks/useLogStream";

interface Props {
  live: boolean;
  /** A time range bounds history, and the feed is always "now". */
  range: boolean;
  streamState: StreamState;
  /** Whether arrivals can be shown where the reader is standing. */
  canStream: boolean;
  onChange: (value: boolean) => void;
}

/**
 * The push switch with its state caption. The toggle belongs next to the
 * meters it governs, but those only render on the admin board; elsewhere it
 * falls back into the filter row.
 */
export default function LiveToggle({
  live,
  range,
  streamState,
  canStream,
  onChange,
}: Props) {
  return (
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
            disabled={range}
            aria-label="实时推送"
            onChange={onChange}
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
}
