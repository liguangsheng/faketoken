/**
 * Group multipliers.
 *
 * A group decides two things at once — which channels a user can reach, and
 * what their traffic costs — so the editor says that out loud, and opening a
 * discounted group to everyone asks first.
 */

import { el, replace } from '../driver/dom.js'
import { api } from '../core/api.js'
import { formatRelative, formatTime } from '../core/format.js'
import { banner, button, card, field, input, pageHeader, tag, textarea, toggle } from '../ui/controls.js'
import { emptyState, skeleton } from '../ui/feedback.js'
import { confirmModal, openModal } from '../ui/modal.js'
import { table } from '../ui/table.js'
import { ICONS } from '../ui/icons.js'
import { errorText, toast } from '../ui/toast.js'

export function renderGroups(container) {
  let rows = []
  let loading = true
  let disposed = false

  const tableSlot = el('div')

  const refreshButton = button({ label: '刷新', glyph: ICONS.reload, onClick: () => load() })
  const createButton = button({
    label: '新建分组',
    variant: 'primary',
    glyph: ICONS.plus,
    onClick: () => openEditor(null),
  })

  container.append(
    el('div', { class: 'page-enter' }, [
      pageHeader({
        title: '分组倍率',
        description: '分组同时决定「可用渠道」和「计费倍率」，是权限与定价的最小单元。',
        extra: [refreshButton, createButton],
      }),
      banner({
        title: '费用 = 模型价格 × 分组倍率 × 渠道倍率',
        description:
          '用户只能路由到把自己分组列入「可用渠道」的渠道；倍率填 0 表示该分组免费使用。',
      }),
      tableSlot,
    ]),
  )

  async function load() {
    loading = true
    refreshButton.setBusy(true)
    try {
      const result = await api.admin.listGroups()
      if (disposed) return
      rows = result.data ?? []
    } catch (error) {
      if (disposed) return
      toast.error(errorText(error, '加载失败'))
    } finally {
      if (!disposed) {
        loading = false
        refreshButton.setBusy(false)
        paint()
      }
    }
  }

  /**
   * Flipped straight from the table: it is the one field an operator changes
   * on its own. Opening a discounted group is the exception — that hands the
   * discount to every user, so it asks first.
   */
  async function toggleSelectable(group, selectable, control) {
    if (selectable && group.rate < 1) {
      const confirmed = await confirmModal({
        title: `向所有用户开放「${group.name}」（×${group.rate}）？`,
        description:
          group.rate === 0
            ? '该分组倍率为 0，开放后任何用户都能把密钥指向它免费调用。'
            : `开放后任何用户都能把密钥指向该分组，按 ${group.rate} 倍计费。`,
        okText: '开放',
      })
      if (!confirmed) {
        control.setChecked(false)
        return
      }
    }

    control.setBusy(true)
    try {
      await api.admin.upsertGroup({ ...group, user_selectable: selectable })
      toast.success(selectable ? `「${group.name}」已对用户开放` : `「${group.name}」已收回`)
      await load()
    } catch (error) {
      toast.error(errorText(error, '操作失败'))
      control.setChecked(!selectable)
    } finally {
      control.setBusy(false)
    }
  }

  async function remove(group) {
    const confirmed = await confirmModal({
      title: '删除这个分组？',
      description:
        '该分组下的用户将无法匹配任何渠道，请先把他们移至其他分组。此操作不可撤销。',
      okText: '删除',
      danger: true,
    })
    if (!confirmed) return

    try {
      await api.admin.deleteGroup(group.name)
      toast.success('已删除')
      await load()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    }
  }

  /** `group` null creates; otherwise the name is fixed and only rates move. */
  function openEditor(group) {
    const editing = Boolean(group)

    const nameInput = input({
      id: 'group-name',
      value: group?.name ?? '',
      placeholder: 'vip',
      disabled: editing,
    })
    nameInput.classList.add('mono')

    const rateInput = input({
      id: 'group-rate',
      type: 'number',
      value: String(group?.rate ?? 1),
    })
    rateInput.min = '0'
    rateInput.step = '0.1'

    const selectable = toggle({
      checked: group?.user_selectable ?? false,
      ariaLabel: '允许普通用户使用',
      onChange: (next, control) => control.setChecked(next),
    })
    const description = textarea({
      id: 'group-desc',
      value: group?.description ?? '',
      placeholder: '例如：内部团队专用，走高优先级渠道',
    })

    const nameField = field({
      label: '分组名',
      control: nameInput,
      htmlFor: 'group-name',
      hint: editing ? '创建后不可修改' : '建议用英文小写，创建后不可修改',
    })
    const rateField = field({
      label: '计费倍率',
      control: rateInput,
      htmlFor: 'group-rate',
      hint: '1 表示原价，0.5 表示五折，0 表示免费',
    })
    const selectableField = field({
      label: '允许普通用户使用',
      control: selectable,
      hint: '分组同时决定可用渠道和计费倍率，开放低倍率分组等于给所有人打折。',
    })

    // The warnings that depend on the value, refreshed as it is typed.
    const rateNote = el('div', { class: 'field__hint' })
    const paintRateNote = () => {
      const value = Number(rateInput.value)
      if (value === 0) rateNote.textContent = '倍率为 0：该分组将免费使用，不产生任何扣费。'
      else if (value > 10) rateNote.textContent = '倍率异常偏高，请确认不是想输入小数。'
      else rateNote.textContent = ''
    }
    rateInput.addEventListener('input', paintRateNote)
    paintRateNote()

    openModal({
      title: editing ? `编辑分组：${group.name}` : '新建分组',
      body: [
        editing &&
          banner({
            type: 'warning',
            title: '倍率修改保存后立即生效，影响该分组所有用户的后续计费。',
          }),
        nameField,
        rateField,
        rateNote,
        selectableField,
        field({ label: '说明', control: description, htmlFor: 'group-desc' }),
        el(
          'div',
          { class: 'field__hint' },
          '新分组创建后，记得在「渠道管理」里把它加入对应渠道的可用分组。',
        ),
      ],
      footer: (close) => [
        button({ label: '取消', onClick: close }),
        button({
          label: '保存',
          variant: 'primary',
          onClick: async () => {
            nameField.setError(null)
            rateField.setError(null)

            const name = nameInput.value.trim()
            const rate = Number(rateInput.value)
            let ok = true
            if (!name) {
              nameField.setError('请输入分组名')
              ok = false
            }
            if (!Number.isFinite(rate) || rate < 0) {
              rateField.setError('请输入不小于 0 的倍率')
              ok = false
            }
            if (!ok) return

            try {
              await api.admin.upsertGroup({
                name,
                rate,
                description: description.value.trim(),
                user_selectable: selectable.checked,
              })
              toast.success(`「${name}」已保存，倍率 ×${rate} 立即生效`)
              close()
              await load()
            } catch (error) {
              toast.error(errorText(error, '保存失败'))
            }
          },
        }),
      ],
    })
  }

  function rateTag(rate) {
    let tone = null
    if (rate === 0) tone = 'success'
    else if (rate < 1) tone = 'brand'
    else if (rate > 1) tone = 'warning'
    return tag(`× ${rate}`, tone)
  }

  function paint() {
    if (loading) {
      replace(tableSlot, card({ body: skeleton(6) }))
      return
    }

    replace(
      tableSlot,
      table({
        caption: '分组倍率列表',
        rowKey: (row) => row.name,
        rows,
        empty: emptyState({
          title: '还没有分组',
          description: '系统至少需要一个 default 分组。',
          action: button({
            label: '新建分组',
            variant: 'primary',
            glyph: ICONS.plus,
            onClick: () => openEditor(null),
          }),
        }),
        columns: [
          {
            key: 'name',
            title: '分组名',
            width: 180,
            render: (row) =>
              el('div', { class: 'row', style: { gap: '6px' } }, [
                el('strong', { class: 'mono' }, row.name),
                row.name === 'default' && tag('默认', 'brand'),
              ]),
          },
          { key: 'rate', title: '计费倍率', width: 140, render: (row) => rateTag(row.rate) },
          {
            key: 'selectable',
            title: '用户可选',
            width: 120,
            at: 'md',
            render: (row) =>
              toggle({
                checked: row.user_selectable,
                ariaLabel: `允许普通用户使用「${row.name}」分组`,
                onChange: (next, control) => {
                  control.setChecked(next)
                  void toggleSelectable(row, next, control)
                },
              }),
          },
          {
            key: 'description',
            title: '说明',
            at: 'lg',
            render: (row) =>
              row.description
                ? el('span', { class: 'truncate', title: row.description }, row.description)
                : el('span', { class: 'text-faint' }, '-'),
          },
          {
            key: 'createdAt',
            title: '创建时间',
            width: 140,
            at: 'lg',
            render: (row) =>
              el('span', { title: formatTime(row.created_at) }, formatRelative(row.created_at)),
          },
          {
            key: 'actions',
            title: '操作',
            width: 130,
            render: (row) =>
              el('div', { class: 'table__actions' }, [
                button({ label: '编辑', variant: 'link', onClick: () => openEditor(row) }),
                button({
                  label: '删除',
                  variant: 'link danger',
                  // The default group is what every unassigned user falls back
                  // to; deleting it would strand them with no channels at all.
                  disabled: row.name === 'default',
                  title: row.name === 'default' ? '默认分组不可删除' : null,
                  onClick: () => remove(row),
                }),
              ]),
          },
        ],
      }),
    )
  }

  paint()
  void load()

  return () => {
    disposed = true
  }
}
