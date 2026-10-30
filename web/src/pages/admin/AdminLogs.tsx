import { useState } from 'react'
import { App, Button, Dropdown, Space, Tooltip } from 'antd'
import {
  DeleteOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from '@ant-design/icons'

import { api } from '../../api/client'
import LogTable from '../../components/log/LogTable'
import PageHeader from '../../components/PageHeader'

const PURGE_OPTIONS = [7, 30, 90]

export default function AdminLogs() {
  const { message, modal } = App.useApp()
  const [reloadToken, setReloadToken] = useState(0)
  const [redacted, setRedacted] = useState(false)

  const purge = (days: number) => {
    modal.confirm({
      title: `清理 ${days} 天前的日志？`,
      content:
        '调用记录和随之保留的请求正文都会被删除，无法恢复，统计图表中的历史数据也会一并消失。',
      okText: '确认清理',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await api.admin.purgeLogs(days)
          message.success(`已清理 ${result.deleted} 条记录`)
          // A data-only reload: the operator's filters and page survive.
          setReloadToken((value) => value + 1)
        } catch (error) {
          message.error(error instanceof Error ? error.message : '清理失败')
          throw error
        }
      },
    })
  }

  return (
    <>
      <PageHeader
        title="全局日志"
        description="全部用户的逐次调用记录与完整正文。"
        extra={
          <Space size={8}>
            <Tooltip title={redacted ? '显示敏感信息' : '隐藏敏感信息'}>
              <Button
                type="text"
                size="small"
                aria-label={redacted ? '显示敏感信息' : '隐藏敏感信息'}
                icon={redacted ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onClick={() => setRedacted((value) => !value)}
              />
            </Tooltip>
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
                <Space size={6}>
                  清理历史日志
                  <DownOutlined style={{ fontSize: 10 }} />
                </Space>
              </Button>
            </Dropdown>
          </Space>
        }
      />
      <LogTable
        admin
        showRate
        fetcher={api.admin.logs}
        reloadToken={reloadToken}
        redacted={redacted}
      />
    </>
  )
}
