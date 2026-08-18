import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Card,
  Col,
  Row,
  Segmented,
  Skeleton,
  Tooltip as AntTooltip,
  Typography,
} from 'antd'
import {
  ApiOutlined,
  BarChartOutlined,
  DollarOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  TeamOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'

import { api, type Stats } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import type { ChartPoint } from '../components/UsageChart'
import { useThemeMode } from '../theme/ThemeProvider'
import {
  formatCompact,
  formatMoney,
  formatNumber,
  formatPercent,
  formatUSD,
  toUSD,
} from '../utils/format'

const UsageChart = lazy(() => import('../components/UsageChart'))

// Zero represents today; the other values are rolling backend windows.
const RANGES = [
  { value: 0, label: '今日' },
  { value: 1, label: '24 小时' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

export default function Dashboard() {
  const { user, isAdmin } = useAuth()
  const { resolved } = useThemeMode()
  const { message } = App.useApp()
  const [days, setDays] = useState(0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params =
        days === 0
          ? { start: dayjs().startOf('day').toISOString(), interval: 'hour' }
          : { days, interval: days <= 2 ? 'hour' : 'day' }
      setStats(isAdmin ? await api.admin.stats(params) : await api.stats(params))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [days, isAdmin, message])

  useEffect(() => {
    void load()
  }, [load])

  const series = useMemo<ChartPoint[]>(
    () =>
      (stats?.series ?? []).map((point) => ({
        label: dayjs(point.bucket).format(days <= 2 ? 'HH:mm' : 'MM-DD'),
        requests: point.requests,
        errors: point.errors,
        costUsd: toUSD(point.cost),
      })),
    [stats, days],
  )

  const summary = stats?.summary
  const requests = summary?.requests ?? 0
  const errors = summary?.errors ?? 0
  const cost = summary?.cost ?? 0
  const tokens = summary?.total_tokens ?? 0
  const successRate = requests ? (requests - errors) / requests : 1
  const hasData = series.some((point) => point.requests > 0 || point.costUsd > 0)

  const dark = resolved === 'dark'

  const statSpan = isAdmin ? { xs: 12, sm: 12, md: 8, xl: 4 } : { xs: 12, md: 12, xl: 6 }

  return (
    <>
      <PageHeader
        title="仪表盘"
        description={
          isAdmin ? '全站的调用量、消费与渠道健康度' : '你的调用量、消费与账户余额'
        }
        extra={
          <>
            <Segmented
              value={days}
              onChange={(value) => setDays(Number(value))}
              options={RANGES}
            />
            <AntTooltip title="刷新">
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
            </AntTooltip>
          </>
        }
      />

      <Row gutter={[12, 12]}>
        <Col {...statSpan}>
          <StatCard
            label="账户余额"
            value={formatMoney(user?.quota ?? 0)}
            hint={`累计消费 ${formatMoney(user?.used_quota ?? 0)}`}
            icon={<WalletOutlined />}
            tone={(user?.quota ?? 0) > 0 ? 'brand' : 'danger'}
            loading={loading && !stats}
          />
        </Col>
        <Col {...statSpan}>
          <StatCard
            label="区间消费"
            value={formatUSD(cost)}
            hint={requests ? `平均每次 ${formatUSD(cost / requests, 5)}` : '暂无调用'}
            icon={<DollarOutlined />}
            tone="warning"
            loading={loading && !stats}
          />
        </Col>
        <Col {...statSpan}>
          <StatCard
            label="调用次数"
            value={formatNumber(requests)}
            hint={
              errors ? (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  失败 {formatNumber(errors)} 次 · 成功率 {formatPercent(successRate)}
                </Typography.Text>
              ) : (
                requests ? '全部成功' : '暂无调用'
              )
            }
            icon={<ThunderboltOutlined />}
            tone={errors ? 'danger' : 'success'}
            loading={loading && !stats}
          />
        </Col>
        <Col {...statSpan}>
          <StatCard
            label="消耗 Token"
            value={formatCompact(tokens)}
            hint={requests ? `平均每次 ${formatCompact(tokens / requests)}` : '暂无调用'}
            icon={<BarChartOutlined />}
            tone="neutral"
            tooltip={formatNumber(tokens)}
            loading={loading && !stats}
          />
        </Col>
        {isAdmin && (
          <>
            <Col {...statSpan}>
              <StatCard
                label="用户数"
                value={formatNumber(stats?.user_count ?? 0)}
                hint="全站注册账号"
                icon={<TeamOutlined />}
                tone="neutral"
                loading={loading && !stats}
              />
            </Col>
            <Col {...statSpan}>
              <StatCard
                label="渠道数"
                value={formatNumber(stats?.channel_count ?? 0)}
                hint="已配置的上游渠道"
                icon={<ApiOutlined />}
                tone="neutral"
                loading={loading && !stats}
              />
            </Col>
          </>
        )}
      </Row>

      <Card
        title="用量趋势"
        style={{ marginTop: 12 }}
        loading={loading && !stats}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {days <= 2 ? '按小时聚合' : '按天聚合'}
          </Typography.Text>
        }
      >
        {hasData ? (
          <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} title={false} />}>
            <UsageChart data={series} dark={dark} showErrors={errors > 0} />
          </Suspense>
        ) : (
          <EmptyState
            title="这段时间还没有调用记录"
            description="创建一个 API 密钥并发起请求后，这里会显示用量曲线。"
          />
        )}
      </Card>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={isAdmin ? 8 : 24}>
          <RankCard title="模型排行" loading={loading && !stats} rows={stats?.by_model ?? []} />
        </Col>
        {isAdmin && (
          <Col xs={24} lg={8}>
            <RankCard title="渠道排行" loading={loading && !stats} rows={stats?.by_channel ?? []} />
          </Col>
        )}
        {isAdmin && (
          <Col xs={24} lg={8}>
            <RankCard title="用户排行" loading={loading && !stats} rows={stats?.by_user ?? []} />
          </Col>
        )}
      </Row>
    </>
  )
}

interface RankRow {
  name: string
  requests: number
  cost: number
  total_tokens: number
}

function RankCard({
  title,
  rows,
  loading,
}: {
  title: string
  loading: boolean
  rows: RankRow[]
}) {
  const top = [...rows].sort((a, b) => b.cost - a.cost || b.requests - a.requests).slice(0, 8)
  const max = Math.max(...top.map((row) => row.cost), 1)

  return (
    <Card title={title} loading={loading} styles={{ body: { paddingBlock: top.length ? 6 : 20 } }}>
      {top.length ? (
        top.map((row) => (
          <div className="rank-row" key={row.name}>
            <AntTooltip title={row.name}>
              <span className="rank-row__name">{row.name}</span>
            </AntTooltip>
            <span className="rank-row__value">{formatUSD(row.cost)}</span>
            <span className="rank-row__bar">
              <span style={{ width: `${Math.max((row.cost / max) * 100, 2)}%` }} />
            </span>
            <span className="rank-row__meta">
              {formatNumber(row.requests)} 次 · {formatCompact(row.total_tokens)} tokens
            </span>
          </div>
        ))
      ) : (
        <EmptyState title="所选时间范围内没有调用" compact />
      )}
    </Card>
  )
}
