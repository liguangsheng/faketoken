import { useLayoutEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal, Space, Tag, Tooltip, Typography } from 'antd'

import EmptyState from '../../../components/EmptyState'

export interface ModelPickerState {
  /** Everything on offer: what upstream returned, plus what is configured. */
  models: string[]
  /** What upstream actually returned this time. */
  upstream: string[]
  /** Ticked when the picker opens: what the channel serves today. */
  initial: string[]
  /** Named in the title when the choice saves straight to a channel. */
  channelName?: string
}

interface Props {
  state: ModelPickerState | null
  /** The verb on the confirm button: 保存 writes to the server, 填入 to a form. */
  verb: '保存' | '填入'
  onCancel: () => void
  /** Closing is the caller's decision: a failed save keeps the picker open. */
  onApply: (models: string[]) => void | Promise<void>
}

/**
 * ModelPickerModal chooses which of an upstream's models a channel serves. It
 * preselects exactly what the channel serves today — never everything upstream
 * offers, since a blanket selection turns one stray click on 保存 into a
 * hundred newly routed models.
 */
export default function ModelPickerModal({ state, verb, onCancel, onApply }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')

  // Before paint: the dialog stays mounted between openings, and a first frame
  // showing the previous channel's ticks under this one's title is a glitch.
  useLayoutEffect(() => {
    if (!state) return
    setSelected(state.initial)
    setFilter('')
  }, [state])

  const visible = (state?.models ?? []).filter((item) =>
    item.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <Modal
      open={Boolean(state)}
      width={760}
      title={state?.channelName ? `「${state.channelName}」的上游模型` : '上游模型'}
      onCancel={onCancel}
      onOk={() => void onApply(selected)}
      okText={`${verb} ${selected.length} 个模型`}
      okButtonProps={{
        disabled: selected.length === 0,
        // Nothing selected is the honest starting point for a channel that
        // serves nothing yet; say why the button is parked.
        title: selected.length === 0 ? '请先勾选要启用的模型，或点「全选」' : undefined,
      }}
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          allowClear
          placeholder="过滤模型"
          aria-label="过滤模型"
          style={{ width: 220 }}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button onClick={() => setSelected(state?.models ?? [])}>全选</Button>
        <Button
          onClick={() =>
            setSelected((current) =>
              Array.from(new Set([...current, ...visible])),
            )
          }
        >
          添加当前筛选
        </Button>
        <Button onClick={() => setSelected([])}>清空</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已选 {selected.length} / 共 {state?.models.length ?? 0}
          {selected.length === 0 && '（默认选中该渠道原有模型）'}
        </Typography.Text>
      </Space>

      <div
        style={{
          border: '1px solid var(--app-border)',
          borderRadius: 10,
          maxHeight: 380,
          overflow: 'auto',
          padding: 12,
        }}
      >
        {visible.length ? (
          <Checkbox.Group
            value={selected}
            onChange={(values) => setSelected(values as string[])}
            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            {visible.map((item) => (
              <Checkbox key={item} value={item} className="mono">
                {item}
                {/* Configured here but absent from this probe: keeping it
                    ticked is fine, but it should not look like the upstream
                    just confirmed it. */}
                {state && !state.upstream.includes(item) && (
                  <Tooltip title="该模型已配置在渠道上，但本次拉取的上游列表里没有它">
                    <Tag color="gold" style={{ marginInlineStart: 8 }}>
                      上游未提供
                    </Tag>
                  </Tooltip>
                )}
              </Checkbox>
            ))}
          </Checkbox.Group>
        ) : (
          <EmptyState title="没有匹配的模型" compact />
        )}
      </div>
    </Modal>
  )
}
