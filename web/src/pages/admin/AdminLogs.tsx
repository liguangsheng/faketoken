import { useState } from 'react'
import { App, Button, Dropdown } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'

import { api } from '../../api/client'
import LogTable from '../../components/LogTable'
import PageHeader from '../../components/PageHeader'

const PURGE_OPTIONS = [7, 30, 90]

export default function AdminLogs() {
  const { message, modal } = App.useApp()
  const [refreshKey, setRefreshKey] = useState(0)

  const purge = (days: number) => {
    modal.confirm({
      title: `清理 ${days} 天前的日志？`,
      content:
        '调用记录和随之保留的请求正文都会被删除，无法恢复，统计图表中的历史数据也会一并消失。',
      okText: '确认清理',
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await api.admin.purgeLogs(days)
        message.success(`已清理 ${result.deleted} 条记录`)
        setRefreshKey((value) => value + 1)
      },
    })
  }

  const purgeButton = (
    <Dropdown
      menu={{
        items: PURGE_OPTIONS.map((days) => ({
          key: String(days),
          label: `清理 ${days} 天前`,
          danger: true,
        })),
        onClick: ({ key }) => purge(Number(key)),
      }}
    >
      <Button danger icon={<DeleteOutlined />}>
        清理历史日志
      </Button>
    </Dropdown>
  )

  return (
    <>
      <PageHeader
        title="全局日志"
        description="全部用户的逐次调用记录，可按用户名、模型、时间范围筛选；点开任意一行可查看完整请求与响应。"
      />
      <LogTable key={`requests-${refreshKey}`} admin fetcher={api.admin.logs} extra={purgeButton} />
    </>
  )
}
