import { memo } from "react";
import { Descriptions, Space, Tag, Tooltip } from "antd";
import { Link } from "react-router-dom";

import type { RequestLog } from "../../api/types";
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
  formatUSD,
  shortSession,
} from "../../utils/format";
import { REASONING_TONE, cacheRate, rowTone } from "./tone";

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
      {/* Only an administrator's rows carry the forwarded name. Boolean, not
          the string itself: an empty "" would render as a blank item. */}
      {Boolean(detail.upstream_model) && detail.upstream_model !== detail.model && (
        <Descriptions.Item label="上游模型">
          <span className="mono">{detail.upstream_model}</span>
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
        {/* Only an administrator's rows carry it, and only when a rule fired. */}
        {detail.upstream_status > 0 && (
          <Tooltip title="渠道的状态码映射改写了上游返回的状态码">
            <Tag>上游 {detail.upstream_status}</Tag>
          </Tooltip>
        )}
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
      {admin && (
        <Descriptions.Item label="来源 IP">
          {detail.client_ip ? (
            <Tooltip title="来自 X-Forwarded-For；直连本服务的调用方可以自行设置该头，仅供参考">
              <span className="mono">{detail.client_ip}</span>
            </Tooltip>
          ) : (
            <span className="text-muted">-</span>
          )}
        </Descriptions.Item>
      )}
      <Descriptions.Item label="Token 用量">
        输入 {formatNumber(detail.prompt_tokens)} · 输出{" "}
        {formatNumber(detail.completion_tokens)} · 合计{" "}
        {formatNumber(
          detail.total_tokens ||
            detail.prompt_tokens + detail.completion_tokens,
        )}
        {detail.prompt_estimated && <EstimatedTag />}
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
        {detail.prompt_estimated && <EstimatedTag />}
      </Descriptions.Item>
      <Descriptions.Item label="耗时">
        总计 {formatDuration(detail.duration_ms)}
        {detail.ttfb_ms > 0 && ` · 首字节 ${formatDuration(detail.ttfb_ms)}`}
      </Descriptions.Item>
      {admin && detail.session_id && (
        <Descriptions.Item label="会话">
          <Space size={8} wrap>
            <Tooltip title={detail.session_id}>
              <span className="mono">{shortSession(detail.session_id)}</span>
            </Tooltip>
            {detail.message_count > 0 && (
              <span className="text-muted">
                {detail.message_count} 条消息
                {detail.parent_id > 0 &&
                  `，新增 ${detail.message_count - detail.shared_messages} 条`}
              </span>
            )}
            <Link
              to={`/admin/sessions/${encodeURIComponent(detail.session_id)}?thread=${detail.thread_id}&call=${detail.id}`}
            >
              查看会话
            </Link>
            <Link to={`/admin/logs?session=${encodeURIComponent(detail.session_id)}`}>
              同会话日志
            </Link>
          </Space>
        </Descriptions.Item>
      )}
    </Descriptions>
  );
}

// EstimatedTag flags input tokens, and the cost built on them, as estimated.
function EstimatedTag() {
  return (
    <Tooltip title="上游未返回输入 token 数，按请求体估算并据此计费，误差约 ±30%">
      <Tag color="orange" style={{ marginInlineStart: 8 }}>
        输入为估算
      </Tag>
    </Tooltip>
  );
}

// The metadata is a wall of numbers that only changes when the opened row
// does; re-rendering it on every table tick is wasted work.
export default memo(LogMeta);
