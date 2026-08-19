import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button, Result, Typography } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keeps one broken page from blanking the whole console. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面渲染失败：', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <Result
        status="error"
        title="页面出错了"
        subTitle="控制台渲染时抛出异常，可以刷新重试；如果反复出现请把下面的信息反馈给管理员。"
        extra={[
          <Button key="reload" type="primary" onClick={() => window.location.reload()}>
            刷新页面
          </Button>,
          <Button key="reset" onClick={() => this.setState({ error: null })}>
            重试渲染
          </Button>,
          // A full navigation also drops whatever in-memory state broke the page.
          <Button
            key="home"
            onClick={() => {
              window.location.href = '/'
            }}
          >
            回到仪表盘
          </Button>,
        ]}
      >
        <Typography.Paragraph copyable={{ text: `${error.message}\n${error.stack ?? ''}` }}>
          <pre className="code-block">{error.message}</pre>
        </Typography.Paragraph>
      </Result>
    )
  }
}
