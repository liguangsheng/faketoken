import { useState } from 'react'
import { Alert, Button, Collapse, Form, Select, Space, Switch, Tag, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

import type { BlockRule } from '../../../api/types'
import EmptyState from '../../../components/EmptyState'
import RuleEditor from './RuleEditor'
import SettingsForm from './SettingsForm'
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_BYTES,
  MAX_REPLY_BYTES,
  MAX_RULES,
  STATUS_OPTIONS,
  blocklistStats,
  keptPerRule,
  nonEmpty,
  type PanelProps,
} from './shared'

/**
 * The keyword groups, one collapsible section each.
 *
 * Every group carries two textareas and a reply list, so laying them all out at
 * once buried both the summary and the global default under a page of editors.
 * Collapsed, a group states what an operator checks day to day — whether it is
 * on, how many keywords bite, how it answers — and opens only to be changed.
 */
export default function BlocklistPanel({ draft, patch }: PanelProps) {
  // Index-keyed, which holds because the keys are remapped on removal below. A
  // synthetic id on BlockRule would travel to the server for no reason.
  const [open, setOpen] = useState<string[]>([])

  const rules = draft.block_rules
  const kept = keptPerRule(rules)
  const stats = blocklistStats(draft)

  const setRules = (next: BlockRule[]) => patch({ block_rules: next })

  const updateRule = (index: number, rulePatch: Partial<BlockRule>) =>
    setRules(rules.map((rule, i) => (i === index ? { ...rule, ...rulePatch } : rule)))

  const addRule = () => {
    setRules([...rules, { name: '', enabled: true, keywords: [], replies: [''], status: 0 }])
    // A group added closed would be a row of counters with nowhere to type.
    setOpen((keys) => [...keys, String(rules.length)])
  }

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index))
    // Indices above the hole shift down by one; without this the wrong group
    // would be left standing open.
    setOpen((keys) =>
      keys
        .map(Number)
        .filter((key) => key !== index)
        .map((key) => String(key > index ? key - 1 : key)),
    )
  }

  const problems = [
    stats.oversizedReplies > 0 &&
      `有 ${stats.oversizedReplies} 条回复超过 ${MAX_REPLY_BYTES} 字节，保存会被服务端拒绝。`,
    stats.droppedLines > 0 &&
      `有 ${stats.droppedLines} 行关键词不会生效：同组内重复的词只算一次，超过 ${MAX_KEYWORD_BYTES} 字节的词会被忽略，所有组加起来最多取前 ${MAX_KEYWORDS} 个。`,
  ].filter((text): text is string => Boolean(text))

  return (
    <>
      <SettingsForm>
        <Form.Item
          label="默认状态码"
          help="命中后返回什么，每个规则组都可以单独覆盖。2xx 会把命中组的回复当作模型回复正常返回，调用方察觉不到被拦截；4xx / 5xx 则作为错误消息返回。"
          className="settings-form__last"
        >
          <Select
            aria-label="命中后默认返回的状态码"
            value={draft.blocked_status}
            onChange={(value) => patch({ blocked_status: value })}
            options={STATUS_OPTIONS}
          />
        </Form.Item>
      </SettingsForm>

      <div className="settings-rules">
        <div className="settings-rules__head">
          <Typography.Text className="settings-section__title">
            规则组
            {rules.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>
                {rules.length} 组 · 生效 {stats.activeKeywords} 个关键词
              </Typography.Text>
            )}
          </Typography.Text>
          <Button
            size="small"
            icon={<PlusOutlined />}
            disabled={rules.length >= MAX_RULES}
            onClick={addRule}
          >
            添加规则组
          </Button>
        </div>

        {rules.length === 0 ? (
          <EmptyState
            compact
            title="还没有任何屏蔽规则"
            description="按类别建组，例如「测活探测」和「破甲越狱」各一组：命中哪一组，就从那一组的预设回复里随机选一条返回。"
          />
        ) : (
          <Collapse
            activeKey={open}
            onChange={(keys) => setOpen(keys as string[])}
            items={rules.map((rule, index) => {
              const name = rule.name || `规则组 ${index + 1}`
              return {
                key: String(index),
                label: (
                  <Space size={8} wrap style={{ opacity: rule.enabled ? 1 : 0.55 }}>
                    <Typography.Text strong>{name}</Typography.Text>
                    <Tag bordered={false}>关键词 {kept[index] ?? 0}</Tag>
                    <Tag bordered={false}>回复 {nonEmpty(rule.replies)}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {rule.status ? rule.status : `${draft.blocked_status}（继承）`}
                    </Typography.Text>
                  </Space>
                ),
                extra: (
                  // Both controls sit on the header, so both have to stop the
                  // click from reaching the panel's own toggle.
                  <Space size={4} onClick={(event) => event.stopPropagation()}>
                    <Switch
                      size="small"
                      aria-label={`启用${name}`}
                      checked={rule.enabled}
                      onChange={(checked) => updateRule(index, { enabled: checked })}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除${name}`}
                      onClick={() => removeRule(index)}
                    />
                  </Space>
                ),
                children: (
                  <RuleEditor
                    rule={rule}
                    ordinal={index + 1}
                    keptKeywords={kept[index] ?? 0}
                    inheritedStatus={draft.blocked_status}
                    onChange={(rulePatch) => updateRule(index, rulePatch)}
                  />
                ),
              }
            })}
          />
        )}

        {problems.length > 0 && (
          <Alert
            type={stats.oversizedReplies > 0 ? 'error' : 'warning'}
            showIcon
            message="有配置不会按预期生效"
            description={
              <ul className="settings-problems">
                {problems.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            }
          />
        )}

        {stats.activeKeywords > 0 && (
          <Alert
            type="info"
            showIcon
            message="调用方不会知道自己被拦截"
            description={`命中的是请求正文原文的子串，一个词被两组共用时算靠前那一组。调用方看到的是一次正常回复，看不到命中了哪个词；完整命中记录只在管理员的调用日志里。${
              stats.anyMasked
                ? '嵌入、音频、图像等接口例外，它们期待向量或二进制，没有地方放一段文字，仍然返回 401。'
                : ''
            }`}
          />
        )}
      </div>
    </>
  )
}
