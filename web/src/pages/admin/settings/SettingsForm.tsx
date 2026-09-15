import type { ReactNode } from 'react'
import { Form, Typography } from 'antd'

import { useMediaQuery } from '../../../hooks/useMediaQuery'

/**
 * The one form layout every settings panel uses: label in a fixed column,
 * control and its explanation in a second fixed column beside it.
 *
 * Both columns are fixed rather than fluid, and that is the whole point. A
 * fluid control column takes its width from its content, so the longest help
 * sentence decides how wide the row wants to be — and when that exceeds the
 * form, antd wraps the row, dropping the control below its own label. The
 * result is a form where some fields are horizontal and some are vertical
 * depending on how much prose each one carries.
 *
 * Fixing the column also lines the control up with its help text, so every
 * field in the page shares one left edge and one right edge.
 */
export default function SettingsForm({ children }: { children: ReactNode }) {
  const narrow = useMediaQuery('(max-width: 767px)')

  return (
    <Form
      className="settings-form"
      colon={false}
      layout={narrow ? 'vertical' : 'horizontal'}
      labelAlign="left"
      labelWrap
      labelCol={narrow ? undefined : { flex: '0 0 176px' }}
      wrapperCol={narrow ? undefined : { flex: '0 0 var(--settings-field-w)' }}
    >
      {children}
    </Form>
  )
}

/**
 * A heading between groups of fields inside one tab, for a panel that holds two
 * related-but-distinct things (retention and capture, say). Cheaper visually
 * than nesting a second Card.
 */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-section">
      <Typography.Text className="settings-section__title">{title}</Typography.Text>
      {children}
    </div>
  )
}
