/**
 * Probes one channel.
 *
 * The prompt starts from a random built-in: it makes a meaningful probe one
 * click away, and varying the question stops a channel from looking healthy
 * just because it caches one familiar answer. Clearing the box asks for a
 * connectivity-only probe instead.
 */

import { el, replace } from '../../driver/dom.js'
import { api } from '../../core/api.js'
import { formatDuration, formatNumber } from '../../core/format.js'
import { banner, button, field, input, select, tag, textarea } from '../../ui/controls.js'
import { openModal } from '../../ui/modal.js'
import { errorText, toast } from '../../ui/toast.js'
import { TEST_PROTOCOLS } from './shared.js'

// The templates are compiled into the server, so one fetch per page load is
// enough; a failure just leaves the custom prompt box.
let templates = null
async function loadTemplates() {
  if (templates) return templates
  try {
    const response = await api.admin.promptTemplates()
    templates = response.data ?? []
  } catch {
    templates = []
  }
  return templates
}

/** A random built-in prompt, or nothing before the templates have arrived. */
const pick = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null)

/**
 * Opens the dialog for `channel`. `onTested` is called after a probe, because
 * it stamps tested_at on the row and the listing should reload.
 */
export async function openTestDialog(channel, { onTested }) {
  const list = await loadTemplates()

  // A channel answers for its own model list plus every model_mapping key:
  // the key is the name a caller requests, which the relay rewrites before the
  // request leaves. Those are the ones most worth probing — the rewrite is
  // the part that can be wrong.
  const mapping = channel.model_mapping ?? {}
  const names = []
  for (const name of [...(channel.models ?? []), ...Object.keys(mapping)]) {
    if (name && !names.includes(name)) names.push(name)
  }

  // A mapping-only channel has no channel.models to fall back on, and left
  // blank the probe would resolve nothing.
  const initialModel = channel.test_model || channel.models[0] || Object.keys(mapping)[0] || ''

  const listId = `test-models-${channel.id}`
  const model = input({ id: 'test-model', value: initialModel, placeholder: '留空则用渠道配置的测试模型' })
  model.setAttribute('list', listId)
  model.autocomplete = 'off'
  // Spell out what an alias resolves to: picking one should not hide which
  // upstream model the probe will actually ask for.
  const datalist = el(
    'datalist',
    { id: listId },
    names.map((name) => el('option', { value: name, label: mapping[name] ? `${name} → ${mapping[name]}` : null })),
  )

  const protocol = select({
    id: 'test-protocol',
    value: 'responses',
    options: TEST_PROTOCOLS,
  })

  const picked = pick(list)
  const prompt = textarea({
    id: 'test-prompt',
    value: picked?.prompt ?? '',
    placeholder: '可直接编辑，或从上方选择模板；清空则只测连通性',
    rows: 5,
  })

  const template = select({
    id: 'test-template',
    value: picked?.id ?? '',
    placeholder: '选择后填入下方',
    options: list.map((item) => ({ value: item.id, label: item.name })),
    // Writes the text into the box, so what gets sent is exactly what is on
    // screen and stays editable from there.
    onChange: (id) => {
      prompt.value = list.find((item) => item.id === id)?.prompt ?? ''
      paintRunLabel()
    },
  })

  // Editing the text detaches it from the template it came from; leaving the
  // dropdown showing a name that no longer matches would misreport what is
  // about to be sent.
  prompt.addEventListener('input', () => {
    const source = list.find((item) => item.id === template.value)
    if (source && source.prompt !== prompt.value) template.value = ''
    paintRunLabel()
  })

  const resultSlot = el('div')

  const run = button({
    variant: 'primary',
    onClick: async () => {
      // Clear the previous verdict first: a lingering green "通过" over a new
      // in-flight probe reads as this run's result.
      replace(resultSlot, null)
      try {
        const response = await api.admin.testChannel(channel.id, {
          model: model.value.trim() || undefined,
          protocol: protocol.value,
          prompt: prompt.value.trim() || undefined,
        })
        replace(resultSlot, renderResult(response))
        await onTested()
      } catch (error) {
        toast.error(errorText(error, '测试失败'))
      }
    },
  })

  const paintRunLabel = () => {
    replace(run, el('span', {}, prompt.value.trim() ? '发起对话测试' : '测试连通性'))
  }
  paintRunLabel()

  openModal({
    title: `模型测试：${channel.name}`,
    width: 720,
    body: [
      el('div', { class: 'form-cols' }, [
        field({ label: '模型', control: el('div', {}, [model, datalist]), htmlFor: 'test-model' }),
        field({ label: '请求协议', control: protocol, htmlFor: 'test-protocol' }),
        field({ label: '提示词模板', control: template, htmlFor: 'test-template' }),
      ]),
      field({ label: '提示词', control: prompt, htmlFor: 'test-prompt' }),
      el(
        'p',
        { class: 'text-muted text-small' },
        '对话测试会真实消耗上游额度（上限 1024 tokens）；清空提示词则只发 1 个 token 测连通性。',
      ),
      resultSlot,
    ],
    footer: (close) => [button({ label: '关闭', onClick: close }), run],
  })
}

function renderResult(result) {
  const rows = [
    ['结果', result.ok ? tag('通过', 'success') : tag('失败', 'danger')],
    ['状态码', String(result.status || '-')],
    [
      '模型',
      el('span', {}, [
        el('span', { class: 'mono' }, result.model),
        // An alias and its target are different names for different things;
        // showing only the requested one hides where the probe actually went.
        result.upstream_model &&
          result.upstream_model !== result.model &&
          el('span', { class: 'mono', style: { opacity: '0.55' } }, ` → ${result.upstream_model}`),
      ]),
    ],
    ['耗时', formatDuration(result.latency_ms)],
  ]

  const usage = result.usage
  if (usage && (usage.total_tokens > 0 || usage.prompt_tokens > 0 || usage.completion_tokens > 0)) {
    const total = usage.total_tokens || usage.prompt_tokens + usage.completion_tokens
    rows.push([
      'Token 用量',
      `输入 ${formatNumber(usage.prompt_tokens)} · 输出 ${formatNumber(usage.completion_tokens)} · 合计 ${formatNumber(total)}`,
    ])
  }

  const desc = el(
    'dl',
    { class: 'desc' },
    rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]),
  )

  return el('div', { class: 'stack', style: { gap: '12px', marginTop: '4px' } }, [
    desc,
    result.reply &&
      el('div', {}, [
        el('div', { class: 'field__label' }, '模型回复'),
        el('pre', { class: 'code-block', style: { maxHeight: '300px' } }, result.reply),
      ]),
    !result.ok &&
      (() => {
        const notice = banner({ type: 'warning', title: '测试失败' })
        notice.lastElementChild.append(
          el(
            'pre',
            { class: 'code-block', style: { maxHeight: '220px', marginTop: '8px' } },
            result.message || '上游未返回具体错误',
          ),
        )
        return notice
      })(),
  ])
}
