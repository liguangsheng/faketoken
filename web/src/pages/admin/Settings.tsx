import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Typography,
} from 'antd'
import { SaveOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'

import { api, type BlockRule, type ConsoleSettings } from '../../api/client'
import PageHeader from '../../components/PageHeader'
import { useSettings } from '../../settings/SettingsContext'
import { formatBytes } from '../../utils/format'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

const MIB = 1024 * 1024
const BODY_LIMIT_OPTIONS = [
  { value: 256 * 1024, label: '256 KiB' },
  { value: 1 * MIB, label: '1 MiB' },
  { value: 2 * MIB, label: '2 MiB' },
  { value: 4 * MIB, label: '4 MiB（默认，约 1M 上下文）' },
  { value: 8 * MIB, label: '8 MiB' },
  { value: 16 * MIB, label: '16 MiB' },
  { value: 32 * MIB, label: '32 MiB' },
]

const estimateFootprint = (keep: number, bodyLimit: number) => formatBytes(keep * bodyLimit * 2)

// Mirrors the bounds in internal/relay/blocklist.go. The keyword budget is a
// total across every group, not a per-group allowance.
const MAX_RULES = 20
const MAX_KEYWORDS = 200
const MAX_KEYWORD_BYTES = 200
const MAX_REPLIES = 20
const MAX_REPLY_BYTES = 8 * 1024
const MAX_RULE_NAME = 40

const STATUS_OPTIONS = [
  { value: 200, label: '200 — 伪装成正常回复' },
  { value: 400, label: '400 — 请求无效' },
  { value: 403, label: '403 — 拒绝访问' },
  { value: 429, label: '429 — 频率限制' },
  { value: 451, label: '451 — 因法律原因不可用' },
]

const byteLength = (text: string) => new TextEncoder().encode(text).length

const nonEmpty = (lines: string[]) => lines.filter((line) => line.trim() !== '').length

/**
 * How many keywords each group will actually keep, mirroring
 * relay.NormalizeBlockRules: trimmed, deduplicated within the group, oversized
 * ones dropped, and the whole set bounded by one shared budget.
 *
 * Reimplemented here rather than guessed at, so the count the operator reads
 * is the count the relay will match on.
 */
const keptPerRule = (rules: BlockRule[]) => {
  let budget = MAX_KEYWORDS
  return rules.slice(0, MAX_RULES).map((rule) => {
    const seen = new Set<string>()
    for (const raw of rule.keywords) {
      if (budget <= 0) break
      const word = raw.trim()
      if (!word || byteLength(word) > MAX_KEYWORD_BYTES) continue
      const folded = word.toLowerCase()
      if (seen.has(folded)) continue
      seen.add(folded)
      budget--
    }
    return seen.size
  })
}

export default function Settings() {
  const { message, modal } = App.useApp()
  const { settings, apply, ready, loaded, refresh } = useSettings()
  const [draft, setDraft] = useState<ConsoleSettings>(settings)
  const [saving, setSaving] = useState(false)
  // Guards the sync below: a refresh landing mid-edit must not eat the edit.
  const dirtyRef = useRef(false)

  useEffect(() => {
    if (!dirtyRef.current) setDraft(settings)
  }, [settings])

  const dirty =
    draft.default_page_size !== settings.default_page_size ||
    draft.init_quota_usd !== settings.init_quota_usd ||
    draft.log_body_limit !== settings.log_body_limit ||
    draft.allow_register !== settings.allow_register ||
    draft.import_priority !== settings.import_priority ||
    draft.import_weight !== settings.import_weight ||
    draft.log_detail_keep !== settings.log_detail_keep ||
    draft.require_invite_code !== settings.require_invite_code ||
    draft.blocked_status !== settings.blocked_status ||
    JSON.stringify(draft.block_rules) !== JSON.stringify(settings.block_rules) ||
    draft.max_retries !== settings.max_retries ||
    draft.retry_backoff_ms !== settings.retry_backoff_ms
  dirtyRef.current = dirty

  // Closing the tab with unsaved global settings deserves one browser prompt.
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older Chromium ignores a bare preventDefault for this event.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const persist = async () => {
    setSaving(true)
    try {
      const saved = await api.admin.updateSettings(draft)
      apply(saved)
      // Adopted as the new draft, not only as the new settings: the server
      // normalises the rule groups, and leaving the pre-normalisation draft in
      // place would leave "unsaved changes" showing over a saved form.
      setDraft(saved)
      message.success('设置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const updateRule = (index: number, patch: Partial<BlockRule>) =>
    setDraft({
      ...draft,
      block_rules: draft.block_rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    })

  const addRule = () =>
    setDraft({
      ...draft,
      block_rules: [
        ...draft.block_rules,
        { name: '', enabled: true, keywords: [], replies: [''], status: 0 },
      ],
    })

  const removeRule = (index: number) =>
    setDraft({ ...draft, block_rules: draft.block_rules.filter((_, i) => i !== index) })

  const updateReply = (index: number, replyIndex: number, text: string) =>
    updateRule(index, {
      replies: draft.block_rules[index].replies.map((reply, i) =>
        i === replyIndex ? text : reply,
      ),
    })

  const addReply = (index: number) =>
    updateRule(index, { replies: [...draft.block_rules[index].replies, ''] })

  const removeReply = (index: number, replyIndex: number) =>
    updateRule(index, {
      replies: draft.block_rules[index].replies.filter((_, i) => i !== replyIndex),
    })

  const kept = keptPerRule(draft.block_rules)
  const activeKeywords = draft.block_rules.reduce(
    (total, rule, index) => total + (rule.enabled ? kept[index] : 0),
    0,
  )
  const droppedLines =
    draft.block_rules.reduce((total, rule) => total + nonEmpty(rule.keywords), 0) -
    kept.reduce((total, count) => total + count, 0)
  const oversizedReplies = draft.block_rules.reduce(
    (total, rule) => total + rule.replies.filter((reply) => byteLength(reply) > MAX_REPLY_BYTES).length,
    0,
  )
  // Endpoints that cannot carry prose refuse with a 401 whatever is configured,
  // which is worth saying wherever a 2xx is in play.
  const anyMasked = draft.block_rules.some(
    (rule) => (rule.status || draft.blocked_status) < 400,
  )

  const save = async () => {
    if (!loaded) {
      message.error('设置尚未加载成功，保存会覆盖服务端已有配置')
      return
    }
    // Lowering the keep-count deletes captured bodies immediately and
    // irreversibly; that is worth one explicit confirmation.
    if (draft.log_detail_keep < settings.log_detail_keep) {
      modal.confirm({
        title:
          draft.log_detail_keep === 0
            ? '停止记录并清空全部已保留的调用正文？'
            : `把保留条数降到 ${draft.log_detail_keep}？`,
        content: '超出条数的请求 / 响应正文会被立即删除，且无法恢复。',
        okText: '确认保存',
        okButtonProps: { danger: true },
        onOk: persist,
      })
      return
    }
    await persist()
  }

  return (
    <>
      <PageHeader
        title="全局设置"
        description="这里的配置存放在服务端，对所有用户和所有浏览器生效。"
        extra={
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty || !loaded}
            onClick={() => void save()}
          >
            保存
          </Button>
        }
      />

      {/* 首次加载中不渲染表单：可编辑的默认值配上红色告警是在把「加载中」演成「加载失败」 */}
      {!ready ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {!loaded && (
          <Alert
            type="error"
            showIcon
            message="没能读取到服务端设置"
            description="下面显示的是默认值，不是当前配置。保存已被禁用，以免覆盖服务端已有的设置。"
            action={
              <Button size="small" onClick={() => void refresh()}>
                重试
              </Button>
            }
          />
        )}

        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <Card size="small" title="列表显示">
              <Form layout="vertical">
                <Form.Item
                  label="默认每页条数"
                  help="渠道、用户、日志等列表首次打开时的每页条数；每个列表仍可临时切换。"
                  style={{ marginBottom: 0 }}
                >
                  <Select
                    aria-label="默认每页条数"
                    value={draft.default_page_size}
                    onChange={(value) => setDraft({ ...draft, default_page_size: value })}
                    options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} 条` }))}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card size="small" title="渠道快速导入">
              <Form layout="vertical">
                <Form.Item
                  label="默认优先级"
                  help="快速导入新建渠道时预填的优先级，数值越大越优先。导入到已存在的渠道时不会覆盖它原有的值。"
                >
                  <InputNumber
                    step={1}
                    precision={0}
                    min={-1000000}
                    max={1000000}
                    style={{ width: '100%' }}
                    value={draft.import_priority}
                    onChange={(value) => setDraft({ ...draft, import_priority: value ?? 0 })}
                  />
                </Form.Item>

                <Form.Item
                  label="默认权重"
                  help="同优先级的渠道之间按权重随机分配流量。至少为 1，为 0 的渠道永远不会被选中。"
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    step={1}
                    precision={0}
                    min={1}
                    max={1000000}
                    style={{ width: '100%' }}
                    value={draft.import_weight}
                    onChange={(value) => setDraft({ ...draft, import_weight: value ?? 1 })}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Col>
        </Row>

        <Card size="small" title="新用户">
          <Form layout="vertical">
            <Row gutter={24}>
              <Col xs={24} md={8}>
                <Form.Item
                  label="开放注册"
                  help="关闭后访客无法自助注册，登录页也不再显示注册入口；管理员仍可手动创建账号。"
                >
                  <Space size={10}>
                    <Switch
                      aria-label="开放注册"
                      checked={draft.allow_register}
                      onChange={(checked) => setDraft({ ...draft, allow_register: checked })}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {draft.allow_register ? '任何人都可以注册' : '仅管理员可创建账号'}
                    </Typography.Text>
                  </Space>
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label="注册需要邀请码"
                  help="开启后，访客必须填写管理员生成的邀请码才能注册。一个邀请码只能注册一个账号。"
                >
                  <Space size={10}>
                    <Switch
                      aria-label="注册需要邀请码"
                      checked={draft.require_invite_code}
                      disabled={!draft.allow_register}
                      onChange={(checked) => setDraft({ ...draft, require_invite_code: checked })}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {!draft.allow_register
                        ? '注册已关闭，此项无效'
                        : draft.require_invite_code
                          ? '需要邀请码'
                          : '任何人都可以直接注册'}
                    </Typography.Text>
                  </Space>
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label="注册赠送额度"
                  help={
                    draft.allow_register
                      ? '用户自助注册后获得的初始余额；管理员手动创建的账号不受影响。'
                      : '注册已关闭，此项无效。'
                  }
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    min={0}
                    step={1}
                    precision={2}
                    addonBefore="$"
                    disabled={!draft.allow_register}
                    style={{ width: '100%' }}
                    value={draft.init_quota_usd}
                    onChange={(value) => setDraft({ ...draft, init_quota_usd: value ?? 0 })}
                  />
                </Form.Item>
              </Col>
            </Row>

            {draft.allow_register && !draft.require_invite_code && draft.init_quota_usd > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={`开放注册且每个新账号赠送 $${draft.init_quota_usd}`}
                description="若本服务可从公网访问，任何人都能反复注册领取额度，消耗的是你的上游支出。"
              />
            )}
          </Form>
        </Card>

        <Card
          size="small"
          title="屏蔽规则"
          extra={
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={draft.block_rules.length >= MAX_RULES}
              onClick={addRule}
            >
              添加规则组
            </Button>
          }
        >
          <Form layout="vertical">
            <Form.Item
              label="命中后默认返回的状态码"
              help="每个规则组都可以单独覆盖它。2xx 会把命中组的回复当作模型回复正常返回，调用方察觉不到被拦截；4xx/5xx 则作为错误消息返回。"
            >
              <Select
                aria-label="命中后默认返回的状态码"
                style={{ maxWidth: 320 }}
                value={draft.blocked_status}
                onChange={(value) => setDraft({ ...draft, blocked_status: value })}
                options={STATUS_OPTIONS}
              />
            </Form.Item>

            {draft.block_rules.length === 0 ? (
              <Alert
                type="info"
                showIcon
                message="还没有任何屏蔽规则"
                description="按类别建组，例如「测活探测」和「破甲越狱」各一组：命中哪一组，就从那一组的预设回复里随机选一条返回。"
              />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {draft.block_rules.map((rule, index) => (
                  <Card
                    key={index}
                    size="small"
                    type="inner"
                    title={
                      <Space size={8}>
                        <Switch
                          size="small"
                          aria-label={`启用规则组 ${index + 1}`}
                          checked={rule.enabled}
                          onChange={(checked) => updateRule(index, { enabled: checked })}
                        />
                        <Input
                          size="small"
                          style={{ width: 220 }}
                          maxLength={MAX_RULE_NAME}
                          placeholder={`规则组 ${index + 1}`}
                          aria-label={`规则组 ${index + 1} 名称`}
                          value={rule.name}
                          onChange={(event) => updateRule(index, { name: event.target.value })}
                        />
                      </Space>
                    }
                    extra={
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeRule(index)}
                      >
                        删除
                      </Button>
                    }
                  >
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item
                          label={`关键词（生效 ${kept[index] ?? 0} 个）`}
                          help="每行一个，不区分大小写，匹配请求正文原文的子串。"
                          style={{ marginBottom: 12 }}
                        >
                          <Input.TextArea
                            autoSize={{ minRows: 5, maxRows: 14 }}
                            placeholder={'例如：\nping\n你是什么模型'}
                            value={rule.keywords.join('\n')}
                            onChange={(event) =>
                              updateRule(index, { keywords: event.target.value.split('\n') })
                            }
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item
                          label={`预设回复（${nonEmpty(rule.replies)} 条）`}
                          help={
                            nonEmpty(rule.replies) > 1
                              ? '每次命中从中随机选一条返回。'
                              : '多填几条，命中时会随机选一条；一条不填则使用内置默认文本。'
                          }
                          style={{ marginBottom: 12 }}
                        >
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            {rule.replies.map((reply, replyIndex) => (
                              <div
                                key={replyIndex}
                                style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
                              >
                                <Input.TextArea
                                  autoSize={{ minRows: 2, maxRows: 8 }}
                                  placeholder="留空的条目不会保存"
                                  aria-label={`规则组 ${index + 1} 的第 ${replyIndex + 1} 条回复`}
                                  value={reply}
                                  onChange={(event) =>
                                    updateReply(index, replyIndex, event.target.value)
                                  }
                                />
                                <Button
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined />}
                                  aria-label={`删除第 ${replyIndex + 1} 条回复`}
                                  onClick={() => removeReply(index, replyIndex)}
                                />
                              </div>
                            ))}
                            <Button
                              size="small"
                              icon={<PlusOutlined />}
                              disabled={rule.replies.length >= MAX_REPLIES}
                              onClick={() => addReply(index)}
                            >
                              添加回复
                            </Button>
                          </Space>
                        </Form.Item>
                      </Col>
                    </Row>

                    <Form.Item label="本组命中后的状态码" style={{ marginBottom: 0 }}>
                      <Select
                        style={{ maxWidth: 320 }}
                        aria-label={`规则组 ${index + 1} 的状态码`}
                        value={rule.status}
                        onChange={(value) => updateRule(index, { status: value })}
                        options={[
                          { value: 0, label: `继承全局（${draft.blocked_status}）` },
                          ...STATUS_OPTIONS,
                        ]}
                      />
                    </Form.Item>
                  </Card>
                ))}
              </Space>
            )}

            {activeKeywords > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={`已启用 ${activeKeywords} 个关键词`}
                description="匹配的是请求正文原文的子串，一个词被两组共用时算靠前那一组。调用方看到的是一次正常回复，不会知道自己被拦截，也看不到命中了哪个词；完整命中记录只在管理员的调用日志里。过短或过于常见的词会误伤正常请求。"
              />
            )}

            {anyMasked && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 12 }}
                message="嵌入、音频、图像等接口仍会返回 401"
                description="这些接口期待的是向量或二进制，没有地方放一段文字，返回 200 会让客户端解析失败。"
              />
            )}

            {oversizedReplies > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message={`有 ${oversizedReplies} 条回复超长`}
                description={`单条回复不能超过 ${MAX_REPLY_BYTES} 字节，超过时保存会被服务端拒绝。`}
              />
            )}

            {droppedLines > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={`有 ${droppedLines} 行关键词不会生效`}
                description={`同一组内重复的词只算一次，超过 ${MAX_KEYWORD_BYTES} 字节的词会被忽略，所有组加起来最多只取前 ${MAX_KEYWORDS} 个。`}
              />
            )}
          </Form>
        </Card>

        <Card size="small" title="重试">
          <Form layout="vertical">
            <Row gutter={24}>
              <Col xs={24} md={12}>
                <Form.Item
                  label="最大重试次数"
                  help="单次请求最多尝试多少个渠道。每次重试都会重新匹配一个不同的渠道，而不是盯着同一个渠道重试。"
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    min={1}
                    max={20}
                    step={1}
                    precision={0}
                    style={{ width: '100%' }}
                    addonAfter="次"
                    value={draft.max_retries}
                    onChange={(value) => setDraft({ ...draft, max_retries: value ?? 1 })}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label="同渠道重试间隔"
                  help="换到下一个渠道重试前的停顿基数，按尝试次数递增，上限 2 秒。设为 0 则不等待。上游返回 Retry-After 时，该渠道的熔断冷却直接采用上游给定的时间。"
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    min={0}
                    max={10000}
                    step={50}
                    precision={0}
                    style={{ width: '100%' }}
                    addonAfter="毫秒"
                    value={draft.retry_backoff_ms}
                    onChange={(value) => setDraft({ ...draft, retry_backoff_ms: value ?? 0 })}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>

        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <Card size="small" title="完整日志">
              <Form layout="vertical">
                <Form.Item
                  label="保留最近多少次调用的完整正文"
                  help="在「调用日志 → 点开某一行」中查看请求和响应原文。超出条数的旧记录会自动删除；设为 0 表示不记录，并清空已有正文。"
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    min={0}
                    max={20000}
                    step={100}
                    precision={0}
                    style={{ width: '100%' }}
                    addonAfter="次"
                    value={draft.log_detail_keep}
                    onChange={(value) => setDraft({ ...draft, log_detail_keep: value ?? 0 })}
                  />
                </Form.Item>

                {draft.log_detail_keep > 0 && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginTop: 12 }}
                    message={`最多约占用 ${estimateFootprint(draft.log_detail_keep, draft.log_body_limit)}`}
                    description="按每次调用的请求与响应各达到下方上限估算；实际正文通常远小于上限。"
                  />
                )}
              </Form>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card size="small" title="正文捕获">
              <Form layout="vertical">
                <Form.Item
                  label="正文保留上限"
                  help="单条请求或响应保留的最大字节数，超出部分截断。上面的完整日志受此限制。"
                  style={{ marginBottom: 0 }}
                >
                  <Select
                    value={draft.log_body_limit}
                    onChange={(value) => setDraft({ ...draft, log_body_limit: value })}
                    options={BODY_LIMIT_OPTIONS}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Col>
        </Row>

        {dirty && (
          <div
            style={{
              alignItems: 'center',
              background: 'var(--app-surface)',
              border: '1px solid var(--app-border)',
              borderRadius: 12,
              bottom: 12,
              boxShadow: 'var(--app-shadow-lg)',
              display: 'flex',
              gap: 8,
              padding: '10px 16px',
              position: 'sticky',
              zIndex: 10,
            }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 13, marginInlineEnd: 'auto' }}>
              有未保存的修改
            </Typography.Text>
            <Button onClick={() => setDraft(settings)}>放弃修改</Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!loaded}
              onClick={() => void save()}
            >
              保存
            </Button>
          </div>
        )}
      </Space>
      )}
    </>
  )
}
