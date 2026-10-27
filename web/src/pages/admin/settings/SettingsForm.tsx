import { useId, type ReactNode } from 'react'
import { Form } from 'antd'

export default function SettingsForm({ children }: { children: ReactNode }) {
  return (
    <Form className="settings-form" layout="vertical" requiredMark={false}>
      {children}
    </Form>
  )
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-section">
      <header className="settings-section__head">
        <h2 className="settings-section__title">{title}</h2>
        {description && <p className="settings-section__description">{description}</p>}
      </header>
      {children}
    </section>
  )
}

export function SettingsDetails({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="settings-details">
      <summary>{title}</summary>
      <div className="settings-details__body">{children}</div>
    </details>
  )
}

interface ControlProps {
  id: string
  'aria-labelledby': string
  'aria-describedby': string
}

interface RowProps {
  label: string
  description: ReactNode
  details?: { title: string; content: ReactNode }
  wide?: boolean
  children: (props: ControlProps) => ReactNode
}

export function SettingsRow({ label, description, details, wide, children }: RowProps) {
  const id = useId()

  return (
    <div className={`settings-row${wide ? ' settings-row--wide' : ''}`}>
      <div className="settings-row__copy">
        <label className="settings-row__label" id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        <div className="settings-row__description" id={`${id}-description`}>
          {description}
        </div>
        {details && <SettingsDetails title={details.title}>{details.content}</SettingsDetails>}
      </div>
      <div className="settings-row__control">
        {children({
          id,
          'aria-labelledby': `${id}-label`,
          'aria-describedby': `${id}-description`,
        })}
      </div>
    </div>
  )
}
