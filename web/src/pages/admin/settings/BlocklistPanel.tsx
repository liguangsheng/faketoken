import { useState } from 'react'
import { Alert, Button, Drawer, Popconfirm, Select, Switch, Tag } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'

import type { BlockRule } from '../../../api/types'
import EmptyState from '../../../components/EmptyState'
import RuleEditor from './RuleEditor'
import SettingsForm, { SettingsRow, SettingsSection } from './SettingsForm'
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_BYTES,
  MAX_REPLY_BYTES,
  MAX_RULES,
  STATUS_OPTIONS,
  blocklistStats,
  byteLength,
  keptPerRule,
  nonEmpty,
  type PanelProps,
} from './shared'

export default function BlocklistPanel({ draft, disabled, patch }: PanelProps) {
  const [editing, setEditing] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const rules = draft.block_rules
  const kept = keptPerRule(rules)
  const stats = blocklistStats(draft)
  const selected = rules[editing]

  const updateRule = (index: number, next: Partial<BlockRule>) => {
    if (disabled) return
    patch({ block_rules: rules.map((rule, i) => (i === index ? { ...rule, ...next } : rule)) })
  }

  const editRule = (index: number) => {
    setEditing(index)
    setEditorOpen(true)
  }

  const addRule = () => {
    if (disabled || rules.length >= MAX_RULES) return
    patch({ block_rules: [...rules, { name: '', enabled: true, keywords: [], replies: [''], status: 0 }] })
    editRule(rules.length)
  }

  const removeRule = (index: number) => {
    if (disabled) return
    patch({ block_rules: rules.filter((_, i) => i !== index) })
    setEditing((current) => (current > index ? current - 1 : current))
  }

  const problems = [
    stats.oversizedReplies > 0 &&
      `有 ${stats.oversizedReplies} 条回复超过 ${MAX_REPLY_BYTES} 字节，请修改后再保存。`,
    stats.droppedLines > 0 &&
      `有 ${stats.droppedLines} 行关键词不会保留：同组内重复的词只算一次，超过 ${MAX_KEYWORD_BYTES} 字节的词会被忽略，所有组共用 ${MAX_KEYWORDS} 个关键词额度。`,
  ].filter((text): text is string => Boolean(text))

  return (
    <>
      <SettingsForm>
        <SettingsSection title="默认响应" description="规则组可以继承此设置，也可以单独指定状态码。">
          <SettingsRow
            label="命中后返回"
            description="低于 400 时，将预设文本作为模型回复返回；400 及以上作为错误消息返回。"
            details={{
              title: '不同接口的返回方式',
              content:
                '伪装成正常回复时，调用方看不到命中信息。嵌入、音频、图像等接口期待向量或二进制，无法承载这段文本，仍返回 401。完整命中记录仅管理员可见。',
            }}
          >
            {(control) => (
              <Select
                {...control}
                className="settings-control"
                value={draft.blocked_status}
                onChange={(value) => patch({ blocked_status: value })}
                options={STATUS_OPTIONS}
                popupMatchSelectWidth={300}
              />
            )}
          </SettingsRow>
        </SettingsSection>
      </SettingsForm>

      <section className="settings-rules">
        <header className="settings-rules__head">
          <div>
            <h2 className="settings-section__title">规则组</h2>
            <p className="settings-section__description">
              {rules.length} / {MAX_RULES} 组 · 生效 {stats.activeKeywords} 个关键词，按顺序匹配。
            </p>
          </div>
          <Button
            aria-label="添加规则组"
            icon={<PlusOutlined />}
            disabled={disabled || rules.length >= MAX_RULES}
            onClick={addRule}
          >
            添加规则组
          </Button>
        </header>

        {rules.length === 0 ? (
          <EmptyState
            compact
            title="还没有屏蔽规则"
            description="按用途创建规则组，分别设置关键词与回复。命中某一组后，从该组的预设回复中随机选一条返回。"
          />
        ) : (
          <ol className="settings-rule-list">
            {rules.map((rule, index) => {
              const name = rule.name || `规则组 ${index + 1}`
              const keywords = kept[index] ?? 0
              return (
                <li className="settings-rule" key={index}>
                  <span className="settings-rule__order" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="settings-rule__summary">
                    <div className="settings-rule__title">
                      <span>{name}</span>
                      <Tag bordered={false} color={rule.enabled && keywords > 0 ? 'success' : undefined}>
                        {!rule.enabled ? '已关闭' : keywords > 0 ? '已启用' : '无关键词'}
                      </Tag>
                      {rule.replies.some((reply) => byteLength(reply) > MAX_REPLY_BYTES) && (
                        <Tag color="error" bordered={false}>回复超限</Tag>
                      )}
                    </div>
                    <div className="settings-rule__meta">
                      <span>关键词 {keywords}</span>
                      <span>回复 {nonEmpty(rule.replies)}</span>
                      <span>{rule.status || draft.blocked_status}{rule.status === 0 ? '（继承）' : ''}</span>
                    </div>
                  </div>
                  <div className="settings-rule__actions">
                    <Switch
                      size="small"
                      aria-label={`启用${name}`}
                      checked={rule.enabled}
                      disabled={disabled}
                      onChange={(checked) => updateRule(index, { enabled: checked })}
                    />
                    <Button
                      type="text"
                      icon={<EditOutlined />}
                      aria-label={`编辑${name}`}
                      onClick={() => editRule(index)}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title={`删除“${name}”？`}
                      description="从当前草稿移除，保存全部后生效。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeRule(index)}
                      disabled={disabled}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除${name}`} />
                    </Popconfirm>
                  </div>
                </li>
              )
            })}
          </ol>
        )}

        {problems.length > 0 && (
          <Alert
            type={stats.oversizedReplies > 0 ? 'error' : 'warning'}
            showIcon
            message="部分配置需要检查"
            description={
              <ul className="settings-problems">
                {problems.map((text) => <li key={text}>{text}</li>)}
              </ul>
            }
          />
        )}
        <p className="settings-rules__note">
          匹配请求正文原文的子串，不区分大小写。同一个词出现在多组时，以靠前的组为准；过短或常见的词容易误伤。
        </p>
      </section>

      <Drawer
        title={`编辑${selected?.name || `规则组 ${editing + 1}`}`}
        open={editorOpen && Boolean(selected)}
        onClose={() => setEditorOpen(false)}
        width={760}
        destroyOnHidden
        rootClassName="settings-rule-drawer"
        footer={
          <div className="settings-rule-drawer__footer">
            <span>修改只记入草稿，尚未生效。</span>
            <Button type="primary" onClick={() => setEditorOpen(false)}>完成编辑</Button>
          </div>
        }
      >
        <p className="settings-drawer-note">完成编辑后，回到页面底部点击“保存全部”才会生效。</p>
        {selected && (
          <RuleEditor
            rule={selected}
            ordinal={editing + 1}
            keptKeywords={kept[editing] ?? 0}
            inheritedStatus={draft.blocked_status}
            disabled={disabled}
            onChange={(next) => updateRule(editing, next)}
          />
        )}
      </Drawer>
    </>
  )
}
