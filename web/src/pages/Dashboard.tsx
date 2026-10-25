import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Col, Row, Segmented, Skeleton, Spin, Typography } from 'antd'
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
import { Link, useNavigate } from 'react-router-dom'

import { api, type Stats } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import type { ChartPoint } from '../components/UsageChart'
import UsageHeatmap from '../components/UsageHeatmap'
import {
  formatCompact,
  formatMoney,
  formatMoneyCompact,
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
  const navigate = useNavigate()
  const [days, setDays] = useState(0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped by the refresh button; the heatmap ignores the range switch.
  const [refreshes, setRefreshes] = useState(0)
  // Requests race: switching from a slow 90-day query to a fast one must not
  // let the stale answer land last and overwrite the fresh one.
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const params =
        days === 0
          ? { start: dayjs().startOf('day').toISOString(), interval: 'hour' }
          : { days, interval: days <= 2 ? 'hour' : 'day' }
      const result = isAdmin ? await api.admin.stats(params) : await api.stats(params)
      if (seq !== requestSeq.current) return
      setStats(result)
      setError(null)
    } catch (err) {
      if (seq !== requestSeq.current) return
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [days, isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  const series = useMemo<ChartPoint[]>(
    () =>
      (stats?.series ?? []).map((point) => ({
        label: dayjs(point.bucket).format(days <= 2 ? 'HH:mm' : 'MM-DD'),
        fullLabel: dayjs(point.bucket).format(days <= 2 ? 'MM-DD HH:mm' : 'YYYY-MM-DD'),
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

  const firstLoad = loading && !stats
  // A deployment with a single account has no user count to show, and the
  // row it leaves behind would be a hole in the grid.
  const singleUser = isAdmin && stats !== null && (stats.user_count ?? 0) <= 1
  // Five cards do not divide antd's 24-column grid, and its grid only ships
  // integer spans, so the fifth card takes its width from the stylesheet.
  const statSpan = isAdmin
    ? singleUser
      ? { xs: 12, sm: 12, md: 8 }
      : { xs: 12, sm: 12, md: 8, xl: 4 }
    : { xs: 12, md: 12, xl: 6 }
  const quotaEmpty = (user?.quota ?? 0) <= 0

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
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => {
                void load()
                setRefreshes((n) => n + 1)
              }}
            >
              刷新
            </Button>
          </>
        }
      />

      {/* Range switches keep the old numbers on screen; the spinner says a new
          answer is on its way. delay skips it entirely on fast responses. */}
      <Spin spinning={loading && Boolean(stats)} delay={200}>
        <Row gutter={[12, 12]} className={singleUser ? 'dashboard-stats--five' : undefined}>
          <Col {...statSpan}>
            <StatCard
              label={isAdmin ? '我的余额' : '账户余额'}
              value={formatMoneyCompact(user?.quota ?? 0)}
              tooltip={formatMoney(user?.quota ?? 0)}
              hint={
                quotaEmpty ? (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    余额已用尽，请充值后再调用
                  </Typography.Text>
                ) : (
                  `累计消费 ${formatMoney(user?.used_quota ?? 0)}`
                )
              }
              icon={<WalletOutlined />}
              tone={quotaEmpty ? 'danger' : 'brand'}
              loading={firstLoad}
            />
          </Col>
          <Col {...statSpan}>
            <StatCard
              label="区间消费"
              value={formatUSD(cost)}
              hint={requests ? `平均每次 ${formatUSD(cost / requests)}` : '暂无调用'}
              icon={<DollarOutlined />}
              tone="warning"
              loading={firstLoad}
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
              loading={firstLoad}
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
              loading={firstLoad}
            />
          </Col>
          {isAdmin && !singleUser && (
            <Col {...statSpan}>
              <StatCard
                label="用户数"
                value={formatNumber(stats?.user_count ?? 0)}
                hint="全站注册账号"
                icon={<TeamOutlined />}
                tone="neutral"
                loading={firstLoad}
              />
            </Col>
          )}
          {isAdmin && (
            <Col {...statSpan}>
              <StatCard
                label="渠道数"
                value={formatNumber(stats?.channel_count ?? 0)}
                hint={`其中启用 ${formatNumber(stats?.channel_enabled ?? 0)}`}
                icon={<ApiOutlined />}
                tone="neutral"
                loading={firstLoad}
              />
            </Col>
          )}
        </Row>

        <Card
          title="用量趋势"
          style={{ marginTop: 12 }}
          loading={firstLoad}
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {days <= 2 ? '按小时聚合' : '按天聚合'}
            </Typography.Text>
          }
        >
          {error ? (
            <EmptyState
              title="加载失败"
              description={error}
              action={
                <Button type="primary" icon={<ReloadOutlined />} onClick={() => void load()}>
                  重试
                </Button>
              }
            />
          ) : hasData ? (
            <div
              role="img"
              aria-label={`用量趋势：共 ${formatNumber(requests)} 次调用，消费 ${formatUSD(cost)}`}
            >
              <Suspense
                fallback={
                  <div style={{ height: 300 }}>
                    <Skeleton active paragraph={{ rows: 7 }} title={false} />
                  </div>
                }
              >
                <UsageChart data={series} showErrors={errors > 0} />
              </Suspense>
            </div>
          ) : (
            <EmptyState
              title="这段时间还没有调用记录"
              description="创建一个 API 密钥并发起请求后，这里会显示用量曲线。"
              action={
                isAdmin ? (
                  <Button type="primary" onClick={() => navigate('/admin/channels')}>
                    去配置渠道
                  </Button>
                ) : (
                  <Button type="primary" onClick={() => navigate('/tokens')}>
                    去创建密钥
                  </Button>
                )
              }
            />
          )}
        </Card>

        <UsageHeatmap admin={isAdmin} version={refreshes} />

        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} lg={isAdmin && !singleUser ? 8 : 24}>
            <RankCard
              title="模型排行"
              loading={firstLoad}
              rows={stats?.by_model ?? []}
              // An administrator ranks the model a call really went out as,
              // and the log's model filter matches the name that was asked
              // for — so the name goes in as a keyword.
              linkFor={(row) =>
                isAdmin
                  ? `/admin/logs?q=${encodeURIComponent(row.name)}`
                  : `/logs?model=${encodeURIComponent(row.name)}`
              }
            />
          </Col>
          {isAdmin && (
            <Col xs={24} lg={singleUser ? 12 : 8}>
              <RankCard
                title="渠道排行"
                loading={firstLoad}
                rows={stats?.by_channel ?? []}
                // A channel name is not a key, and the ranking carries no id
                // yet; the keyword is the closest thing to a link.
                linkFor={(row) => `/admin/logs?q=${encodeURIComponent(row.name)}`}
              />
            </Col>
          )}
          {isAdmin && !singleUser && (
            <Col xs={24} lg={8}>
              <RankCard
                title="用户排行"
                loading={firstLoad}
                rows={stats?.by_user ?? []}
                linkFor={(row) => `/admin/logs?username=${encodeURIComponent(row.name)}`}
              />
            </Col>
          )}
        </Row>
      </Spin>
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
  linkFor,
}: {
  title: string
  loading: boolean
  rows: RankRow[]
  /** Where a row leads: the log lines behind that name. */
  linkFor: (row: RankRow) => string
}) {
  const top = [...rows].sort((a, b) => b.cost - a.cost || b.requests - a.requests).slice(0, 8)
  // Free traffic still deserves proportional bars: fall back to request counts
  // when nothing in the list has cost anything.
  const byCost = top.some((row) => row.cost > 0)
  const max = Math.max(...top.map((row) => (byCost ? row.cost : row.requests)), 1)

  return (
    <Card
      title={title}
      loading={loading}
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {byCost ? '按消费排序' : '按调用排序'}
        </Typography.Text>
      }
      styles={{ body: { paddingBlock: top.length ? 6 : 20 } }}
    >
      {top.length ? (
        top.map((row) => (
          <Link className="rank-row" key={row.name} to={linkFor(row)}>
            <Typography.Text className="rank-row__name" ellipsis={{ tooltip: row.name }}>
              {row.name}
            </Typography.Text>
            {/* The headline number matches the sort key: a free deployment
                would otherwise show a column of "$0.0000". */}
            <span className="rank-row__value">
              {byCost ? formatUSD(row.cost) : `${formatNumber(row.requests)} 次`}
            </span>
            <span className="rank-row__bar">
              <span
                style={{
                  width: `${Math.max(((byCost ? row.cost : row.requests) / max) * 100, 2)}%`,
                }}
              />
            </span>
            <span className="rank-row__meta">
              {byCost
                ? `${formatNumber(row.requests)} 次 · ${formatCompact(row.total_tokens)} Token`
                : `${formatCompact(row.total_tokens)} Token`}
            </span>
          </Link>
        ))
      ) : (
        <EmptyState title="所选时间范围内没有调用" compact />
      )}
    </Card>
  )
}
