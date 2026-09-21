/**
 * Invite codes: one code buys exactly one account, when registration is
 * gated behind them.
 */

import { el } from '../../driver/dom.js'
import { api } from '../../core/api.js'
import { get as consoleSettings } from '../../core/settings.js'
import * as router from '../../core/router.js'
import { banner, button } from '../../ui/controls.js'
import {
  codeCell,
  commonCreateFields,
  expiryCell,
  relativeCell,
  renderCodeList,
  statusTag,
  usedByCell,
} from './shared.js'

const KEPT_HINT = '已使用的邀请码保留作为注册记录，不能停用或删除'

export function renderInvites(container) {
  return renderCodeList(container, {
    title: '邀请码',
    description: '生成后发给受邀者，注册时填写即可创建账号。每个邀请码只能注册一个账号。',
    unit: '个',
    codeLabel: '邀请码',
    searchPlaceholder: '搜索邀请码、备注或使用者',
    createTitle: '生成邀请码',
    emptyTitle: '还没有邀请码',
    emptyDescription: '生成一批邀请码，发给你想邀请的人。',
    keptHint: KEPT_HINT,
    bulkKeptHint: '已使用的邀请码会被保留作为注册记录，不会被删除。',

    // Generating codes while nothing asks for them is a common way to be
    // confused later, so the state of the switch is stated up front.
    notice: consoleSettings().require_invite_code ? null : registrationNotice(),

    fetch: (params) => api.admin.listInvites(params),
    setStatus: (id, status) => api.admin.setInviteStatus(id, status),
    remove: (ids) => api.admin.deleteInvites(ids),

    columns: () => [
      {
        key: 'code',
        title: '邀请码',
        width: 240,
        render: (row) => codeCell(row.code, '邀请码'),
      },
      {
        key: 'note',
        title: '备注',
        at: 'lg',
        render: (row) =>
          row.name
            ? el('span', { class: 'truncate', title: row.name }, row.name)
            : el('span', { class: 'text-faint' }, '-'),
      },
      {
        key: 'status',
        title: '状态',
        width: 100,
        render: (row) => statusTag(row.status, row.expires_at),
      },
      {
        key: 'usedBy',
        title: '使用者',
        width: 140,
        at: 'md',
        render: (row) => usedByCell(row.used_by_name, row.used_at, '注册'),
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
        width: 140,
        at: 'lg',
        render: (row) => relativeCell(row.created_at),
      },
    ],

    createFields: () => {
      const common = commonCreateFields({
        countHint: '一次最多生成 200 个。',
        noteHint: '只用于你自己辨认，受邀者看不到。',
        notePlaceholder: '例如：内测第一批',
      })
      return {
        nodes: [common.countField, common.noteField, common.expiresField],
        read: common.read,
        validate: common.validate,
      }
    },

    create: (values) =>
      api.admin.createInvites({
        name: values.name,
        count: values.count,
        expires_at: values.expires_at,
      }),

    resultHint: (count) => `已生成 ${count} 个邀请码，复制后发给受邀者：`,
  })
}

function registrationNotice() {
  const node = banner({
    title: '当前注册不需要邀请码',
    description: '这些邀请码暂时不会被用到。开启「注册需要邀请码」后才会生效。',
  })
  node.append(
    el(
      'div',
      { style: { marginInlineStart: 'auto', alignSelf: 'center' } },
      button({
        label: '去开启',
        onClick: () => router.navigate('/admin/settings'),
      }),
    ),
  )
  return node
}
