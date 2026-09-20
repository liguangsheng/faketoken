import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd'

import { api, type Channel, type ChannelTestResult, type PromptTemplate } from '../../../api/client'
import { formatDuration, formatNumber } from '../../../utils/format'
import { TEST_PROTOCOLS, type TestProtocol } from './shared'

interface Props {
  /** The channel under test; null keeps the dialog closed. */
  channel: Channel | null
  onClose: () => void
  /** A probe stamps tested_at on the row, so the listing is told to reload. */
  onTested: () => void | Promise<void>
}

/** A random built-in prompt, or nothing before the templates have arrived. */
const pick = (templates: PromptTemplate[]) =>
  templates.length ? templates[Math.floor(Math.random() * templates.length)] : undefined

export default function TestChannelModal({ channel, onClose, onTested }: Props) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState<TestProtocol>('responses')
  const [template, setTemplate] = useState('')
  const [prompt, setPrompt] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ChannelTestResult | undefined>()
  const [seeded, setSeeded] = useState(false)

  // The templates are compiled into the server, so one fetch per page load is
  // enough; a failure just leaves the custom prompt box.
  useEffect(() => {
    api.admin
      .promptTemplates()
      .then((response) => setTemplates(response.data ?? []))
      .catch(() => setTemplates([]))
  }, [])

  // Each opening starts fresh. A mapping-only channel has no channel.models to
  // fall back on, and left blank the probe would resolve nothing. The prompt
  // starts from a random built-in: it makes a meaningful probe one click away,
  // and varying the question stops a channel from looking healthy just because
  // it caches one familiar answer.
  useEffect(() => {
    if (!channel) {
      // Reset the seed marker so the next opening draws a fresh prompt.
      setSeeded(false)
      return
    }
    setResult(undefined)
    setModel(
      channel.test_model ||
        channel.models[0] ||
        Object.keys(channel.model_mapping ?? {})[0] ||
        '',
    )
    setProtocol('responses')
    const picked = pick(templates)
    setTemplate(picked?.id ?? '')
    setPrompt(picked?.prompt ?? '')
    setSeeded(Boolean(picked))
    // templates is read on purpose but must not re-seed a dialog that is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel])

  // The templates load with the page, so a click almost always finds them. This
  // covers the narrow case of opening the dialog before that request lands.
  // It seeds once per opening: clearing the box is how you ask for a
  // connectivity-only probe, and re-filling it would take that away.
  useEffect(() => {
    if (seeded || !channel || !templates.length) return
    const picked = pick(templates)!
    setTemplate(picked.id)
    setPrompt(picked.prompt)
    setSeeded(true)
  }, [seeded, templates, channel])

  // A channel answers for its own model list plus every model_mapping key: the
  // key is the name a caller requests, which the relay rewrites to the mapped
  // value before the request leaves. Offering only channel.models left the
  // rewritten names out of the picker, and those are the ones most worth
  // probing — the rewrite is the part that can be wrong.
  const modelOptions = useMemo(() => {
    if (!channel) return []
    const mapping = channel.model_mapping ?? {}
    const names: string[] = []
    for (const name of [...(channel.models ?? []), ...Object.keys(mapping)]) {
      if (name && !names.includes(name)) names.push(name)
    }
    return names.map((name) => ({
      value: name,
      // Spell out what an alias resolves to: picking one should not hide which
      // upstream model the probe will actually ask for.
      label: mapping[name] ? `${name} → ${mapping[name]}` : name,
    }))
  }, [channel])

  // pickTemplate writes the text into the box, so what gets sent is exactly
  // what is on screen and stays editable from there.
  const pickTemplate = (id?: string) => {
    setTemplate(id ?? '')
    setPrompt(templates.find((item) => item.id === id)?.prompt ?? '')
  }

  // Editing the text detaches it from the template it came from; leaving the
  // dropdown showing a name that no longer matches would misreport what is
  // about to be sent.
  const editPrompt = (next: string) => {
    setPrompt(next)
    setTemplate((current) => {
      const source = templates.find((item) => item.id === current)
      return source && source.prompt === next ? current : ''
    })
  }

  const run = async () => {
    if (!channel) return
    // Clear the previous verdict first: a lingering green "通过" over a new
    // in-flight probe reads as this run's result.
    setResult(undefined)
    setTesting(true)
    try {
      // The box now holds the resolved text, template or not, so send that:
      // the probe is exactly what the operator sees.
      const response = await api.admin.testChannel(channel.id, {
        model: model || undefined,
        protocol,
        prompt: prompt.trim() || undefined,
      })
      setResult(response)
      await onTested()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      open={Boolean(channel)}
      width={720}
      title={channel ? `模型测试：${channel.name}` : '模型测试'}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="run" type="primary" loading={testing} onClick={() => void run()}>
          {prompt.trim() ? '发起对话测试' : '测试连通性'}
        </Button>,
      ]}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Row gutter={12}>
          <Col xs={24} md={8}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              模型
            </Typography.Text>
            {/* AutoComplete rather than Select: a prefix-only channel has no
                model list to choose from, so a typed-in name must work too. */}
            <AutoComplete
              allowClear
              style={{ width: '100%' }}
              value={model}
              placeholder="留空则用渠道配置的测试模型"
              onChange={(value) => setModel(value ?? '')}
              filterOption={(input, option) =>
                String(option?.value ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              options={modelOptions}
            />
          </Col>
          <Col xs={24} md={8}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              请求协议
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={protocol}
              onChange={setProtocol}
              options={TEST_PROTOCOLS.map((item) => ({ ...item }))}
            />
          </Col>
          <Col xs={24} md={8}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              提示词模板
            </Typography.Text>
            <Select
              allowClear
              style={{ width: '100%' }}
              value={template || undefined}
              placeholder="选择后填入下方"
              onChange={pickTemplate}
              options={templates.map((item) => ({ value: item.id, label: item.name }))}
            />
          </Col>
        </Row>

        <div>
          <Typography.Text strong style={{ fontSize: 13 }}>
            提示词
          </Typography.Text>
          <Input.TextArea
            rows={5}
            value={prompt}
            placeholder="可直接编辑，或从上方选择模板；清空则只测连通性"
            onChange={(event) => editPrompt(event.target.value)}
          />
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          对话测试会真实消耗上游额度（上限 1024 tokens）；清空提示词则只发 1 个 token 测连通性。
        </Typography.Text>

        {result && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="结果">
                {result.ok ? (
                  <Tag color="green">通过</Tag>
                ) : (
                  <Tag color="red">失败</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="状态码">{result.status || '-'}</Descriptions.Item>
              <Descriptions.Item label="模型">
                <span className="mono">{result.model}</span>
                {/* An alias and its target are different names for different
                    things; showing only the requested one hides where the
                    probe actually went. */}
                {result.upstream_model &&
                  result.upstream_model !== result.model && (
                    <span className="mono" style={{ opacity: 0.55 }}>
                      {' → '}
                      {result.upstream_model}
                    </span>
                  )}
              </Descriptions.Item>
              <Descriptions.Item label="耗时">
                {formatDuration(result.latency_ms)}
              </Descriptions.Item>
              {result.usage && (result.usage.total_tokens > 0 ||
                result.usage.prompt_tokens > 0 || result.usage.completion_tokens > 0) && (
                <Descriptions.Item label="Token 用量" span={2}>
                  输入 {formatNumber(result.usage.prompt_tokens)} · 输出{' '}
                  {formatNumber(result.usage.completion_tokens)} · 合计{' '}
                  {formatNumber(result.usage.total_tokens ||
                    result.usage.prompt_tokens + result.usage.completion_tokens)}
                </Descriptions.Item>
              )}
            </Descriptions>

            {result.reply && (
              <div>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  模型回复
                </Typography.Text>
                <pre className="code-block" style={{ maxHeight: 300 }}>
                  {result.reply}
                </pre>
              </div>
            )}

            {!result.ok && (
              <Alert
                type="error"
                showIcon
                message="测试失败"
                description={
                  <pre className="code-block" style={{ maxHeight: 220, marginTop: 8 }}>
                    {result.message || '上游未返回具体错误'}
                  </pre>
                }
              />
            )}
          </>
        )}
      </Space>
    </Modal>
  )
}
