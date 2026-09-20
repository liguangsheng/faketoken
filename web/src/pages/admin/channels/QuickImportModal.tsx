import { useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Space,
  Tooltip,
  Typography,
} from 'antd'

import { api, type Channel, type ChannelImportPreview } from '../../../api/client'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { useSettings } from '../../../settings/SettingsContext'

interface Props {
  open: boolean
  onClose: () => void
  /**
   * Hands the draft to the channel form. Nothing is written until the operator
   * saves it, so a bad guess costs one cancel. channel is the existing row when
   * the paste names an upstream that is already configured.
   */
  onApply: (channel: Channel | undefined, overrides: Record<string, unknown>) => void
}

export default function QuickImportModal({ open, onClose, onApply }: Props) {
  const { message } = App.useApp()
  const { settings } = useSettings()
  const [text, setText] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<ChannelImportPreview | null>(null)
  const debounced = useDebouncedValue(text)

  // Each opening starts empty; the previous paste is not a useful default.
  useEffect(() => {
    if (!open) return
    setText('')
    setBaseURL('')
    setApiKey('')
    setPreview(null)
  }, [open])

  // Re-read the paste as it is typed, without touching the upstream: parsing is
  // a pure server-side string operation, so it is cheap enough to run on every
  // pause. Editing the text replaces whatever the previous parse produced,
  // which makes the paste the source of truth; a manual fix to either field
  // survives until the text itself changes again.
  useEffect(() => {
    if (!open) return
    const trimmed = debounced.trim()
    if (!trimmed) return

    let cancelled = false
    void (async () => {
      try {
        const result = await api.admin.importChannel({ text: trimmed, skip_models: true })
        if (cancelled) return
        setBaseURL(result.base_url)
        setApiKey(result.api_key)
        // Keep models already pulled for this very address: editing an unrelated
        // line of the paste should not throw away a successful probe.
        setPreview((previous) =>
          previous && previous.base_url === result.base_url
            ? { ...result, models: previous.models, model_error: previous.model_error }
            : result,
        )
      } catch {
        // Half-typed text has no address yet. That is the normal state while
        // someone is still pasting, not something worth interrupting them for.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, debounced])

  // probe re-reads the paste and calls the upstream for its model list. Manual
  // corrections in the two fields win here: by the time someone presses the
  // button, those are the values they want probed.
  const probe = async () => {
    setImporting(true)
    try {
      const result = await api.admin.importChannel({
        text,
        base_url: baseURL || undefined,
        api_key: apiKey || undefined,
      })
      setPreview(result)
      setBaseURL(result.base_url)
      setApiKey(result.api_key)
      if (result.model_error) {
        message.warning(`已识别地址和密钥，但拉取模型失败：${result.model_error}`)
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '解析失败')
    } finally {
      setImporting(false)
    }
  }

  const apply = async () => {
    if (!preview) return
    const existing = preview.existing_channel

    const overrides = {
      base_url: preview.base_url,
      auth_style: preview.auth_style,
      api_key: preview.api_key,
      supported_protocols: preview.supported_protocols ?? [],
      ...(preview.models.length ? { models: preview.models } : {}),
    }

    if (existing) {
      // Load the row rather than reusing the list page: editing the full record
      // keeps everything the import cannot know — groups, priority, price ratio
      // — instead of silently resetting it to defaults.
      try {
        const current = await api.admin.getChannel(existing.id)
        onApply(current, overrides)
        message.info(`将覆盖已有渠道「${existing.name}」，确认后保存`)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '读取同名渠道失败')
      }
      return
    }

    // The import defaults apply here only. The branch above edits an existing
    // channel, where overwriting priority and weight would discard settings the
    // import knows nothing about.
    onApply(undefined, {
      ...overrides,
      name: preview.suggested_name,
      priority: settings.import_priority,
      weight: settings.import_weight,
    })
  }

  return (
    <Modal
      open={open}
      width={640}
      title="快速导入渠道"
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Tooltip key="probe" title={!baseURL ? '先粘贴或填写接口地址' : undefined}>
          {/* span：disabled 按钮不冒泡鼠标事件，Tooltip 需要有人接住 hover */}
          <span style={{ display: 'inline-block', marginInlineStart: 8 }}>
            <Button loading={importing} disabled={!baseURL} onClick={() => void probe()}>
              拉取模型
            </Button>
          </span>
        </Tooltip>,
        <Button
          key="apply"
          type="primary"
          disabled={!preview}
          onClick={() => void apply()}
        >
          填入表单
        </Button>,
      ]}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          把服务商给的地址和密钥整段贴进来即可，也支持 curl 命令，停顿即自动识别；
          识别结果可以手动修正，修改上方文本会重新覆盖。
        </Typography.Text>
        <Input.TextArea
          rows={5}
          value={text}
          placeholder={'接口地址：https://api.example.com/v1\nAPI Key: sk-...'}
          onChange={(event) => setText(event.target.value)}
        />

        <Row gutter={12}>
          <Col xs={24} md={14}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              接口地址
            </Typography.Text>
            <Input
              value={baseURL}
              placeholder="https://api.example.com/v1"
              aria-label="接口地址"
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </Col>
          <Col xs={24} md={10}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              密钥
            </Typography.Text>
            <Input
              value={apiKey}
              placeholder="sk-..."
              aria-label="上游密钥"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Col>
        </Row>

        {preview && (
          <>
            {preview.existing_channel && (
              <Alert
                type="warning"
                showIcon
                message={`已存在同名渠道「${preview.existing_channel.name}」`}
                description="填入表单后会以覆盖方式编辑该渠道，而不是新建。"
              />
            )}
            {preview.model_error && (
              <Alert
                type="error"
                showIcon
                message="拉取模型失败"
                description={preview.model_error}
              />
            )}
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="建议名称">
                {preview.suggested_name || '未识别'}
              </Descriptions.Item>
              <Descriptions.Item label="模型">
                {preview.models.length ? (
                  <Tooltip
                    title={
                      preview.models.length > 20
                        ? `${preview.models.slice(0, 20).join('、')} …等 ${preview.models.length} 个`
                        : preview.models.join('、')
                    }
                  >
                    <span>已拉取 {preview.models.length} 个</span>
                  </Tooltip>
                ) : (
                  <span className="text-muted">未拉取</span>
                )}
              </Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Space>
    </Modal>
  )
}
