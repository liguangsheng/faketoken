import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { App, Button, Card, Col, Input, Row, Tag, Tooltip, Typography } from 'antd'
import { CopyOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'

import { api, type PlazaModel } from '../api/client'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import { formatPrice } from '../utils/format'
import { copyTextToClipboard } from '../utils/clipboard'

/**
 * Vendors are guessed from the model name, purely for grouping and filtering.
 * Order matters: the first match wins, so the more specific patterns sit above
 * the generic ones.
 */
const VENDORS: { key: string; label: string; color: string; test: RegExp }[] = [
  { key: 'openai', label: 'OpenAI', color: 'green', test: /^(gpt|chatgpt|o[1345](-|$)|codex|davinci|babbage|text-embedding|dall-e|whisper|tts|sora)/i },
  { key: 'anthropic', label: 'Anthropic', color: 'volcano', test: /claude/i },
  { key: 'google', label: 'Google', color: 'blue', test: /^(gemini|gemma|imagen|veo|learnlm|models\/)/i },
  { key: 'deepseek', label: 'DeepSeek', color: 'geekblue', test: /deepseek/i },
  { key: 'qwen', label: '通义千问', color: 'purple', test: /^(qwen|qwq|qvq)/i },
  { key: 'zhipu', label: '智谱', color: 'cyan', test: /^(glm|chatglm|cogview|cogvideo)/i },
  { key: 'doubao', label: '豆包', color: 'magenta', test: /^doubao/i },
  { key: 'moonshot', label: 'Kimi', color: 'gold', test: /^(kimi|moonshot)/i },
  { key: 'xai', label: 'xAI', color: 'default', test: /grok/i },
  { key: 'meta', label: 'Meta', color: 'blue', test: /llama/i },
  { key: 'mistral', label: 'Mistral', color: 'orange', test: /(mistral|mixtral|codestral|ministral|magistral|devstral|pixtral)/i },
  { key: 'baidu', label: '百度', color: 'blue', test: /ernie/i },
  { key: 'tencent', label: '腾讯混元', color: 'cyan', test: /hunyuan/i },
  { key: 'minimax', label: 'MiniMax', color: 'red', test: /(minimax|abab)/i },
  { key: 'cohere', label: 'Cohere', color: 'lime', test: /^(command|c4ai|aya)/i },
]

const OTHER = { key: 'other', label: '其他', color: 'default' }

const vendorOf = (model: string) => VENDORS.find((v) => v.test.test(model)) ?? OTHER

interface Entry extends PlazaModel {
  vendor: typeof OTHER
  /** Effective prices, after the group rate. */
  input: number
  output: number
  cached: number
  perRequest: number
  free: boolean
}

export default function Plaza() {
  const { message } = App.useApp()
  const [models, setModels] = useState<PlazaModel[]>([])
  const [group, setGroup] = useState('')
  const [rate, setRate] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [vendorKey, setVendorKey] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.plaza()
      setModels(result.data ?? [])
      setGroup(result.group)
      setRate(result.group_rate > 0 ? result.group_rate : 1)
      setError(null)
    } catch (err) {
      const text = err instanceof Error ? err.message : '加载失败'
      setError(text)
      // The full-page error state only renders when there is nothing to show;
      // a failed refresh over an existing catalog still needs a signal.
      message.error(text)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const entries = useMemo<Entry[]>(
    () =>
      models.map((m) => ({
        ...m,
        vendor: vendorOf(m.model),
        input: m.input_price * rate,
        output: m.output_price * rate,
        cached: m.cached_price * rate,
        perRequest: m.per_request_price * rate,
        // The server lists an unpriced model only when it relays for free; one
        // the relay would refuse never reaches this page.
        free:
          m.price_status === 'missing' ||
          m.input_price + m.output_price + m.cached_price + m.per_request_price === 0,
      })),
    [models, rate],
  )

  // Keyword first, vendor second: the chips count what the keyword left, so a
  // chip never promises models that a click then fails to show.
  const keywordFiltered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return entries
    return entries.filter(
      (e) =>
        e.model.toLowerCase().includes(kw) ||
        e.vendor.label.toLowerCase().includes(kw) ||
        e.vendor.key.includes(kw),
    )
  }, [entries, keyword])

  const filtered = useMemo(
    () => keywordFiltered.filter((e) => vendorKey === 'all' || e.vendor.key === vendorKey),
    [keywordFiltered, vendorKey],
  )

  /** Vendors that survive the keyword, in declaration order, for the chips. */
  const vendorChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of keywordFiltered) counts.set(e.vendor.key, (counts.get(e.vendor.key) ?? 0) + 1)
    return [...VENDORS, OTHER]
      .filter((v) => counts.has(v.key))
      .map((v) => ({ ...v, count: counts.get(v.key) ?? 0 }))
  }, [keywordFiltered])

  /** Cards grouped into one section per vendor, keeping declaration order. */
  const sections = useMemo(() => {
    const byVendor = new Map<string, Entry[]>()
    for (const e of filtered) {
      const list = byVendor.get(e.vendor.key)
      if (list) list.push(e)
      else byVendor.set(e.vendor.key, [e])
    }
    return [...VENDORS, OTHER]
      .filter((v) => byVendor.has(v.key))
      .map((v) => ({
        vendor: v,
        models: (byVendor.get(v.key) ?? []).sort((a, b) => a.model.localeCompare(b.model)),
      }))
  }, [filtered])

  const copy = async (text: string) => {
    if (await copyTextToClipboard(text)) {
      message.success(`已复制：${text}`)
    } else {
      message.error('复制失败：浏览器不允许访问剪贴板，请手动选中复制')
    }
  }

  const clearFilters = () => {
    setKeyword('')
    setVendorKey('all')
  }

  const chipProps = (key: string, label: string, count: number) => ({
    role: 'radio' as const,
    tabIndex: 0,
    'aria-checked': vendorKey === key,
    'aria-label': `${label}，${count} 个模型`,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setVendorKey(vendorKey === key || key === 'all' ? 'all' : key)
      }
    },
  })

  return (
    <>
      <PageHeader
        title="模型广场"
        description={
          <>
            当前分组 <Typography.Text code>{group || '-'}</Typography.Text> 可用的全部模型。
            价格单位为「美元 / 100 万 Token」
            {rate !== 1 ? (
              <>
                ，已按分组倍率{' '}
                <Typography.Text code>x{Number(rate.toPrecision(4))}</Typography.Text>{' '}
                折算为实际计费单价
              </>
            ) : (
              '，即实际计费单价'
            )}
            。
          </>
        }
        extra={
          <>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索模型或厂商"
              aria-label="搜索模型或厂商"
              style={{ width: 220, maxWidth: '100%' }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          </>
        }
      />

      {entries.length > 0 && (
        <div className="tag-list" role="radiogroup" aria-label="按厂商筛选" style={{ marginBottom: 16 }}>
          <Tag.CheckableTag
            checked={vendorKey === 'all'}
            onChange={() => setVendorKey('all')}
            {...chipProps('all', '全部', keywordFiltered.length)}
          >
            全部（{keywordFiltered.length}）
          </Tag.CheckableTag>
          {vendorChips.map((v) => (
            <Tag.CheckableTag
              key={v.key}
              checked={vendorKey === v.key}
              onChange={() => setVendorKey(vendorKey === v.key ? 'all' : v.key)}
              {...chipProps(v.key, v.label, v.count)}
            >
              {v.label}（{v.count}）
            </Tag.CheckableTag>
          ))}
        </div>
      )}

      {loading && entries.length === 0 && (
        <Row gutter={[12, 12]}>
          {Array.from({ length: 8 }, (_, index) => (
            <Col key={index} xs={24} sm={12} lg={8} xl={6}>
              <Card size="small" loading />
            </Col>
          ))}
        </Row>
      )}

      {!loading && error && entries.length === 0 && (
        <EmptyState
          title="加载失败"
          description={error}
          action={
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}
      {!loading && !error && entries.length === 0 && (
        <EmptyState
          title="当前分组暂无可用模型"
          description="还没有渠道向这个分组提供模型，请联系管理员配置渠道。"
        />
      )}
      {!loading && !error && entries.length > 0 && filtered.length === 0 && (
        <EmptyState
          title="没有匹配的模型"
          description="换个关键词或厂商筛选试试。"
          action={<Button onClick={clearFilters}>清除筛选</Button>}
        />
      )}

      {sections.map(({ vendor, models: list }) => (
        <div key={vendor.key} style={{ marginBottom: 24 }}>
          <Typography.Title level={5} style={{ marginBottom: 12 }}>
            {vendor.label}
            <Typography.Text type="secondary" style={{ fontSize: 13, marginLeft: 8 }}>
              {list.length} 个模型
            </Typography.Text>
          </Typography.Title>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 12,
            }}
          >
            {list.map((entry) => (
              <ModelCard key={entry.model} entry={entry} onCopy={copy} />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function ModelCard({ entry, onCopy }: { entry: Entry; onCopy: (text: string) => void }) {
  return (
    <Card size="small">
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Typography.Text
          strong
          className="mono"
          style={{ flex: 1, fontSize: 13, minWidth: 0 }}
          ellipsis={{ tooltip: entry.model }}
        >
          {entry.model}
        </Typography.Text>
        <Tooltip title="复制模型名">
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            aria-label={`复制模型名 ${entry.model}`}
            onClick={() => onCopy(entry.model)}
          />
        </Tooltip>
      </div>

      <div style={{ margin: '8px 0 10px' }}>
        <Tag color={entry.vendor.color}>{entry.vendor.label}</Tag>
        {entry.free && <Tag color="green">免费</Tag>}
        {entry.price_status === 'fallback' && (
          <Tooltip title="该模型未单独配价，按站点兜底价计费">
            <Tag color="gold">兜底价</Tag>
          </Tooltip>
        )}
      </div>

      <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        <PriceRow label="输入 / 1M" value={formatPrice(entry.input)} />
        <PriceRow label="输出 / 1M" value={formatPrice(entry.output)} />
        {entry.cached > 0 && <PriceRow label="缓存输入 / 1M" value={formatPrice(entry.cached)} />}
        {entry.perRequest > 0 && <PriceRow label="每次请求" value={formatPrice(entry.perRequest)} />}
      </div>
    </Card>
  )
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span className="text-muted">{label}</span>
      <span className="mono">{value}</span>
    </div>
  )
}
