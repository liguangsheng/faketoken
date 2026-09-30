import { memo, useEffect, useState } from 'react'
import { Alert, Button, Collapse, Image, Popconfirm, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
  StopOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'

import type { ImageJob, JobImage, JobRequest, JobStatus } from '../../imageJobs/types'
import { formatBytes, formatDuration, formatNumber } from '../../utils/format'
import { imageExtension } from '../../utils/images'

const STATUS_TAG: Record<JobStatus, { color: string; label: string; icon: JSX.Element }> = {
  running: { color: 'processing', label: '生成中', icon: <SyncOutlined spin /> },
  done: { color: 'success', label: '完成', icon: <CheckCircleOutlined /> },
  failed: { color: 'error', label: '失败', icon: <CloseCircleOutlined /> },
  aborted: { color: 'default', label: '已停止', icon: <MinusCircleOutlined /> },
  interrupted: { color: 'warning', label: '已中断', icon: <ExclamationCircleOutlined /> },
}

/** Wall-clock time, ticking only while something is running. */
const useNow = (ticking: boolean) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}

export default function JobList({
  jobs,
  onStop,
  onRemove,
  onReuse,
}: {
  jobs: ImageJob[]
  onStop: (id: string) => void
  onRemove: (id: string) => void
  onReuse: (request: JobRequest) => void
}) {
  const now = useNow(jobs.some((job) => job.status === 'running'))
  return (
    <div className="image-jobs">
      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          // Only a running card reads the clock; the rest keep a constant
          // prop, so memo spares them the ten re-renders a second.
          now={job.status === 'running' ? now : 0}
          onStop={onStop}
          onRemove={onRemove}
          onReuse={onReuse}
        />
      ))}
    </div>
  )
}

/** The parameters that were actually sent, in one line. */
const describeRequest = (request: JobRequest) =>
  [
    ...Object.values(request.options).filter(Boolean),
    request.n > 1 && `${request.n} 张`,
    Object.keys(request.extra).length > 0 && JSON.stringify(request.extra),
    request.referenceNames.length > 0 && `参考图 ${request.referenceNames.length} 张`,
  ]
    .filter(Boolean)
    .join(' · ')

const JobCard = memo(function JobCard({
  job,
  now,
  onStop,
  onRemove,
  onReuse,
}: {
  job: ImageJob
  now: number
  onStop: (id: string) => void
  onRemove: (id: string) => void
  onReuse: (request: JobRequest) => void
}) {
  const { request } = job
  const tag = STATUS_TAG[job.status]
  const running = job.status === 'running'
  // An interrupted job never recorded when it ended.
  const elapsed = running ? now - job.createdAt : job.finishedAt ? job.finishedAt - job.createdAt : 0
  const params = describeRequest(request)
  const stamp = dayjs(job.createdAt).format('YYYYMMDD-HHmmss')

  return (
    <div className="image-job">
      <div className="image-job__head">
        <Space size={8} wrap>
          <Tag color={tag.color} icon={tag.icon} style={{ marginInlineEnd: 0 }}>
            {tag.label}
            {elapsed > 0 && ` ${running ? `${(elapsed / 1000).toFixed(1)} s` : formatDuration(elapsed)}`}
          </Tag>
          <span className="mono">{request.model}</span>
          {request.target && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {request.target.label} {request.target.value}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(job.createdAt).format('MM-DD HH:mm:ss')}
          </Typography.Text>
        </Space>
        <Space size={4}>
          <Tooltip title="把这次的模型、提示词和参数填回左侧（参考图不保存）">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => onReuse(request)}>
              复用
            </Button>
          </Tooltip>
          {running ? (
            <Button size="small" type="text" danger icon={<StopOutlined />} onClick={() => onStop(job.id)}>
              停止
            </Button>
          ) : (
            <Popconfirm
              title="删除这条记录？"
              description="图片会一起从本机删除。"
              okText="删除"
              okButtonProps={{ danger: true }}
              onConfirm={() => onRemove(job.id)}
            >
              <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="删除记录" />
            </Popconfirm>
          )}
        </Space>
      </div>

      <Typography.Paragraph
        className="image-job__prompt"
        style={{ marginBottom: 0 }}
        ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
      >
        {request.prompt}
      </Typography.Paragraph>
      {params && (
        <Typography.Text type="secondary" className="image-job__params">
          {params}
        </Typography.Text>
      )}

      {running && (
        <div className="image-job__pending">
          <Spin size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            一张图通常要几十秒，可以先去别的页面，完成后会通知
          </Typography.Text>
        </div>
      )}

      {job.status === 'interrupted' && (
        <Alert type="warning" showIcon message="页面刷新或关闭时，这次请求还没回来，结果已丢失。" />
      )}

      {job.error && (
        <Alert
          type={job.status === 'done' ? 'warning' : 'error'}
          showIcon
          message={job.status === 'done' ? '没有图片' : '请求失败'}
          description={<pre className="code-block">{job.error}</pre>}
        />
      )}

      {job.images.length > 0 && (
        <Image.PreviewGroup preview={{ rootClassName: 'checkerboard' }}>
          <div className="image-grid">
            {job.images.map((image, index) => (
              <ImageTile
                key={image.src}
                image={image}
                fileName={`${request.model.replace(/[^\w.-]+/g, '-')}-${stamp}-${index + 1}`}
              />
            ))}
          </div>
        </Image.PreviewGroup>
      )}

      {job.usage && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          输入 / 输出 Token {formatNumber(job.usage.input ?? 0)} / {formatNumber(job.usage.output ?? 0)}
        </Typography.Text>
      )}

      {job.raw && (
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'raw',
              label: '原始响应（base64 已折叠）',
              children: <pre className="code-block">{job.raw}</pre>,
            },
          ]}
        />
      )}
    </div>
  )
})

/** The pixel size of an image, measured off-screen when it was not recorded. */
const useNaturalSize = (image: JobImage) => {
  const recorded = image.width && image.height ? { width: image.width, height: image.height } : null
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null)
  const unknown = recorded === null
  useEffect(() => {
    if (!unknown) return
    // window.Image: the bare name is antd's component here.
    const probe = new window.Image()
    probe.onload = () => setMeasured({ width: probe.naturalWidth, height: probe.naturalHeight })
    probe.src = image.src
    return () => {
      probe.onload = null
    }
  }, [image.src, unknown])
  return recorded ?? measured
}

function ImageTile({ image, fileName }: { image: JobImage; fileName: string }) {
  const size = useNaturalSize(image)
  const extension = imageExtension(image.src, image.type)
  const facts = [
    size && `${size.width}×${size.height}`,
    image.bytes !== undefined && formatBytes(image.bytes),
    extension.toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ')
  // A link to another host ignores `download` and opens instead, so it gets a
  // new tab rather than replacing this page.
  const local = /^(blob|data):/.test(image.src)

  return (
    <div className="image-tile">
      <div className="image-tile__frame checkerboard">
        <Image src={image.src} alt="生成的图片" loading="lazy" decoding="async" />
      </div>
      <div className="image-tile__meta">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {facts}
        </Typography.Text>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          href={image.src}
          download={`${fileName}.${extension}`}
          {...(local ? {} : { target: '_blank', rel: 'noreferrer' })}
        >
          下载
        </Button>
      </div>
      {image.revisedPrompt && (
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, marginBottom: 0 }}
          ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
        >
          {image.revisedPrompt}
        </Typography.Paragraph>
      )}
    </div>
  )
}
