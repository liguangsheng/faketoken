import { Button, Dropdown, Space, Switch, Tag, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  BlockOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  FileSearchOutlined,
  InboxOutlined,
  ThunderboltOutlined,
  WalletOutlined,
  WarningOutlined,
} from '@ant-design/icons'

import type { Channel } from '../../../api/client'
import type { ChannelHealth, ChannelHealthMap } from '../../../api/types'
import { STATUS } from '../../../utils/format'
import { keepaliveTag } from './shared'
import type { ChannelActions } from './useChannelActions'

/**
 * The row menu, shared by the desktop table and the phone card.
 *
 * One list, one handler: a control that exists on one layout and not the other
 * is a control somebody will report missing.
 */
export function channelMenu(
  actions: ChannelActions,
  row: Channel,
): { items: MenuProps['items']; onClick: MenuProps['onClick'] } {
  return {
    items: [
      { key: 'edit', icon: <EditOutlined />, label: '编辑渠道' },
      { key: 'logs', icon: <FileSearchOutlined />, label: '查看日志' },
      { type: 'divider' },
      { key: 'test', icon: <ThunderboltOutlined />, label: '模型测试' },
      { key: 'models', icon: <CloudDownloadOutlined />, label: '拉取模型' },
      { type: 'divider' },
      { key: 'credential', icon: <CopyOutlined />, label: '复制地址与密钥' },
      { key: 'clone', icon: <BlockOutlined />, label: '克隆渠道' },
      { type: 'divider' },
      { key: 'balance-new-api', icon: <WalletOutlined />, label: 'new-api 余额' },
      { key: 'balance-sub2api', icon: <WalletOutlined />, label: 'sub2api 余额' },
      { type: 'divider' },
      // Its own group next to deletion: both retire a channel,
      // but only one of them is irreversible.
      { key: 'archive', icon: <InboxOutlined />, label: '归档渠道' },
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除渠道', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'edit') actions.openDrawer(row)
      else if (key === 'logs') actions.viewLogs(row)
      else if (key === 'test') actions.setTestTarget(row)
      else if (key === 'models') void actions.fetchModels(row)
      else if (key === 'balance-new-api') void actions.showBalance(row, 'new-api')
      else if (key === 'balance-sub2api') void actions.showBalance(row, 'sub2api')
      else if (key === 'credential') void actions.copyCredential(row)
      else if (key === 'clone') void actions.cloneChannel(row)
      else if (key === 'archive') actions.archiveChannel(row)
      else if (key === 'delete') actions.removeChannel(row)
    },
  }
}

/** The button that opens the row menu. */
export function channelMenuButton(actions: ChannelActions, row: Channel) {
  return (
    <Dropdown menu={channelMenu(actions, row)} trigger={['click']}>
      <Button
        size="small"
        type="text"
        icon={<EllipsisOutlined />}
        aria-label={`更多操作 ${row.name}`}
      />
    </Dropdown>
  )
}

/**
 * The window in which a channel is failing, if any.
 *
 * The lifetime counters on the row cannot answer this: a channel that failed
 * last month keeps a red rate forever, and one that started failing this
 * morning is buried under a thousand good calls. Two recent windows can:
 * an hour for the sudden outage, a day for the slow decay.
 */
const failingWindow = (health?: ChannelHealth): keyof ChannelHealth | undefined => {
  if (!health) return undefined
  const { hour, day } = health
  if (hour.attempts >= 5 && hour.failures / hour.attempts >= 0.5) return 'hour'
  if (day.attempts >= 10 && day.failures / day.attempts >= 0.2) return 'day'
  return undefined
}

export const failingNow = (health?: ChannelHealth) => failingWindow(health) !== undefined

const WINDOW_LABEL = { hour: '近 1 小时', day: '近 24 小时' } as const

// Quotes the window that raised the warning: "近 1 小时 0/2 失败" beside a red
// tag set off by the day reads as a bug.
const healthText = (health?: ChannelHealth) => {
  if (!health) return '近期没有调用'
  const span = failingWindow(health) ?? (health.hour.attempts > 0 ? 'hour' : 'day')
  const { attempts, failures } = health[span]
  if (attempts === 0) return '近期没有调用'
  return `${WINDOW_LABEL[span]} ${failures}/${attempts} 失败`
}

/**
 * The phone layout: one channel per card.
 *
 * A table on a 390px screen is read by swiping sideways, and the column that
 * matters — the name, the switch, the menu — is the one that goes off screen
 * first. The card puts those three on the first line and the rest underneath.
 */
export function channelCardColumns({
  actions,
  togglingId,
  health,
}: {
  actions: ChannelActions
  togglingId: number | null
  health: ChannelHealthMap
}): ColumnsType<Channel> {
  return [
    {
      key: 'card',
      render: (_: unknown, row: Channel) => {
        const recent = health[String(row.id)]
        const keepalive = keepaliveTag(row)
        return (
          <div className="channel-card">
            <div className="channel-card__top">
              <div className="channel-card__title">
                <span className="channel-card__name">{row.name}</span>
                <span className="channel-card__id">#{row.id}</span>
              </div>
              <Space size={6}>
                <Tooltip title={row.status === STATUS.ENABLED ? '点击停用' : '点击启用'}>
                  <Switch
                    size="small"
                    checked={row.status === STATUS.ENABLED}
                    loading={togglingId === row.id}
                    aria-label={`启用或禁用渠道 ${row.name}`}
                    onChange={(next) =>
                      void actions.setStatus(row, next ? STATUS.ENABLED : STATUS.DISABLED)
                    }
                  />
                </Tooltip>
                {channelMenuButton(actions, row)}
              </Space>
            </div>
            <div className="channel-card__url mono">{row.base_url}</div>
            <div className="channel-card__meta">
              <span>
                优先级 {row.priority} · 权重 {row.weight}
              </span>
              <span>模型 {row.models.length}</span>
              <span className={failingNow(recent) ? 'channel-card__health--bad' : undefined}>
                {failingNow(recent) && (
                  <WarningOutlined style={{ color: 'var(--app-danger)' }} aria-label="近期失败率高" />
                )}
                {healthText(recent)}
              </span>
              {failingNow(recent) && <Tag color="error">近期失败率高</Tag>}
              {/* Same reason as the table: the switch above moves on its own. */}
              {keepalive && (
                <Tooltip title={keepalive.hint}>
                  <Tag color={keepalive.color}>{keepalive.text}</Tag>
                </Tooltip>
              )}
            </div>
          </div>
        )
      },
    },
  ]
}
