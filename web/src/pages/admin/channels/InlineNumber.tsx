import { useRef, useState } from 'react'
import { InputNumber, Tag, Tooltip } from 'antd'

type InlineNumberProps = {
  value: number
  /** Short marker kept with the value, so a bare number is still readable. */
  prefix: string
  /** What the number is, for the tooltip and for screen readers. */
  label: string
  hint: string
  color?: string
  min?: number
  max?: number
  onCommit: (next: number) => Promise<void>
}

/**
 * InlineNumber shows a value as a tag and turns it into an input on click, so a
 * number that is read from the table can also be changed there instead of
 * through the edit drawer.
 *
 * It commits on Enter or on blur and reverts on Escape. An unchanged value never
 * reaches the server, which is what stops merely tabbing through the table from
 * writing to every row it passes.
 */
export default function InlineNumber({
  value,
  prefix,
  label,
  hint,
  color,
  min,
  max,
  onCommit,
}: InlineNumberProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<number | null>(value)
  const [saving, setSaving] = useState(false)
  // Marks the edit as already resolved. Escape has to win over the blur that
  // follows it, and disabling a focused input while it saves blurs it too —
  // without this, either would commit a second time.
  const done = useRef(false)

  const open = () => {
    done.current = false
    setDraft(value)
    setEditing(true)
  }

  const commit = async () => {
    if (done.current) return
    // An emptied box is not a value: it means "leave this number alone".
    const typed = draft === null || Number.isNaN(draft) ? value : draft
    const next = Math.round(Math.min(Math.max(typed, min ?? -Infinity), max ?? Infinity))
    if (next === value) {
      done.current = true
      setEditing(false)
      return
    }
    done.current = true
    setSaving(true)
    try {
      await onCommit(next)
    } finally {
      // Back to the tag either way: on failure the row still holds the server's
      // value, and leaving an unfocused input open would strand the cell with a
      // number that was never saved.
      setSaving(false)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <InputNumber
        size="small"
        autoFocus
        // The steppers would take most of a column this narrow, and typing is
        // how a value gets changed here anyway.
        controls={false}
        precision={0}
        min={min}
        max={max}
        value={draft}
        disabled={saving}
        aria-label={label}
        style={{ width: '100%' }}
        onChange={(next) => setDraft(next)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            void commit()
          } else if (event.key === 'Escape') {
            done.current = true
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <Tooltip title={hint}>
      <Tag
        color={color}
        className="tag-editable"
        role="button"
        tabIndex={0}
        aria-label={`${label} ${value}，点击修改`}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            // Space would otherwise scroll the page instead of opening the box.
            event.preventDefault()
            open()
          }
        }}
      >
        {prefix}
        {value}
      </Tag>
    </Tooltip>
  )
}
