/**
 * Pasting a provider's credentials and getting a channel draft back.
 *
 * Nothing is written here: the result is handed to the channel form, and a
 * bad guess costs one cancel. Parsing is a pure server-side string operation,
 * so the paste is re-read on every pause; probing the upstream for its model
 * list is a separate, explicit step.
 */

import { el, replace } from '../../driver/dom.js'
import { api } from '../../core/api.js'
import { get as consoleSettings } from '../../core/settings.js'
import { banner, button, field, input, textarea } from '../../ui/controls.js'
import { openModal } from '../../ui/modal.js'
import { errorText, toast } from '../../ui/toast.js'

const PARSE_DELAY_MS = 400

/**
 * Opens the dialog. `onApply(channel, overrides)` receives the existing row
 * when the paste names an upstream that is already configured, else
 * undefined; `overrides` seed the form either way.
 */
export function openQuickImport({ onApply }) {
  let preview = null
  let parseTimer = null
  let parseSeq = 0

  const text = textarea({
    id: 'import-text',
    rows: 5,
    placeholder: '接口地址：https://api.example.com/v1\nAPI Key: sk-...',
  })
  const baseURL = input({ id: 'import-url', placeholder: 'https://api.example.com/v1', ariaLabel: '接口地址' })
  const apiKey = input({ id: 'import-key', placeholder: 'sk-...', ariaLabel: '上游密钥' })

  const previewSlot = el('div')

  const probeButton = button({
    label: '拉取模型',
    disabled: true,
    title: '先粘贴或填写接口地址',
    onClick: () => probe(),
  })
  const applyButton = button({
    label: '填入表单',
    variant: 'primary',
    disabled: true,
    onClick: () => apply(),
  })

  const paintButtons = () => {
    probeButton.disabled = !baseURL.value.trim()
    probeButton.title = baseURL.value.trim() ? '' : '先粘贴或填写接口地址'
    applyButton.disabled = !preview
  }
  baseURL.addEventListener('input', paintButtons)

  // Editing the text replaces whatever the previous parse produced, which
  // makes the paste the source of truth; a manual fix to either field
  // survives until the text itself changes again.
  text.addEventListener('input', () => {
    window.clearTimeout(parseTimer)
    const trimmed = text.value.trim()
    if (!trimmed) return
    parseTimer = window.setTimeout(async () => {
      const seq = ++parseSeq
      try {
        const result = await api.admin.importChannel({ text: trimmed, skip_models: true })
        if (seq !== parseSeq) return
        baseURL.value = result.base_url
        apiKey.value = result.api_key
        // Keep models already pulled for this very address: editing an
        // unrelated line of the paste should not throw away a probe.
        preview =
          preview && preview.base_url === result.base_url
            ? { ...result, models: preview.models, model_error: preview.model_error }
            : result
        paintPreview()
        paintButtons()
      } catch {
        // Half-typed text has no address yet. That is the normal state while
        // someone is still pasting, not something worth interrupting them for.
      }
    }, PARSE_DELAY_MS)
  })

  // Manual corrections in the two fields win here: by the time someone
  // presses the button, those are the values they want probed.
  async function probe() {
    probeButton.setBusy(true)
    try {
      const result = await api.admin.importChannel({
        text: text.value,
        base_url: baseURL.value.trim() || undefined,
        api_key: apiKey.value.trim() || undefined,
      })
      preview = result
      baseURL.value = result.base_url
      apiKey.value = result.api_key
      if (result.model_error) toast.warning(`已识别地址和密钥，但拉取模型失败：${result.model_error}`)
      paintPreview()
      paintButtons()
    } catch (error) {
      toast.error(errorText(error, '解析失败'))
    } finally {
      probeButton.setBusy(false)
    }
  }

  async function apply() {
    if (!preview) return
    const existing = preview.existing_channel

    const overrides = {
      base_url: preview.base_url,
      auth_style: preview.auth_style,
      api_key: preview.api_key,
      supported_protocols: preview.supported_protocols ?? [],
    }
    // Only a successful probe overrides the model list; an existing channel
    // keeps its own when nothing was pulled.
    if (preview.models.length > 0) overrides.models = preview.models

    if (existing) {
      // Load the row rather than reusing the list page: editing the full
      // record keeps everything the import cannot know — groups, priority,
      // price ratio — instead of silently resetting it to defaults.
      try {
        const current = await api.admin.getChannel(existing.id)
        dialog.close()
        onApply(current, overrides)
        toast.info(`将覆盖已有渠道「${existing.name}」，确认后保存`)
      } catch (error) {
        toast.error(errorText(error, '读取同名渠道失败'))
      }
      return
    }

    // The import defaults apply here only. The branch above edits an existing
    // channel, where overwriting priority and weight would discard settings
    // the import knows nothing about.
    const settings = consoleSettings()
    dialog.close()
    onApply(undefined, {
      ...overrides,
      name: preview.suggested_name,
      priority: settings.import_priority,
      weight: settings.import_weight,
    })
  }

  function paintPreview() {
    if (!preview) {
      replace(previewSlot, null)
      return
    }

    const modelCount = preview.models.length
    let modelText = el('span', { class: 'text-muted' }, '未拉取')
    if (modelCount > 0) {
      const full = modelCount > 20
        ? `${preview.models.slice(0, 20).join('、')} …等 ${modelCount} 个`
        : preview.models.join('、')
      modelText = el('span', { title: full }, `已拉取 ${modelCount} 个`)
    }

    replace(previewSlot, [
      preview.existing_channel &&
        banner({
          type: 'warning',
          title: `已存在同名渠道「${preview.existing_channel.name}」`,
          description: '填入表单后会以覆盖方式编辑该渠道，而不是新建。',
        }),
      preview.model_error && banner({ type: 'warning', title: '拉取模型失败', description: preview.model_error }),
      el('dl', { class: 'desc' }, [
        el('dt', {}, '建议名称'),
        el('dd', {}, preview.suggested_name || '未识别'),
        el('dt', {}, '模型'),
        el('dd', {}, modelText),
      ]),
    ])
  }

  const dialog = openModal({
    title: '快速导入渠道',
    width: 640,
    onClose: () => window.clearTimeout(parseTimer),
    body: [
      el(
        'p',
        { class: 'text-muted text-small' },
        '把服务商给的地址和密钥整段贴进来即可，也支持 curl 命令，停顿即自动识别；识别结果可以手动修正，修改上方文本会重新覆盖。',
      ),
      text,
      el('div', { class: 'form-cols', style: { marginTop: '12px' } }, [
        field({ label: '接口地址', control: baseURL, htmlFor: 'import-url' }),
        field({ label: '密钥', control: apiKey, htmlFor: 'import-key' }),
      ]),
      previewSlot,
    ],
    footer: (close) => [button({ label: '取消', onClick: close }), probeButton, applyButton],
  })

  text.focus()
  return dialog
}
