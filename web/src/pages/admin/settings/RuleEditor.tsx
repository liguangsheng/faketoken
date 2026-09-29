import { Button, Form, Input, Select, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

import type { BlockRule } from '../../../api/types'
import { MAX_REPLIES, MAX_RULE_NAME, STATUS_OPTIONS, nonEmpty } from './shared'

interface Props {
  rule: BlockRule
  /** Only for the placeholder and the aria labels of an unnamed group. */
  ordinal: number
  /** Reported so the label can state what the relay will actually match on. */
  keptKeywords: number
  /** What "inherit" resolves to right now, shown rather than implied. */
  inheritedStatus: number
  onChange: (patch: Partial<BlockRule>) => void
}

/**
 * The body of one collapsed group: what it is called, what it matches, what it
 * answers with, and how.
 *
 * Two columns, and everything lives in one of them rather than straddling both.
 * Keywords and replies are read against each other — a pool of one reply
 * against forty keywords is the kind of thing you only notice with both in
 * view — and putting the name and the status inside the left column instead of
 * above the pair gives every field in a column one shared width, in the
 * two-column layout and in the stacked one alike.
 */
export default function RuleEditor({
  rule,
  ordinal,
  keptKeywords,
  inheritedStatus,
  onChange,
}: Props) {
  const fallbackName = `规则组 ${ordinal}`

  const updateReply = (replyIndex: number, text: string) =>
    onChange({ replies: rule.replies.map((reply, i) => (i === replyIndex ? text : reply)) })

  const removeReply = (replyIndex: number) =>
    onChange({ replies: rule.replies.filter((_, i) => i !== replyIndex) })

  return (
    <Form layout="vertical">
      <div className="settings-rule-form__cols">
        <div>
          <Form.Item label="组名" help="只出现在管理员的日志里，不会发给调用方。">
            <Input
              maxLength={MAX_RULE_NAME}
              placeholder={fallbackName}
              aria-label={`${fallbackName}名称`}
              value={rule.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Form.Item>

          <Form.Item
            label={`关键词（生效 ${keptKeywords} 个）`}
            help="每行一个，不区分大小写，匹配请求正文原文的子串。过短或过于常见的词会误伤正常请求。"
          >
            <Input.TextArea
              autoSize={{ minRows: 6, maxRows: 16 }}
              placeholder={'例如：\nping\n你是什么模型'}
              aria-label={`${fallbackName}的关键词`}
              value={rule.keywords.join('\n')}
              onChange={(event) => onChange({ keywords: event.target.value.split('\n') })}
            />
          </Form.Item>

          <Form.Item label="本组状态码" className="settings-form__last">
            <Select
              aria-label={`${fallbackName}的状态码`}
              value={rule.status}
              onChange={(value) => onChange({ status: value })}
              options={[{ value: 0, label: `继承默认（${inheritedStatus}）` }, ...STATUS_OPTIONS]}
            />
          </Form.Item>
        </div>

        <div>
          <Form.Item
            label={`预设回复（${nonEmpty(rule.replies)} 条）`}
            help={
              nonEmpty(rule.replies) > 1
                ? '每次命中从中随机选一条返回。'
                : '多填几条，命中时会随机选一条；一条不填则使用内置默认文本。'
            }
            className="settings-form__last"
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {rule.replies.map((reply, replyIndex) => (
                <div key={replyIndex} className="settings-reply">
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    placeholder="留空的条目不会保存"
                    aria-label={`${fallbackName}的第 ${replyIndex + 1} 条回复`}
                    value={reply}
                    onChange={(event) => updateReply(replyIndex, event.target.value)}
                  />
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`删除第 ${replyIndex + 1} 条回复`}
                    onClick={() => removeReply(replyIndex)}
                  />
                </div>
              ))}
              <Button
                size="small"
                icon={<PlusOutlined />}
                disabled={rule.replies.length >= MAX_REPLIES}
                onClick={() => onChange({ replies: [...rule.replies, ''] })}
              >
                添加回复
              </Button>
            </Space>
          </Form.Item>
        </div>
      </div>
    </Form>
  )
}
