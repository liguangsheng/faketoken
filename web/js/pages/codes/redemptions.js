/**
 * Redemption codes: prepaid credit an administrator generates and a user
 * exchanges once, from 个人设置.
 */

import { el } from '../../driver/dom.js'
import { api } from '../../core/api.js'
import { formatMoney } from '../../core/format.js'
import { field, input, numberInput, tag } from '../../ui/controls.js'
import {
  codeCell,
  commonCreateFields,
  expiryCell,
  relativeCell,
  renderCodeList,
  statusTag,
  usedByCell,
} from './shared.js'

const KEPT_HINT = '已使用的兑换码保留作为发放记录，不能停用或删除'

export function renderRedemptions(container) {
  return renderCodeList(container, {
    title: '兑换码',
    description: '生成后发给用户，用户在个人设置中兑换即可增加余额。每个码只能使用一次。',
    unit: '个',
    codeLabel: '兑换码',
    searchPlaceholder: '搜索兑换码、备注或使用者',
    createTitle: '生成兑换码',
    emptyTitle: '还没有兑换码',
    emptyDescription: '生成一批兑换码，发给用户用于充值。',
    keptHint: KEPT_HINT,
    bulkKeptHint: '已使用的兑换码会被保留作为发放记录，不会被删除。',

    fetch: (params) => api.admin.listRedemptions(params),
    setStatus: (id, status) => api.admin.setRedemptionStatus(id, status),
    remove: (ids) => api.admin.deleteRedemptions(ids),

    columns: () => [
      {
        key: 'code',
        title: '兑换码',
        width: 240,
        render: (row) => codeCell(row.code, '兑换码'),
      },
      {
        key: 'note',
        title: '备注',
        width: 130,
        at: 'lg',
        render: (row) =>
          row.name
            ? el('span', { class: 'truncate', title: row.name }, row.name)
            : el('span', { class: 'text-faint' }, '-'),
      },
      {
        key: 'group',
        title: '分组',
        width: 120,
        at: 'lg',
        render: (row) =>
          row.group
            ? tag(row.group, 'brand')
            : el('span', { class: 'text-faint' }, '-'),
      },
      {
        key: 'amount',
        title: '面额',
        width: 100,
        align: 'right',
        render: (row) => formatMoney(row.quota),
      },
      {
        key: 'status',
        title: '状态',
        width: 90,
        render: (row) => statusTag(row.status, row.expires_at),
      },
      {
        key: 'usedBy',
        title: '使用者',
        width: 120,
        at: 'md',
        render: (row) => usedByCell(row.used_by_name, row.used_at, '兑换'),
      },
      {
        key: 'expiresAt',
        title: '有效期',
        width: 150,
        at: 'lg',
        render: (row) => expiryCell(row.expires_at),
      },
      {
        key: 'createdAt',
        title: '创建时间',
        width: 110,
        at: 'lg',
        render: (row) => relativeCell(row.created_at),
      },
    ],

    createFields: () => {
      const common = commonCreateFields({
        countHint: '一次最多生成 200 个。',
        noteHint: '仅管理员可见，用于标记这批码的用途。',
        notePlaceholder: '例如：双十一活动',
      })

      const amount = numberInput({ id: 'code-amount', value: 5, min: 0.01, step: 1 })
      const amountField = field({
        label: '面额（美元）',
        control: amount,
        htmlFor: 'code-amount',
      })

      const group = input({
        id: 'code-group',
        placeholder: '留空表示不限制，例如 double-eleven',
      })
      const groupField = field({
        label: '活动分组',
        control: group,
        htmlFor: 'code-group',
        hint: '填写后，同一分组的兑换码每个用户只能使用一个；留空则不限制。',
      })

      return {
        nodes: [
          amountField,
          common.countField,
          common.noteField,
          groupField,
          common.expiresField,
        ],
        read: () => ({
          ...common.read(),
          amount_usd: amount.read() ?? 0,
          group: group.value.trim(),
        }),
        validate: () => {
          amountField.setError(null)
          const value = amount.read()
          let ok = common.validate()
          if (value === null || !(value > 0)) {
            amountField.setError('请输入大于 0 的面额')
            ok = false
          }
          return ok
        },
      }
    },

    create: (values) =>
      api.admin.createRedemptions({
        name: values.name,
        group: values.group,
        amount_usd: values.amount_usd,
        count: values.count,
        expires_at: values.expires_at,
      }),

    resultHint: (count, values) =>
      `已生成 ${count} 个面额 $${values.amount_usd} 的兑换码，复制后发给用户：`,
  })
}
