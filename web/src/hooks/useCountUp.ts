import { useEffect, useRef, useState } from 'react'

/**
 * Eases a number toward its target so a changing metric rolls instead of
 * snapping. A live counter that jumps between two readings is hard to read at
 * a glance; a short tween makes the direction of travel obvious.
 *
 * Returns the value to display, which is only equal to the target once the
 * tween settles.
 */
export function useCountUp(target: number, duration = 520): number {
  const [display, setDisplay] = useState(target)
  // Read inside the effect without making the tween restart on every frame it
  // schedules; a state dependency here would loop.
  const displayRef = useRef(target)
  displayRef.current = display

  useEffect(() => {
    const from = displayRef.current
    if (from === target) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(target)
      return
    }

    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      // easeOutCubic: quick off the mark, soft landing.
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(from + (target - from) * eased))
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, duration])

  return display
}
