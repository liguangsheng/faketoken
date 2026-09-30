import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Input, Select, Typography } from 'antd'

import { api } from '../../api/client'
import type { Channel } from '../../api/types'
import { normalizeHost } from '../../components/playground/target'
import { STATUS } from '../../utils/format'

// Where a test call goes: `auto` leaves the choice to the relay, a channel id
// pins the relay to that channel, `manual` skips this site for an upstream
// typed in by hand.
export const AUTO_ROUTE = 'auto'
export const MANUAL_ROUTE = 'manual'

export interface ResolvedRoute {
  /** The channel the relay is pinned to. */
  pinned?: Channel
  manual: boolean
  /** '' unless manual; null when what was typed is not an address. */
  upstreamBase: string | null
}

export const resolveRoute = (route: string, channels: Channel[], upstream: string): ResolvedRoute => {
  const manual = route === MANUAL_ROUTE
  return {
    pinned: channels.find((channel) => String(channel.id) === route),
    manual,
    upstreamBase: manual ? normalizeHost(upstream) : '',
  }
}

/**
 * Whether the relay would send this model to the channel. Mirrors how routing
 * is built server-side: listed models, mapped names, then prefixes.
 */
export const servesModel = (channel: Channel, name?: string): boolean =>
  !!name &&
  (channel.models.includes(name) ||
    Object.keys(channel.model_mapping ?? {}).includes(name) ||
    channel.model_prefixes.some((prefix) => name.startsWith(prefix)))

/** The channels an administrator can pin a test to; archived ones are left out. */
export const useChannels = (enabled: boolean) => {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.admin
      .listChannels({ page_size: 200, archived: false })
      .then((page) => live && setChannels(page.data ?? []))
      // Without the list only auto and manual remain, which still work.
      .catch(() => undefined)
      .finally(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [enabled])
  return { channels, loaded }
}

export default function RouteField({
  route,
  onRouteChange,
  channels,
  model,
  upstream,
  onUpstreamChange,
}: {
  route: string
  onRouteChange: (route: string) => void
  channels: Channel[]
  model?: string
  upstream: string
  onUpstreamChange: (value: string) => void
}) {
  const { pinned, manual, upstreamBase } = resolveRoute(route, channels, upstream)

  // The two fixed choices lead, so they are not buried under dozens of
  // channels; of those, the ones serving the chosen model come first.
  const options = useMemo(() => {
    const option = (channel: Channel) => {
      const enabled = channel.status === STATUS.ENABLED
      return {
        value: String(channel.id),
        label: `#${channel.id} ${channel.name}${enabled ? '' : '（已停用）'}`,
        // The relay refuses a pin to a disabled channel.
        disabled: !enabled,
      }
    }
    const serving = channels.filter((channel) => servesModel(channel, model))
    const others = channels.filter((channel) => !servesModel(channel, model))
    return [
      { value: AUTO_ROUTE, label: '自动（按模型和分组选路）' },
      { value: MANUAL_ROUTE, label: '手填上游地址…' },
      ...(serving.length ? [{ label: `提供 ${model} 的渠道`, options: serving.map(option) }] : []),
      ...(others.length
        ? [{ label: serving.length ? '其他渠道' : '渠道', options: others.map(option) }]
        : []),
    ]
  }, [channels, model])

  let hint: ReactNode = '和线上调用一样，按模型和密钥的分组选渠道。'
  let hintType: 'secondary' | 'warning' | 'danger' = 'secondary'
  if (manual) {
    if (upstreamBase === null) {
      hint = '地址读不出来，填成 https://api.example.com 这样'
      hintType = 'danger'
    } else {
      hint = '经本站服务端直连上游：不走任何渠道配置，不计费、不记日志。'
    }
  } else if (pinned) {
    if (servesModel(pinned, model)) {
      hint = '只走这个渠道。模型映射、请求头、代理照常生效，计费和日志也照常。'
    } else {
      hint = `这个渠道不提供 ${model ?? '所选模型'}，请求会被本站拒绝。`
      hintType = 'warning'
    }
  }

  return (
    <div>
      <label className="field-label" htmlFor="img-route">
        渠道
      </label>
      <Select
        id="img-route"
        showSearch
        optionFilterProp="label"
        style={{ marginTop: 6, width: '100%' }}
        value={route}
        onChange={onRouteChange}
        options={options}
      />
      {manual && (
        <Input
          id="img-upstream"
          allowClear
          style={{ marginTop: 8 }}
          status={upstreamBase === null ? 'error' : undefined}
          placeholder="上游地址，如 https://api.example.com"
          value={upstream}
          onChange={(event) => onUpstreamChange(event.target.value)}
        />
      )}
      <Typography.Text type={hintType} style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
        {hint}
      </Typography.Text>
    </div>
  )
}
