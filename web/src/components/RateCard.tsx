import { useEffect, useRef, useState } from 'react'
import { Tooltip } from 'antd'

import { useCountUp } from '../hooks/useCountUp'
import { formatNumber } from '../utils/format'

interface Props {
  label: string
  value: number
  /** Applied to the tweened number, so tokens can render as "12.3k". */
  format?: (value: number) => string
  /** False parks the chip at zero and stops the motion. */
  active: boolean
  /** Why the meter is parked, surfaced on hover instead of on the page. */
  idleHint?: string
}

/** How long the bump lasts; must stay in step with the CSS keyframes. */
const BUMP_MS = 460

/**
 * One live meter, sized to sit in a toolbar rather than claim a row. The
 * number eases toward each new reading and kicks when it changes, while the
 * chip breathes — enough to read as alive at a glance without taking space
 * from the table it describes.
 */
export default function RateCard({ label, value, format = formatNumber, active, idleHint }: Props) {
  const target = active ? value : 0
  const shown = useCountUp(target)

  const [bumped, setBumped] = useState(false)
  const previous = useRef(target)

  useEffect(() => {
    // Skip the mount so the chip settles quietly instead of firing on load.
    if (previous.current === target) return
    previous.current = target
    if (!active) return

    setBumped(true)
    const timer = window.setTimeout(() => setBumped(false), BUMP_MS)
    return () => window.clearTimeout(timer)
  }, [target, active])

  return (
    <Tooltip title={active ? '滚动 60 秒窗口 · 仅统计当前首页可见记录' : idleHint}>
      <div className={`rate-chip${active ? ' rate-chip--live' : ''}`}>
        <span className="rate-chip__dot" />
        <span className="rate-chip__label">{label}</span>
        <span className={`rate-chip__value${bumped ? ' rate-chip__value--bump' : ''}`}>
          {format(shown)}
        </span>
      </div>
    </Tooltip>
  )
}
