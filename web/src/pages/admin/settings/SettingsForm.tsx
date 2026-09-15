import type { ReactNode } from 'react'
import { Form, Typography } from 'antd'

import { useMediaQuery } from '../../../hooks/useMediaQuery'

/**
 * The one form layout every settings panel uses: label on the left at a fixed
 * width, control and its explanation on the right at a readable one.
 *
 * The console content area runs to 1560px. A settings field stretched that far
 * puts its label and its input at opposite ends of the screen, so the column is
 * capped here instead — and collapses to stacked labels on a phone, where a
 * 176px gutter would leave nothing for the control.
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
      wrapperCol={narrow ? undefined : { flex: '1 1 auto' }}
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
