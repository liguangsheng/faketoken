import { useId } from 'react'
import { Button, Form, Input, Select } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

import type { BlockRule } from '../../../api/types'
import { MAX_REPLIES, MAX_REPLY_BYTES, MAX_RULE_NAME, STATUS_OPTIONS, byteLength, nonEmpty } from './shared'

interface Props {
  rule: BlockRule
  ordinal: number
  keptKeywords: number
  inheritedStatus: number
  disabled: boolean
  onChange: (patch: Partial<BlockRule>) => void
}

export default function RuleEditor({
  rule,
  ordinal,
  keptKeywords,
  inheritedStatus,
  disabled,
  onChange,
}: Props) {
  const id = useId()
  const fallbackName = `规则组 ${ordinal}`
  const dropped = nonEmpty(rule.keywords) - keptKeywords

  const updateReply = (replyIndex: number, text: string) =>
    onChange({ replies: rule.replies.map((reply, i) => (i === replyIndex ? text : reply)) })

  const removeReply = (replyIndex: number) =>
    onChange({ replies: rule.replies.filter((_, i) => i !== replyIndex) })

  return (
    <Form layout="vertical" disabled={disabled} className="settings-rule-form">
      <div className="settings-rule-form__cols">
        <Form.Item label="组名" htmlFor={`${id}-name`} help="仅管理员可见，不会返回给调用方。">
          <Input
            id={`${id}-name`}
            autoFocus
            maxLength={MAX_RULE_NAME}
            placeholder={fallbackName}
            aria-label={`${fallbackName}名称`}
            value={rule.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Form.Item>
        <Form.Item label="本组状态码" htmlFor={`${id}-status`} help="留为继承时，随全局默认响应一起变化。">
          <Select
            id={`${id}-status`}
            aria-label={`${fallbackName}的状态码`}
            value={rule.status}
            onChange={(value) => onChange({ status: value })}
            options={[{ value: 0, label: `继承默认（${inheritedStatus}）` }, ...STATUS_OPTIONS]}
          />
        </Form.Item>
      </div>

      <div className="settings-rule-form__cols">
        <Form.Item
          label={`关键词（有效 ${keptKeywords} 个）`}
          htmlFor={`${id}-keywords`}
          validateStatus={dropped > 0 ? 'warning' : undefined}
          help={
            dropped > 0
              ? `有 ${dropped} 行重复、超长或超出总额度，保存后不会保留。`
              : '每行一个，不区分大小写，匹配请求正文原文的子串。'
          }
        >
          <Input.TextArea
            id={`${id}-keywords`}
            autoSize={{ minRows: 8, maxRows: 18 }}
            placeholder={'例如：\nping\n你是什么模型'}
            aria-label={`${fallbackName}的关键词`}
            value={rule.keywords.join('\n')}
            onChange={(event) => onChange({ keywords: event.target.value.split('\n') })}
          />
        </Form.Item>

        <div role="group" aria-labelledby={`${id}-replies`}>
          <div className="settings-rule-form__label" id={`${id}-replies`}>
            预设回复（{nonEmpty(rule.replies)} 条）
          </div>
          <p className="settings-rule-form__help">
            命中时随机选一条；全部留空则使用内置默认文本。
          </p>
          {rule.replies.map((reply, replyIndex) => {
            const size = byteLength(reply)
            const oversized = size > MAX_REPLY_BYTES
            return (
              <Form.Item
                key={replyIndex}
                className="settings-rule-reply"
                validateStatus={oversized ? 'error' : undefined}
                help={oversized ? `超出 ${size - MAX_REPLY_BYTES} 字节，无法保存。` : undefined}
              >
                <div className="settings-reply">
                  <Input.TextArea
                    autoSize={{ minRows: 3, maxRows: 10 }}
                    placeholder="空白条目不会保存"
                    aria-label={`${fallbackName}的第 ${replyIndex + 1} 条回复`}
                    value={reply}
                    status={oversized ? 'error' : undefined}
                    showCount={{ formatter: () => `${size} / ${MAX_REPLY_BYTES} 字节` }}
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
              </Form.Item>
            )
          })}
          <Button
            size="small"
            aria-label="添加回复"
            icon={<PlusOutlined />}
            disabled={disabled || rule.replies.length >= MAX_REPLIES}
            onClick={() => onChange({ replies: [...rule.replies, ''] })}
          >
            添加回复
          </Button>
        </div>
      </div>
    </Form>
  )
}
