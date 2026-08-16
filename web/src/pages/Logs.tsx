import { api } from '../api/client'
import LogTable from '../components/LogTable'
import PageHeader from '../components/PageHeader'

export default function Logs() {
  return (
    <>
      <PageHeader
        title="调用日志"
        description="每一行都是一次真实转发，点击可查看渠道、用量、耗时与错误详情。"
      />
      <LogTable fetcher={api.logs} />
    </>
  )
}
