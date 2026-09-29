import type { ReactNode } from 'react'

interface Props {
  title: ReactNode
  description?: ReactNode
  extra?: ReactNode
}

export default function PageHeader({ title, description, extra }: Props) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        {description && <p className="page-header__description">{description}</p>}
      </div>
      {extra && <div className="page-header__extra">{extra}</div>}
    </div>
  )
}
