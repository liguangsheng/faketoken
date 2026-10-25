import {
  Button,
  Card,
  Col,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined } from '@ant-design/icons'

import type { Channel } from '../../../api/client'
import {
  formatTime,
  stringifyEffortRules,
  stringifyMapping,
} from '../../../utils/format'
import { AUTH_STYLES, TEST_PROTOCOLS, type TestProtocol } from './shared'

interface Props {
  row: Channel
  onClearUserAgent: (channel: Channel, protocol: TestProtocol) => Promise<void>
}

/**
 * The expanded row: everything the columns had to shorten, in full and
 * copyable. Kept out of the column definitions because it is not one — antd
 * draws it below the row, at full width.
 */
export default function ChannelExpandedRow({ row, onClearUserAgent }: Props) {
  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={6}>
        <Card size="small" title="连接">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Typography.Text className="mono" copyable>
              {row.base_url}
            </Typography.Text>
            <span className="mono text-muted">密钥 {row.api_key || '未设置'}</span>
            {row.proxy_url && <span className="mono text-muted">代理 {row.proxy_url}</span>}
            <span className="text-muted" style={{ fontSize: 12 }}>
              超时 {row.timeout_secs ? `${row.timeout_secs}s` : '全局默认'} · 计费倍率 ×
              {row.price_ratio}
            </span>
            <span className="text-muted" style={{ fontSize: 12 }}>
              渠道重试 {row.retry_count ? `${row.retry_count} 次` : '关闭'} · 间隔{' '}
              {row.retry_backoff_ms ? `${row.retry_backoff_ms}ms` : '全局默认'}
            </span>
            {Object.keys(row.status_code_mapping ?? {}).length > 0 && (
              <span className="text-muted mono" style={{ fontSize: 12 }}>
                状态码{' '}
                {Object.entries(row.status_code_mapping)
                  .map(([from, to]) => `${from}→${to}`)
                  .join(' · ')}
              </span>
            )}
            <span className="text-muted" style={{ fontSize: 12 }}>
              鉴权{' '}
              {AUTH_STYLES.find((item) => item.value === row.auth_style)?.label ?? row.auth_style}
            </span>
            {row.supported_protocols && row.supported_protocols.length < 3 && (
              <span className="text-muted" style={{ fontSize: 12 }}>
                协议{' '}
                {row.supported_protocols
                  .map((p) => TEST_PROTOCOLS.find((t) => t.value === p)?.label ?? p)
                  .join(' / ')}
              </span>
            )}
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card size="small" title={`模型（${row.models.length}）`}>
          {/* The one place the full list is readable and copyable —
              the column tooltip only carries a sample. */}
          {row.models.length ? (
            <Typography.Paragraph
              copyable={{ text: row.models.join('\n'), tooltips: ['复制全部模型', '已复制'] }}
              style={{ marginBottom: 0 }}
            >
              <span
                className="mono"
                style={{
                  display: 'block',
                  fontSize: 12,
                  lineHeight: 1.8,
                  maxHeight: 120,
                  overflow: 'auto',
                }}
              >
                {row.models.join('\n')}
              </span>
            </Typography.Paragraph>
          ) : (
            <span className="text-muted">未配置，仅按前缀匹配</span>
          )}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card size="small" title="模型映射">
          <pre className="code-block" style={{ maxHeight: 120 }}>
            {stringifyMapping(row.model_mapping) || '未配置'}
          </pre>
        </Card>
        <Card size="small" title="思考强度映射" style={{ marginTop: 12 }}>
          <pre className="code-block" style={{ maxHeight: 120 }}>
            {stringifyEffortRules(row.reasoning_effort_mapping) || '未配置'}
          </pre>
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card size="small" title="运行状态">
          <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
            <span>最近测试：{row.tested_at ? formatTime(row.tested_at) : '从未测试'}</span>
            <span>
              模型同步：{row.models_synced_at ? formatTime(row.models_synced_at) : '从未同步'}
            </span>
            <span style={{ color: row.last_error ? 'var(--app-danger)' : undefined }}>
              {row.last_error || '无错误记录'}
            </span>
            {row.note && <span className="text-muted">备注：{row.note}</span>}
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card
          size="small"
          title="User-Agent 锁定"
          extra={
            <Space size={4}>
              {row.lock_user_agent && <Tag color="green">自动锁定</Tag>}
              {Object.values(row.locked_user_agents ?? {}).some(Boolean) ? (
                <Tag color="blue">已有配置</Tag>
              ) : (
                <Tag>暂无配置</Tag>
              )}
            </Space>
          }
        >
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {TEST_PROTOCOLS.map((protocol) => {
              const value = row.locked_user_agents?.[protocol.value] ?? ''
              return (
                <div
                  key={protocol.value}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}
                >
                  <Typography.Text type="secondary" style={{ minWidth: 92 }}>
                    {protocol.label}
                  </Typography.Text>
                  <Typography.Text
                    className="mono"
                    type={value ? undefined : 'secondary'}
                    ellipsis={{ tooltip: value || '尚未锁定' }}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {value || '尚未锁定'}
                  </Typography.Text>
                  <Tooltip title={value ? '清除该协议的 UA 配置' : '当前没有可清除的 UA'}>
                    <Button
                      type="text"
                      size="small"
                      danger
                      disabled={!value}
                      icon={<DeleteOutlined />}
                      aria-label={`清除 ${protocol.label} User-Agent`}
                      onClick={() => onClearUserAgent(row, protocol.value)}
                    />
                  </Tooltip>
                </div>
              )
            })}
          </Space>
        </Card>
      </Col>
    </Row>
  )
}
