import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

export default function NotFound({ forbidden }: { forbidden?: boolean }) {
  const navigate = useNavigate()

  return (
    <Result
      status={forbidden ? '403' : '404'}
      title={forbidden ? '没有访问权限' : '页面不存在'}
      subTitle={
        forbidden
          ? '这个页面只对管理员开放，换个账号或联系管理员开通权限。'
          : '地址可能已经变更，或者你手输了一个不存在的路径。'
      }
      extra={
        <Button type="primary" onClick={() => navigate('/')}>
          回到仪表盘
        </Button>
      }
    />
  )
}
