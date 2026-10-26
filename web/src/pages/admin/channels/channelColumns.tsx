import {
  Button,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  DeleteOutlined,
  EditOutlined,
  RollbackOutlined,
  WarningOutlined,
} from '@ant-design/icons'

import type { Channel } from '../../../api/client'
import type { ChannelHealth, ChannelHealthMap } from '../../../api/types'
import { type TableGeometry } from '../../../hooks/useTableScrollX'
import {
  formatMoney,
  formatNumber,
  formatRelative,
  stringifyMapping,
  STATUS,
} from '../../../utils/format'
import InlineNumber from './InlineNumber'
import {
  keepaliveTag,
  MAX_PRIORITY,
  MAX_WEIGHT,
  MIN_PRIORITY,
  MIN_WEIGHT,
  statusHint,
} from './shared'
import { channelMenuButton, failingNow } from './channelCards'
import type { ChannelActions } from './useChannelActions'

/**
 * Breakpoints here were already chosen; what was missing is a `scroll.x` that
 * follows them. Which channel it is and whether it is enabled stay at every
 * width — the status switch is how a bad upstream is taken out of rotation,
 * and that should not require widening the window first.
 *
 * `selection` and `expand` are antd's own columns: rendered on every row but
 * never declared in `columns`, so they are counted here or the sum is short
 * by their width. Both follow the theme's controlHeight of 34.
 */
export const COLUMN_GEOMETRY = {
  selection: { width: 34 },
  expand: { width: 48 },
  id: { width: 72 },
  name: { width: 300 },
  status: { width: 104 },
  actions: { width: 72 },
  models: { width: 220, responsive: ['md'] },
  routing: { width: 80, responsive: ['md'] },
  usedQuota: { width: 90, responsive: ['lg'] },
  groups: { width: 100, responsive: ['xl'] },
  health: { width: 120, responsive: ['xl'] },
} satisfies TableGeometry

interface ChannelColumnsOptions {
  actions: ChannelActions
  /** The row whose status switch is mid-flight. */
  togglingId: number | null
  /** Recent failures per channel, by id. */
  health: ChannelHealthMap
}

// Counted per attempt: a request that fails here and succeeds on a backup
// still counts against this channel.
const healthHint = (health?: ChannelHealth) =>
  health
    ? `近 1 小时 ${health.hour.failures}/${health.hour.attempts} 次尝试失败，近 24 小时 ${health.day.failures}/${health.day.attempts} 次尝试失败`
    : '近期没有调用记录'

export function channelColumns({
  actions,
  togglingId,
  health,
}: ChannelColumnsOptions): ColumnsType<Channel> {
  return [
    {
      // The id is what the logs show, so it has to be findable here too.
      // No sorter: the list is server-paginated, and reordering one page
      // silently poses as a global ranking.
      ...COLUMN_GEOMETRY.id,
      title: 'ID',
      dataIndex: 'id',
      render: (id: number) => (
        <Tag className="mono" style={{ marginInlineEnd: 0 }}>
          #{id}
        </Tag>
      ),
    },
    {
      // Keep this column compact instead of letting it absorb all remaining
      // table width. Long names and addresses still use ellipsis + Tooltip.
      ...COLUMN_GEOMETRY.name,
      title: '渠道',
      dataIndex: 'name',

      render: (name: string, row) => (
        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Tooltip title={name}>
              <strong
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {name}
              </strong>
            </Tooltip>
          </div>
          <div style={{ minWidth: 0 }}>
            <Tooltip title={row.base_url}>
              <span
                className="mono text-muted"
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.base_url}
              </span>
            </Tooltip>
          </div>
        </div>
      ),
    },
    {
      // Sits next to the channel it belongs to: what a channel serves is
      // read together with which channel it is, not with the counters.
      // Bounded so the leftover width goes to the channel name — this
      // column only ever shows two counts plus two sample chips.
      //
      // Both counts lead, then the samples: the numbers are what the
      // column is scanned for and they sit at a fixed spot on every row,
      // while the sample chips are ragged and variable.
      //
      // No "+N" tag behind the samples. Once the count leads, a row
      // reading "模型 12" next to two chips already says the list is cut
      // short; a third tag repeating it only crowds the row. The full
      // list it used to carry now hangs off the count itself, which is
      // also what the mapping tag does.
      //
      // Every tag reads "标签 数字": a bare "12 个" needed the header to
      // say what was being counted, which stops working as soon as a
      // second count sits beside it.
      ...COLUMN_GEOMETRY.models,
      title: '模型',
      dataIndex: 'models',
      render: (list: string[], row) => {
        const mapped = Object.keys(row.model_mapping ?? {}).length
        return (
          <div className="tag-list">
            <Tooltip
              title={
                // A hundred-model tooltip is an unreadable wall; the
                // full list lives in the expanded row.
                list.length > 20
                  ? `${list.slice(0, 20).join('、')} …等 ${list.length} 个，展开行查看全部`
                  : list.join('、') || '未配置，仅按前缀匹配'
              }
            >
              <Tag color="geekblue">模型 {list.length}</Tag>
            </Tooltip>
            {mapped > 0 && (
              <Tooltip title={stringifyMapping(row.model_mapping)}>
                <Tag color="purple">映射 {mapped}</Tag>
              </Tooltip>
            )}
            {list.slice(0, 2).map((item) => (
              <Tooltip key={item} title={item}>
                <Tag
                  className="mono"
                  style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {item}
                </Tag>
              </Tooltip>
            ))}
          </div>
        )
      },
    },
    {
      // Stacked rather than side by side: two labelled numbers read fine
      // one above the other, and it lets the column be sized for a
      // three-digit value instead of for a pair of tags on one line.
      //
      // The header is abbreviated because it was the only thing keeping
      // the column wide — "优先级" plus the sort arrow costs more than the
      // value it labels. What each line means is in the tag tooltips, and
      // the P/W prefixes carry it at a glance.
      title: (
        <span className="cell-stack">
          <span>优先</span>
          <span>权重</span>
        </span>
      ),
      ...COLUMN_GEOMETRY.routing,
      dataIndex: 'priority',
      render: (priority: number, row) => (
        <div className="cell-stack">
          <InlineNumber
            value={priority}
            prefix="P"
            label="优先级"
            hint="优先级：数值越大越先被选中。点击可直接修改"
            color="blue"
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            onCommit={(next) => actions.saveRouting(row, next, row.weight)}
          />
          <InlineNumber
            value={row.weight}
            prefix="W"
            label="权重"
            hint="权重：同优先级内按权重随机分配。点击可直接修改"
            min={MIN_WEIGHT}
            max={MAX_WEIGHT}
            onCommit={(next) => actions.saveRouting(row, row.priority, next)}
          />
        </div>
      ),
    },
    {
      ...COLUMN_GEOMETRY.groups,
      title: '分组',
      dataIndex: 'groups',
      render: (list: string[]) => (
        <div className="tag-list">
          {list?.map((group) => (
            <Tooltip key={group} title={group}>
              <Tag style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {group}
              </Tag>
            </Tooltip>
          ))}
        </div>
      ),
    },
    {
      // xl, not xxl: channel health is what this table is scanned for,
      // and a 1440px laptop should not have to hide it.
      ...COLUMN_GEOMETRY.health,
      title: '调用 / 失败',
      align: 'right',
      render: (_, row) => {
        return (
          <Tooltip
            title={
              row.last_error
                ? `最近错误：${row.last_error}（${formatRelative(row.last_error_at)}）`
                : '暂无错误记录'
            }
          >
            {/* One line: a count broken across two lines reads as two
                numbers, and the failure count is the one being compared. */}
            <Space size={4} style={{ whiteSpace: 'nowrap' }}>
              {failingNow(health[String(row.id)]) && (
                <Tooltip title={healthHint(health[String(row.id)])}>
                  <WarningOutlined
                    style={{ color: 'var(--app-danger)' }}
                    aria-label="近期失败率高"
                  />
                </Tooltip>
              )}
              <span>{formatNumber(row.request_count)}</span>
              <span className="text-muted">/</span>
              <Typography.Text type={row.error_count ? 'danger' : 'secondary'}>
                {formatNumber(row.error_count)}
              </Typography.Text>
            </Space>
          </Tooltip>
        )
      },
    },
    {
      ...COLUMN_GEOMETRY.usedQuota,
      title: '消费',
      dataIndex: 'used_quota',
      align: 'right',
      render: (value: number) => formatMoney(value),
    },
    {
      // Sits next to the actions it belongs with, and unlike the other
      // secondary columns it has no breakpoint: this is a control, and
      // taking a bad channel out of rotation should not require widening
      // the window first.
      ...COLUMN_GEOMETRY.status,
      title: '状态',
      dataIndex: 'status',
      render: (_: number, row) => {
        const keepalive = keepaliveTag(row)
        return (
          <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
            <Tooltip title={statusHint(row)}>
              {/* A plain span keeps the tooltip anchored while the switch
                  is loading and stops accepting pointer events. */}
              <span style={{ display: 'inline-flex' }}>
                <Switch
                  size="small"
                  checked={row.status === STATUS.ENABLED}
                  loading={togglingId === row.id}
                  aria-label={`启用或禁用渠道 ${row.name}`}
                  onChange={(next) =>
                    void actions.setStatus(row, next ? STATUS.ENABLED : STATUS.DISABLED)
                  }
                />
              </span>
            </Tooltip>
            {/* Under the switch on purpose: this channel's status changes
                on its own, and without a marker the next operator to look
                assumes a colleague flipped it. */}
            {keepalive && (
              <Tooltip title={keepalive.hint}>
                <Tag
                  color={keepalive.color}
                  style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}
                >
                  {keepalive.text}
                </Tag>
              </Tooltip>
            )}
          </div>
        )
      },
    },
    {
      // Pinned to the right: the row menu is the one control that has to be
      // reachable at any width, and the table is wider than the window.
      ...COLUMN_GEOMETRY.actions,
      fixed: 'right',
      title: '操作',
      render: (_, row) => <Space size={0}>{channelMenuButton(actions, row)}</Space>,
    },
  ]
}

interface ArchivedColumnsOptions {
  actions: ChannelActions
  /** The row whose unarchive is still running. */
  archivingId: number | null
}

/** The shelf below the listing. Shorter, and without the ⋯ menu. */
export function archivedColumns({
  actions,
  archivingId,
}: ArchivedColumnsOptions): ColumnsType<Channel> {
  return [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 72,
      render: (id: number) => (
        <Tag className="mono" style={{ marginInlineEnd: 0 }}>
          #{id}
        </Tag>
      ),
    },
    {
      title: '渠道',
      dataIndex: 'name',
      render: (name: string, row) => (
        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <Tooltip title={name}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </strong>
          </Tooltip>
          <Tooltip title={row.base_url}>
            <span
              className="mono text-muted"
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.base_url}
            </span>
          </Tooltip>
        </div>
      ),
    },
    {
      title: '模型',
      dataIndex: 'models',
      width: 84,
      responsive: ['md'],
      // Same tag wording as the main listing, so the archive
      // shelf does not read as a different table.
      render: (list: string[]) => <Tag color="geekblue">模型 {list.length}</Tag>,
    },
    {
      title: '消费',
      dataIndex: 'used_quota',
      width: 90,
      align: 'right',
      responsive: ['lg'],
      render: (value: number) => formatMoney(value),
    },
    {
      // Plain buttons rather than the listing's ⋯ menu: three
      // actions on a short list are better shown than hidden.
      title: '操作',
      width: 168,
      render: (_, row) => (
        <Space size={0}>
          <Tooltip title="恢复到上方列表，状态仍为禁用">
            <Button
              size="small"
              type="text"
              icon={<RollbackOutlined />}
              loading={archivingId === row.id}
              onClick={() => void actions.unarchiveChannel(row)}
            >
              取消归档
            </Button>
          </Tooltip>
          <Tooltip title="编辑渠道">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label={`编辑渠道 ${row.name}`}
              onClick={() => actions.openDrawer(row)}
            />
          </Tooltip>
          <Tooltip title="删除渠道">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={`删除渠道 ${row.name}`}
              onClick={() => actions.removeChannel(row)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]
}
