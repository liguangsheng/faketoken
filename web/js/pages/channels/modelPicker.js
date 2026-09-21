/**
 * Chooses which of an upstream's models a channel serves.
 *
 * It preselects exactly what the channel serves today — never everything
 * upstream offers, since a blanket selection turns one stray click on 保存
 * into a hundred newly routed models.
 */

import { el, replace } from '../../driver/dom.js'
import { button, checkbox, input, tag } from '../../ui/controls.js'
import { emptyState } from '../../ui/feedback.js'
import { openModal } from '../../ui/modal.js'

/**
 * Opens the picker.
 *
 *   { models, upstream, initial, channelName?, verb, onApply(models) }
 *
 * `verb` is what the confirm button says: 保存 writes to the server, 填入 to a
 * form. Closing is the caller's decision — a failed save keeps it open — so
 * `onApply` receives the closer.
 */
export function openModelPicker({ models, upstream, initial, channelName = null, verb, onApply }) {
  const selected = new Set(initial)
  const offered = new Set(upstream)
  let filter = ''

  const listSlot = el('div', { class: 'picker-list' })
  const countSlot = el('span', { class: 'text-muted text-small' })

  const filterBox = input({
    placeholder: '过滤模型',
    ariaLabel: '过滤模型',
    onInput: (value) => {
      filter = value.trim().toLowerCase()
      paint()
    },
  })
  filterBox.style.width = '220px'

  const visible = () => models.filter((item) => item.toLowerCase().includes(filter))

  const apply = button({
    variant: 'primary',
    onClick: () => onApply([...models.filter((item) => selected.has(item))], dialog.close),
  })

  const paint = () => {
    const shown = visible()

    // Nothing selected is the honest starting point for a channel that serves
    // nothing yet; say why the button is parked.
    replace(apply, el('span', {}, `${verb} ${selected.size} 个模型`))
    apply.disabled = selected.size === 0
    apply.title = selected.size === 0 ? '请先勾选要启用的模型，或点「全选」' : ''

    countSlot.textContent =
      `已选 ${selected.size} / 共 ${models.length}` +
      (selected.size === 0 ? '（默认选中该渠道原有模型）' : '')

    if (shown.length === 0) {
      replace(listSlot, emptyState({ title: '没有匹配的模型', compact: true }))
      return
    }

    replace(
      listSlot,
      shown.map((item) =>
        el('label', { class: 'picker-list__item' }, [
          checkbox({
            checked: selected.has(item),
            onChange: (checked) => {
              if (checked) selected.add(item)
              else selected.delete(item)
              paint()
            },
          }),
          el('span', { class: 'mono' }, item),
          // Configured here but absent from this probe: keeping it ticked is
          // fine, but it should not look like the upstream just confirmed it.
          !offered.has(item) &&
            Object.assign(tag('上游未提供', 'warning'), {
              title: '该模型已配置在渠道上，但本次拉取的上游列表里没有它',
            }),
        ]),
      ),
    )
  }

  const toolbar = el('div', { class: 'row row--wrap', style: { marginBottom: '12px' } }, [
    filterBox,
    button({
      label: '全选',
      onClick: () => {
        for (const item of models) selected.add(item)
        paint()
      },
    }),
    button({
      label: '添加当前筛选',
      onClick: () => {
        for (const item of visible()) selected.add(item)
        paint()
      },
    }),
    button({
      label: '清空',
      onClick: () => {
        selected.clear()
        paint()
      },
    }),
    countSlot,
  ])

  const dialog = openModal({
    title: channelName ? `「${channelName}」的上游模型` : '上游模型',
    width: 760,
    body: [toolbar, listSlot],
    footer: (close) => [button({ label: '取消', onClick: close }), apply],
  })

  paint()
  return dialog
}
