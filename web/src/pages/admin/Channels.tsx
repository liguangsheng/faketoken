import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  BlockOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  WarningOutlined,
  WalletOutlined,
} from '@ant-design/icons'

import {
  api,
  type Channel,
  type ChannelImportPreview,
  type ChannelTestResult,
  type PromptTemplate,
  type UserGroup,
} from '../../api/client'
import EmptyState from '../../components/EmptyState'
import PageHeader from '../../components/PageHeader'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useSettings } from '../../settings/SettingsContext'
import {
  formatDuration,
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
  parseList,
  parseMapping,
  STATUS,
  stringifyMapping,
} from '../../utils/format'

const AUTH_STYLES = [
  { value: 'auto', label: '自动（按请求端点）' },
  { value: 'bearer', label: 'Authorization: Bearer' },
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'x-goog-api-key', label: 'X-Goog-Api-Key' },
]

const TEST_PROTOCOLS = [
  { value: 'responses', label: 'Responses' },
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'messages', label: 'Messages' },
] as const

type TestProtocol = (typeof TEST_PROTOCOLS)[number]['value']

// Wide enough not to get in the way, bounded so the value still fits the int32
// columns it lands in. The weight floor is 1 because selection treats weight as
// a share of the draw, so a zero would take the channel out of rotation without
// it ever showing as disabled — the server clamps it for the same reason.
const MIN_PRIORITY = -1_000_000
const MAX_PRIORITY = 1_000_000
const MIN_WEIGHT = 1
const MAX_WEIGHT = 1_000_000

function statusHint(channel: Channel) {
  if (channel.status === STATUS.ENABLED) return '已启用，点击停止向该渠道转发'
  return '已禁用，点击恢复转发'
}

type InlineNumberProps = {
  value: number
  /** Short marker kept with the value, so a bare number is still readable. */
  prefix: string
  /** What the number is, for the tooltip and for screen readers. */
  label: string
  hint: string
  color?: string
  min?: number
  max?: number
  onCommit: (next: number) => Promise<void>
}

/**
 * InlineNumber shows a value as a tag and turns it into an input on click, so a
 * number that is read from the table can also be changed there instead of
 * through the edit drawer.
 *
 * It commits on Enter or on blur and reverts on Escape. An unchanged value never
 * reaches the server, which is what stops merely tabbing through the table from
 * writing to every row it passes.
 */
function InlineNumber({
  value,
  prefix,
  label,
  hint,
  color,
  min,
  max,
  onCommit,
}: InlineNumberProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<number | null>(value)
  const [saving, setSaving] = useState(false)
  // Marks the edit as already resolved. Escape has to win over the blur that
  // follows it, and disabling a focused input while it saves blurs it too —
  // without this, either would commit a second time.
  const done = useRef(false)

  const open = () => {
    done.current = false
    setDraft(value)
    setEditing(true)
  }

  const commit = async () => {
    if (done.current) return
    // An emptied box is not a value: it means "leave this number alone".
    const typed = draft === null || Number.isNaN(draft) ? value : draft
    const next = Math.round(Math.min(Math.max(typed, min ?? -Infinity), max ?? Infinity))
    if (next === value) {
      done.current = true
      setEditing(false)
      return
    }
    done.current = true
    setSaving(true)
    try {
      await onCommit(next)
    } finally {
      // Back to the tag either way: on failure the row still holds the server's
      // value, and leaving an unfocused input open would strand the cell with a
      // number that was never saved.
      setSaving(false)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <InputNumber
        size="small"
        autoFocus
        // The steppers would take most of a column this narrow, and typing is
        // how a value gets changed here anyway.
        controls={false}
        precision={0}
        min={min}
        max={max}
        value={draft}
        disabled={saving}
        aria-label={label}
        style={{ width: '100%' }}
        onChange={(next) => setDraft(next)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            void commit()
          } else if (event.key === 'Escape') {
            done.current = true
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <Tooltip title={hint}>
      <Tag
        color={color}
        className="tag-editable"
        role="button"
        tabIndex={0}
        aria-label={`${label} ${value}，点击修改`}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            // Space would otherwise scroll the page instead of opening the box.
            event.preventDefault()
            open()
          }
        }}
      >
        {prefix}
        {value}
      </Tag>
    </Tooltip>
  )
}

export default function Channels() {
  const { message, modal } = App.useApp()
  const [rows, setRows] = useState<Channel[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const { defaultPageSize, settings } = useSettings()
  // antd clamps a Modal to the viewport but not a Drawer, so a fixed width
  // hangs the left edge of this 17-field form off screen on a phone.
  const narrow = useMediaQuery('(max-width: 768px)')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [keywordInput, setKeywordInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<number>()
  const [groupFilter, setGroupFilter] = useState<string>()
  const [modelFilterInput, setModelFilterInput] = useState('')
  const [groups, setGroups] = useState<UserGroup[]>([])
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [rebuilding, setRebuilding] = useState(false)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Channel | null>(null)
  // The advanced connection fields fold away: a new channel needs three
  // fields, not seventeen.
  const [connOpen, setConnOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingCredential, setLoadingCredential] = useState(false)
  const [credentialFailed, setCredentialFailed] = useState(false)
  const credentialRequest = useRef(0)
  const [form] = Form.useForm()

  // channel is set when the picker saves straight to the server; toForm marks
  // the drawer flow, where the choice is written back into the edit form.
  // Only used when the clipboard is unavailable, which happens over plain HTTP.
  const [revealed, setRevealed] = useState<{ name: string; text: string } | null>(null)
  const [picker, setPicker] = useState<
    { models: string[]; channel?: Channel; toForm?: boolean } | null
  >(null)
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [pickerFilter, setPickerFilter] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)

  const [tester, setTester] = useState<{ channel: Channel; result?: ChannelTestResult } | null>(
    null,
  )
  const [testModel, setTestModel] = useState('')
  const [testProtocol, setTestProtocol] = useState<TestProtocol>('responses')
  const [testTemplate, setTestTemplate] = useState('')
  const [testPrompt, setTestPrompt] = useState('')
  const [testing, setTesting] = useState(false)
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [seededTest, setSeededTest] = useState(false)

  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importBaseURL, setImportBaseURL] = useState('')
  const [importKey, setImportKey] = useState('')
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<ChannelImportPreview | null>(null)

  const keyword = useDebouncedValue(keywordInput)
  const modelFilter = useDebouncedValue(modelFilterInput)
  const importTextDebounced = useDebouncedValue(importText)

  useEffect(() => {
    setPage(1)
  }, [keyword, statusFilter, groupFilter, modelFilter])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.admin.listChannels({
        page,
        page_size: pageSize,
        keyword,
        status: statusFilter,
        group: groupFilter,
        model: modelFilter || undefined,
      })
      setRows(result.data ?? [])
      setTotal(result.total)
      // Drop selections that scrolled out of the current result set, so a bulk
      // action can never touch a channel the operator can no longer see.
      const visible = new Set((result.data ?? []).map((row) => row.id))
      setSelectedIds((current) => current.filter((id) => visible.has(id)))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [groupFilter, keyword, message, modelFilter, page, pageSize, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api.admin
      .listGroups()
      .then((result) => setGroups(result.data ?? []))
      .catch(() => setGroups([]))
    // The templates are compiled into the server, so one fetch per page load
    // is enough; a failure just leaves the custom prompt box.
    api.admin
      .promptTemplates()
      .then((result) => setTemplates(result.data ?? []))
      .catch(() => setTemplates([]))
  }, [])

  const groupOptions = useMemo(
    () => groups.map((group) => ({ value: group.name, label: `${group.name}（×${group.rate}）` })),
    [groups],
  )

  // overrides let the quick import seed the form in one write, instead of
  // opening the drawer and then racing a second setFieldsValue against it.
  const openDrawer = (channel?: Channel, overrides?: Record<string, unknown>) => {
    const requestID = ++credentialRequest.current
    const overrideKey = typeof overrides?.api_key === 'string' ? overrides.api_key : ''
    const shouldRevealCredential = Boolean(channel && !overrideKey)

    setEditing(channel ?? null)
    setConnOpen(Boolean(channel))
    setLoadingCredential(shouldRevealCredential)
    setCredentialFailed(false)
    // Clears stale validation errors from the previous visit along with values.
    form.resetFields()
    form.setFieldsValue({
      ...(channel
        ? {
            ...channel,
            api_key: '',
            models: channel.models,
            model_prefixes: (channel.model_prefixes ?? []).join('\n'),
            model_mapping: stringifyMapping(channel.model_mapping),
            headers: stringifyMapping(channel.headers),
          }
        : {
            name: '',
            base_url: '',
            auth_style: 'auto',
            api_key: '',
            status: STATUS.ENABLED,
            priority: 0,
            weight: 1,
            groups: ['default'],
            models: [],
            model_prefixes: '',
            model_mapping: '',
            headers: '',
            timeout_secs: 0,
            proxy_url: '',
            price_ratio: 1,
            rpm_limit: 0,
            test_model: '',
            supported_protocols: ['chat_completions', 'responses', 'messages'],
            note: '',
          }),
      ...overrides,
    })
    setDrawerOpen(true)

    if (channel && shouldRevealCredential) {
      void api.admin
        .channelCredential(channel.id)
        .then((credential) => {
          if (credentialRequest.current === requestID) {
            form.setFieldValue('api_key', credential.api_key)
          }
        })
        .catch((error) => {
          if (credentialRequest.current === requestID) {
            setCredentialFailed(true)
            message.error(error instanceof Error ? error.message : '读取上游密钥失败')
          }
        })
        .finally(() => {
          if (credentialRequest.current === requestID) {
            setLoadingCredential(false)
          }
        })
    }
  }

  const discardDrawer = () => {
    credentialRequest.current++
    setLoadingCredential(false)
    setDrawerOpen(false)
  }

  // Seventeen fields is too much typing to lose to a stray Esc or mask click.
  const closeDrawer = () => {
    if (form.isFieldsTouched()) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '关闭后已填写的内容不会保留。',
        okText: '放弃',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk: discardDrawer,
      })
      return
    }
    discardDrawer()
  }

  const submit = async () => {
    const values = await form.validateFields()
    const payload = {
      name: values.name,
      base_url: values.base_url ?? '',
      auth_style: values.auth_style ?? 'auto',
      api_key: values.api_key ?? '',
      status: values.status ?? STATUS.ENABLED,
      priority: Number(values.priority ?? 0),
      weight: Number(values.weight ?? 1),
      groups: values.groups ?? ['default'],
      models: values.models ?? [],
      model_prefixes: parseList(values.model_prefixes ?? ''),
      model_mapping: parseMapping(values.model_mapping ?? ''),
      headers: parseMapping(values.headers ?? ''),
      timeout_secs: Number(values.timeout_secs ?? 0),
      proxy_url: values.proxy_url ?? '',
      price_ratio: Number(values.price_ratio ?? 1),
      rpm_limit: Number(values.rpm_limit ?? 0),
      test_model: values.test_model ?? '',
      supported_protocols: values.supported_protocols ?? ['chat_completions', 'responses', 'messages'],
      note: values.note ?? '',
    }

    setSaving(true)
    try {
      if (editing) {
        await api.admin.updateChannel(editing.id, payload)
        message.success('已保存')
      } else {
        await api.admin.createChannel(payload)
        message.success('渠道已创建')
      }
      setDrawerOpen(false)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const fetchModels = async (channel: Channel) => {
    const hide = message.loading(`正在从「${channel.name}」拉取模型列表…`, 0)
    try {
      const result = await api.admin.fetchModels(channel.id, false)
      hide()
      if (!result.count) {
        message.warning('上游返回了空的模型列表')
        return
      }
      setPicker({ channel, models: result.models })
      setSelectedModels(channel.models.length ? channel.models : result.models)
      setPickerFilter('')
    } catch (error) {
      hide()
      message.error(error instanceof Error ? error.message : '拉取失败')
    }
  }

  // fetchModelsForForm probes whatever is currently typed in the drawer, so a
  // channel can be filled in before it exists and a corrected address can be
  // re-probed without saving first. An empty key field still means "keep the
  // stored one", which the server resolves from channel_id.
  const fetchModelsForForm = async () => {
    const values = form.getFieldsValue()
    const baseURL = (values.base_url ?? '').trim()
    if (!baseURL) {
      message.warning('请先填写接口地址')
      return
    }

    setFetchingModels(true)
    try {
      const result = await api.admin.importChannel({
        channel_id: editing?.id,
        base_url: baseURL,
        api_key: (values.api_key ?? '').trim() || undefined,
        auth_style: values.auth_style ?? 'auto',
      })
      if (result.model_error) {
        message.error(`拉取失败：${result.model_error}`)
        return
      }
      if (!result.models.length) {
        message.warning('上游返回了空的模型列表')
        return
      }

      const current: string[] = values.models ?? []
      setPicker({ models: result.models, toForm: true })
      setSelectedModels(current.length ? current : result.models)
      setPickerFilter('')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拉取失败')
    } finally {
      setFetchingModels(false)
    }
  }

  const applyModels = async () => {
    if (!picker) return
    // Coming from the drawer the selection is just another unsaved edit; it
    // lands in the form and is committed with everything else.
    if (picker.toForm) {
      form.setFieldValue('models', selectedModels)
      setPicker(null)
      message.success(`已填入 ${selectedModels.length} 个模型，保存后生效`)
      return
    }
    if (!picker.channel) return
    try {
      await api.admin.setChannelModels(picker.channel.id, selectedModels)
      message.success(`已为「${picker.channel.name}」配置 ${selectedModels.length} 个模型`)
      setPicker(null)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const closeTest = () => {
    setTester(null)
    // Reset the seed marker so the next opening draws a fresh prompt.
    setSeededTest(false)
  }

  // A channel answers for its own model list plus every model_mapping key: the
  // key is the name a caller requests, which the relay rewrites to the mapped
  // value before the request leaves. Offering only channel.models left the
  // rewritten names out of the picker, and those are the ones most worth
  // probing — the rewrite is the part that can be wrong.
  const testModelOptions = useMemo(() => {
    const channel = tester?.channel
    if (!channel) return []
    const mapping = channel.model_mapping ?? {}
    const names: string[] = []
    for (const name of [...(channel.models ?? []), ...Object.keys(mapping)]) {
      if (name && !names.includes(name)) names.push(name)
    }
    return names.map((name) => ({
      value: name,
      // Spell out what an alias resolves to: picking one should not hide which
      // upstream model the probe will actually ask for.
      label: mapping[name] ? `${name} → ${mapping[name]}` : name,
    }))
  }, [tester])

  const openTest = (channel: Channel) => {
    setTester({ channel })
    // A mapping-only channel has no channel.models to fall back on, and left
    // blank the probe would resolve nothing.
    setTestModel(
      channel.test_model ||
        channel.models[0] ||
        Object.keys(channel.model_mapping ?? {})[0] ||
        '',
    )
    setTestProtocol('responses')
    // Start from a random built-in prompt: it makes a meaningful probe one
    // click away, and varying the question stops a channel from looking
    // healthy just because it caches one familiar answer.
    const picked = templates.length
      ? templates[Math.floor(Math.random() * templates.length)]
      : undefined
    setTestTemplate(picked?.id ?? '')
    setTestPrompt(picked?.prompt ?? '')
    setSeededTest(Boolean(picked))
  }

  // The templates load with the page, so a click almost always finds them. This
  // covers the narrow case of opening the dialog before that request lands.
  // It seeds once per opening: clearing the box is how you ask for a
  // connectivity-only probe, and re-filling it would take that away.
  useEffect(() => {
    if (seededTest || !tester || !templates.length) return
    const picked = templates[Math.floor(Math.random() * templates.length)]
    setTestTemplate(picked.id)
    setTestPrompt(picked.prompt)
    setSeededTest(true)
  }, [seededTest, templates, tester])

  // selectTemplate writes the text into the box, so what gets sent is exactly
  // what is on screen and stays editable from there.
  const selectTemplate = (id?: string) => {
    setTestTemplate(id ?? '')
    setTestPrompt(templates.find((item) => item.id === id)?.prompt ?? '')
  }

  // Editing the text detaches it from the template it came from; leaving the
  // dropdown showing a name that no longer matches would misreport what is
  // about to be sent.
  const editPrompt = (next: string) => {
    setTestPrompt(next)
    setTestTemplate((current) => {
      const source = templates.find((item) => item.id === current)
      return source && source.prompt === next ? current : ''
    })
  }

  const runTest = async () => {
    if (!tester) return
    // Clear the previous verdict first: a lingering green "通过" over a new
    // in-flight probe reads as this run's result.
    setTester({ channel: tester.channel })
    setTesting(true)
    try {
      // The box now holds the resolved text, template or not, so send that:
      // the probe is exactly what the operator sees.
      const result = await api.admin.testChannel(tester.channel.id, {
        model: testModel || undefined,
        protocol: testProtocol,
        prompt: testPrompt.trim() || undefined,
      })
      setTester({ channel: tester.channel, result })
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '测试失败')
    } finally {
      setTesting(false)
    }
  }

  const setStatus = async (channel: Channel, status: number) => {
    setTogglingId(channel.id)
    try {
      await api.admin.setChannelStatus(channel.id, status)
      message.success(status === STATUS.ENABLED ? '渠道已启用' : '渠道已禁用')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingId(null)
    }
  }

  // saveRouting backs the two editable numbers in the table. It patches the one
  // row instead of reloading: the listing is ordered by priority, and a reload
  // would move the row out from under the cursor mid-edit, which turns tuning a
  // handful of channels into a hunt for where each one went.
  const saveRouting = async (channel: Channel, priority: number, weight: number) => {
    try {
      const updated = await api.admin.setChannelRouting(channel.id, priority, weight)
      setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
      message.success(`「${updated.name}」优先级 ${updated.priority}、权重 ${updated.weight}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const removeChannel = (channel: Channel) => {
    modal.confirm({
      title: `删除渠道「${channel.name}」？`,
      content: '删除后指向该渠道的路由会立即失效，历史日志保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        await api.admin.deleteChannel(channel.id)
        message.success('已删除')
        await load()
      },
    })
  }

  // ---------------------------------------------------------- quick import

  const openImport = () => {
    setImportText('')
    setImportBaseURL('')
    setImportKey('')
    setPreview(null)
    setImportOpen(true)
  }

  // Re-read the paste as it is typed, without touching the upstream: parsing is
  // a pure server-side string operation, so it is cheap enough to run on every
  // pause. Editing the text replaces whatever the previous parse produced,
  // which makes the paste the source of truth; a manual fix to either field
  // survives until the text itself changes again.
  useEffect(() => {
    if (!importOpen) return
    const text = importTextDebounced.trim()
    if (!text) return

    let cancelled = false
    void (async () => {
      try {
        const result = await api.admin.importChannel({ text, skip_models: true })
        if (cancelled) return
        setImportBaseURL(result.base_url)
        setImportKey(result.api_key)
        // Keep models already pulled for this very address: editing an unrelated
        // line of the paste should not throw away a successful probe.
        setPreview((previous) =>
          previous && previous.base_url === result.base_url
            ? { ...result, models: previous.models, model_error: previous.model_error }
            : result,
        )
      } catch {
        // Half-typed text has no address yet. That is the normal state while
        // someone is still pasting, not something worth interrupting them for.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [importOpen, importTextDebounced])

  // probeImport re-reads the paste and calls the upstream for its model list.
  // Manual corrections in the two fields win here: by the time someone presses
  // the button, those are the values they want probed.
  const probeImport = async () => {
    setImporting(true)
    try {
      const result = await api.admin.importChannel({
        text: importText,
        base_url: importBaseURL || undefined,
        api_key: importKey || undefined,
      })
      setPreview(result)
      setImportBaseURL(result.base_url)
      setImportKey(result.api_key)
      if (result.model_error) {
        message.warning(`已识别地址和密钥，但拉取模型失败：${result.model_error}`)
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '解析失败')
    } finally {
      setImporting(false)
    }
  }

  // applyImport hands the draft to the normal channel form. Nothing is written
  // until the operator saves it, so a bad guess costs one cancel.
  const applyImport = async () => {
    if (!preview) return
    const existing = preview.existing_channel

    const overrides = {
      base_url: preview.base_url,
      auth_style: preview.auth_style,
      api_key: preview.api_key,
      supported_protocols: preview.supported_protocols ?? [],
      ...(preview.models.length ? { models: preview.models } : {}),
    }

    if (existing) {
      // Load the row rather than reusing the list page: editing the full record
      // keeps everything the import cannot know — groups, priority, price ratio
      // — instead of silently resetting it to defaults.
      try {
        const current = await api.admin.getChannel(existing.id)
        setImportOpen(false)
        openDrawer(current, overrides)
        message.info(`将覆盖已有渠道「${existing.name}」，确认后保存`)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '读取同名渠道失败')
      }
      return
    }

    setImportOpen(false)
    // The import defaults apply here only. The branch above edits an existing
    // channel, where overwriting priority and weight would discard settings the
    // import knows nothing about.
    openDrawer(undefined, {
      ...overrides,
      name: preview.suggested_name,
      priority: settings.import_priority,
      weight: settings.import_weight,
    })
  }

  const cloneChannel = async (channel: Channel) => {
    try {
      const clone = await api.admin.cloneChannel(channel.id)
      // The copy points at the same upstream credential, so it is created
      // disabled: enabling it silently would double that upstream's share.
      message.success(`已复制为「${clone.name}」，确认配置后再启用`)
      await load()
      openDrawer(clone)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复制失败')
    }
  }

  // copyCredential puts the upstream connection on the clipboard, in the shape
  // the quick-import box on this same page already understands: address first,
  // key second. Fetched on demand — the listing only ever holds a masked key.
  const copyCredential = async (channel: Channel) => {
    try {
      const cred = await api.admin.channelCredential(channel.id)
      const text = `${cred.base_url}\n${cred.api_key}`
      try {
        await navigator.clipboard.writeText(text)
        message.success(`已复制「${channel.name}」的地址与密钥`)
      } catch {
        // The clipboard API needs a secure context, so it fails over plain
        // HTTP. Show the text rather than leaving the operator with nothing.
        setRevealed({ name: channel.name, text })
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取渠道信息失败')
    }
  }

  const showBalance = async (channel: Channel, kind: 'new-api' | 'sub2api') => {
    const label = kind === 'new-api' ? 'new-api' : 'sub2api'
    const hide = message.loading(`正在通过 ${label} 查询「${channel.name}」的余额…`, 0)
    try {
      const balance =
        kind === 'new-api'
          ? await api.admin.channelBalance(channel.id)
          : await api.admin.channelSub2APIBalance(channel.id)
      hide()
      if (!balance.ok) {
        message.warning(balance.message || '该上游未提供余额接口')
        return
      }
      const money = (value: number | null) =>
        value === null ? '未提供' : `${balance.currency} ${value.toFixed(2)}`
      modal.info({
        title: `「${channel.name}」余额`,
        content: (
          <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
            <Descriptions.Item label="接口类型">{balance.provider}</Descriptions.Item>
            <Descriptions.Item label="剩余">{money(balance.remaining_usd)}</Descriptions.Item>
            <Descriptions.Item label="已用">{money(balance.used_usd)}</Descriptions.Item>
            <Descriptions.Item label="总额度">{money(balance.total_usd)}</Descriptions.Item>
            {balance.plan_name && (
              <Descriptions.Item label="套餐">{balance.plan_name}</Descriptions.Item>
            )}
          </Descriptions>
        ),
      })
    } catch (error) {
      hide()
      message.error(error instanceof Error ? error.message : '查询失败')
    }
  }

  // ------------------------------------------------------------ bulk actions

  const runBulk = async (label: string, action: () => Promise<string>) => {
    setBusy(true)
    try {
      message.success(await action())
      setSelectedIds([])
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : `${label}失败`)
    } finally {
      setBusy(false)
    }
  }

  const bulkStatus = (status: number) =>
    void runBulk(status === STATUS.ENABLED ? '批量启用' : '批量禁用', async () => {
      const result = await api.admin.batchChannelStatus(selectedIds, status)
      return `${status === STATUS.ENABLED ? '已启用' : '已禁用'} ${result.updated} 个渠道`
    })

  const bulkDelete = () => {
    modal.confirm({
      title: `删除选中的 ${selectedIds.length} 个渠道？`,
      content: '删除后指向这些渠道的路由会立即失效，历史日志保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: () =>
        runBulk('批量删除', async () => {
          const result = await api.admin.batchDeleteChannels(selectedIds)
          return `已删除 ${result.deleted} 个渠道`
        }),
    })
  }

  // Not routed through runBulk: testing is read-only, and keeping the
  // selection lets "test, then disable the failures" happen in one pass.
  const bulkTest = async () => {
    setBusy(true)
    const hide = message.loading(`正在测试 ${selectedIds.length} 个渠道…`, 0)
    try {
      const result = await api.admin.batchTestChannels(selectedIds)
      hide()
      const failed = result.data.filter((item) => !item.ok)
      if (failed.length) {
        modal.warning({
          title: `${result.passed}/${result.total} 个渠道通过`,
          width: 640,
          content: (
            <pre className="code-block" style={{ maxHeight: 360 }}>
              {failed
                .map((item) => `${item.name || item.channel_id}: ${item.message || `HTTP ${item.status}`}`)
                .join('\n')}
            </pre>
          ),
        })
      }
      message.success(`${result.passed}/${result.total} 个渠道测试通过`)
      await load()
    } catch (error) {
      hide()
      message.error(error instanceof Error ? error.message : '批量测试失败')
    } finally {
      setBusy(false)
    }
  }

  const clearFilters = () => {
    setKeywordInput('')
    setStatusFilter(undefined)
    setGroupFilter(undefined)
    setModelFilterInput('')
  }

  const filtered = Boolean(keywordInput || statusFilter || groupFilter || modelFilterInput)

  const visiblePickerModels = (picker?.models ?? []).filter((item) =>
    item.toLowerCase().includes(pickerFilter.toLowerCase()),
  )

  return (
    <>
      <PageHeader
        title="渠道管理"
        description="优先级高的渠道先被选中，同优先级内按权重随机；失败会自动切换到下一个渠道。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Tooltip title="按当前渠道配置重建 (分组 × 模型) 路由表">
              <Button
                loading={rebuilding}
                onClick={async () => {
                  setRebuilding(true)
                  try {
                    await api.admin.rebuild()
                    message.success('路由表已重建')
                  } catch (error) {
                    message.error(error instanceof Error ? error.message : '重建失败')
                  } finally {
                    setRebuilding(false)
                  }
                }}
              >
                重建路由
              </Button>
            </Tooltip>
            <Button icon={<ImportOutlined />} onClick={openImport}>
              快速导入
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
              新建渠道
            </Button>
          </>
        }
      />

      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined className="text-muted" />}
          placeholder="搜索名称、地址、模型、映射、分组、备注"
          style={{ width: 300 }}
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: STATUS.ENABLED, label: '已启用' },
            { value: STATUS.DISABLED, label: '已禁用' },
          ]}
        />
        <Select
          allowClear
          showSearch
          placeholder="分组"
          style={{ width: 150 }}
          value={groupFilter}
          onChange={setGroupFilter}
          options={groupOptions}
        />
        <Input
          allowClear
          placeholder="按模型搜索，支持片段"
          style={{ width: 180 }}
          value={modelFilterInput}
          onChange={(event) => setModelFilterInput(event.target.value)}
        />
        {filtered && (
          <Button type="link" onClick={clearFilters}>
            重置
          </Button>
        )}
      </Space>

      {selectedIds.length > 0 && (
        <Space wrap size={8} style={{ marginBottom: 12 }}>
          {/* 翻页或改筛选会自动取消不可见行的选择，所以选择永远只覆盖当前页 */}
          <span className="text-muted">已选 {selectedIds.length} 个渠道（仅当前页）</span>
          <Button size="small" loading={busy} onClick={() => bulkStatus(STATUS.ENABLED)}>
            批量启用
          </Button>
          <Button size="small" loading={busy} onClick={() => bulkStatus(STATUS.DISABLED)}>
            批量禁用
          </Button>
          <Button
            size="small"
            loading={busy}
            icon={<ThunderboltOutlined />}
            onClick={() => void bulkTest()}
          >
            批量测试
          </Button>
          <Button size="small" danger loading={busy} onClick={bulkDelete}>
            批量删除
          </Button>
          <Button size="small" type="link" onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </Space>
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        tableLayout="fixed"
        // Sum of the column widths (plus selection/expand); without it a
        // mid-width window crushes every column instead of scrolling.
        scroll={{ x: 1290 }}
        rowClassName={(row) => (row.status !== STATUS.ENABLED ? 'row-disabled' : '')}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
        }}
        locale={{
          emptyText: (
            <EmptyState
              // Any active filter counts — a status/group filter with zero hits
              // must not claim there are no channels at all.
              title={filtered ? '没有匹配的渠道' : '还没有配置渠道'}
              description={
                filtered ? '换个筛选条件试试。' : '至少需要一个启用的渠道，请求才能被转发出去。'
              }
              action={
                filtered ? undefined : (
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
                    新建渠道
                  </Button>
                )
              }
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          // Only hide the bar when even the smallest page size would fit
          // everything: hiding it while the size changer is on would strand
          // anyone who picked a page size larger than the current result set.
          hideOnSinglePage: total <= 10,
          showTotal: (count) => `共 ${count} 个渠道`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage)
            setPageSize(nextSize)
          },
        }}
        columns={[
          {
            // The id is what the logs show, so it has to be findable here too.
            // No sorter: the list is server-paginated, and reordering one page
            // silently poses as a global ranking.
            title: 'ID',
            dataIndex: 'id',
            width: 72,
            render: (id: number) => <Tag className="mono" style={{ marginInlineEnd: 0 }}>#{id}</Tag>,
          },
          {
             // Keep this column compact instead of letting it absorb all remaining
             // table width. Long names and addresses still use ellipsis + Tooltip.
             title: '渠道',
             dataIndex: 'name',
             width: 300,

            render: (name: string, row) => (
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <Tooltip title={name}>
                    <strong
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {name}
                    </strong>
                  </Tooltip>
                </div>
                <div style={{ minWidth: 0 }}>
                  <Tooltip title={row.base_url}>
                    <span
                      className="mono text-muted"
                      style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.base_url}
                    </span>
                  </Tooltip>
                </div>
              </div>
            ),
          },
          {
            // Sits next to the channel it belongs to: what a channel serves is
            // read together with which channel it is, not with the counters.
            // Bounded so the leftover width goes to the channel name — this
            // column only ever shows a count plus two sample chips.
            title: '模型',
            dataIndex: 'models',
            width: 260,
            responsive: ['md'],
            render: (list: string[], row) => (
              <div className="tag-list">
                <Tag color="geekblue">{list.length} 个</Tag>
                {list.slice(0, 2).map((item) => (
                  <Tooltip key={item} title={item}>
                    <Tag
                      className="mono"
                      style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {item}
                    </Tag>
                  </Tooltip>
                ))}
                {list.length > 2 && (
                  <Tooltip
                    title={
                      // A hundred-model tooltip is an unreadable wall; the
                      // full list lives in the expanded row.
                      list.length > 20
                        ? `${list.slice(0, 20).join('、')} …等 ${list.length} 个，展开行查看全部`
                        : list.join('、')
                    }
                  >
                    <Tag>+{list.length - 2}</Tag>
                  </Tooltip>
                )}
                {Object.keys(row.model_mapping ?? {}).length > 0 && (
                  <Tooltip title={stringifyMapping(row.model_mapping)}>
                    <Tag color="purple">映射 {Object.keys(row.model_mapping).length}</Tag>
                  </Tooltip>
                )}
              </div>
            ),
          },
          {
            // Stacked rather than side by side: two labelled numbers read fine
            // one above the other, and it lets the column be sized for a
            // three-digit value instead of for a pair of tags on one line.
            //
            // The header is abbreviated because it was the only thing keeping
            // the column wide — "优先级" plus the sort arrow costs more than the
            // value it labels. What each line means is in the tag tooltips, and
            // the P/W prefixes carry it at a glance.
            title: (
              <span className="cell-stack">
                <span>优先</span>
                <span>权重</span>
              </span>
            ),
            dataIndex: 'priority',
            width: 80,
            responsive: ['md'],
            render: (priority: number, row) => (
              <div className="cell-stack">
                <InlineNumber
                  value={priority}
                  prefix="P"
                  label="优先级"
                  hint="优先级：数值越大越先被选中。点击可直接修改"
                  color="blue"
                  min={MIN_PRIORITY}
                  max={MAX_PRIORITY}
                  onCommit={(next) => saveRouting(row, next, row.weight)}
                />
                <InlineNumber
                  value={row.weight}
                  prefix="W"
                  label="权重"
                  hint="权重：同优先级内按权重随机分配。点击可直接修改"
                  min={MIN_WEIGHT}
                  max={MAX_WEIGHT}
                  onCommit={(next) => saveRouting(row, row.priority, next)}
                />
              </div>
            ),
          },
          {
            title: '分组',
            dataIndex: 'groups',
            width: 100,
            responsive: ['xl'],
            render: (list: string[]) => (
              <div className="tag-list">
                {list?.map((group) => (
                  <Tooltip key={group} title={group}>
                    <Tag
                      style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {group}
                    </Tag>
                  </Tooltip>
                ))}
              </div>
            ),
          },
          {
            // xl, not xxl: channel health is what this table is scanned for,
            // and a 1440px laptop should not have to hide it.
            title: '调用 / 失败',
            width: 120,
            align: 'right',
            responsive: ['xl'],
            render: (_, row) => {
              const rate = row.request_count ? row.error_count / row.request_count : 0
              return (
                <Tooltip
                  title={
                    row.last_error
                      ? `最近错误：${row.last_error}（${formatRelative(row.last_error_at)}）`
                      : '暂无错误记录'
                  }
                >
                  <Space size={4}>
                    {rate > 0.2 && row.request_count > 5 && (
                      <WarningOutlined
                        style={{ color: 'var(--app-danger)' }}
                        aria-label="高失败率"
                      />
                    )}
                    <span>{formatNumber(row.request_count)}</span>
                    <span className="text-muted">/</span>
                    <Typography.Text type={row.error_count ? 'danger' : 'secondary'}>
                      {formatNumber(row.error_count)}
                    </Typography.Text>
                  </Space>
                </Tooltip>
              )
            },
          },
          {
            title: '消费',
            dataIndex: 'used_quota',
            width: 90,
            align: 'right',
            responsive: ['lg'],
            render: (value: number) => formatMoney(value),
          },
          {
            // Sits next to the actions it belongs with, and unlike the other
            // secondary columns it has no breakpoint: this is a control, and
            // taking a bad channel out of rotation should not require widening
            // the window first.
            title: '状态',
            dataIndex: 'status',
            width: 82,
            render: (_: number, row) => (
              <Space size={4}>
                <Tooltip title={statusHint(row)}>
                  {/* A plain span keeps the tooltip anchored while the switch
                      is loading and stops accepting pointer events. */}
                  <span style={{ display: 'inline-flex' }}>
                    <Switch
                      size="small"
                      checked={row.status === STATUS.ENABLED}
                      loading={togglingId === row.id}
                      aria-label={`启用或禁用渠道 ${row.name}`}
                      onChange={(next) =>
                        void setStatus(row, next ? STATUS.ENABLED : STATUS.DISABLED)
                      }
                    />
                  </span>
                </Tooltip>
              </Space>
            ),
          },
          {
            title: '操作',
            width: 104,
            render: (_, row) => (
              <Space size={0}>
                {/* Editing is the high-frequency action; it earns a direct
                    click instead of two through the menu. */}
                <Button size="small" type="link" onClick={() => openDrawer(row)}>
                  编辑
                </Button>
                <Dropdown
                  menu={{
                    // Ordered by use: probes first, copies next, billing later,
                    // deletion isolated at the end.
                    items: [
                      { key: 'test', icon: <ThunderboltOutlined />, label: '模型测试' },
                      { key: 'models', icon: <CloudDownloadOutlined />, label: '拉取模型' },
                      { type: 'divider' as const },
                      { key: 'credential', icon: <CopyOutlined />, label: '复制地址与密钥' },
                      { key: 'clone', icon: <BlockOutlined />, label: '克隆渠道' },
                      { type: 'divider' as const },
                      { key: 'balance-new-api', icon: <WalletOutlined />, label: 'new-api 余额' },
                      { key: 'balance-sub2api', icon: <WalletOutlined />, label: 'sub2api 余额' },
                      { type: 'divider' as const },
                      { key: 'delete', icon: <DeleteOutlined />, label: '删除渠道', danger: true },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'test') openTest(row)
                      else if (key === 'models') void fetchModels(row)
                      else if (key === 'balance-new-api') void showBalance(row, 'new-api')
                      else if (key === 'balance-sub2api') void showBalance(row, 'sub2api')
                      else if (key === 'credential') void copyCredential(row)
                      else if (key === 'clone') void cloneChannel(row)
                      else if (key === 'delete') removeChannel(row)
                    },
                  }}
                  trigger={['click']}
                >
                  <Button
                    size="small"
                    type="text"
                    icon={<EllipsisOutlined />}
                    aria-label={`更多操作 ${row.name}`}
                  />
                </Dropdown>
              </Space>
            ),
          },
          Table.EXPAND_COLUMN,
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Row gutter={[12, 12]}>
              <Col xs={24} lg={6}>
                <Card size="small" title="连接">
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Text className="mono" copyable>
                      {row.base_url}
                    </Typography.Text>
                    <span className="mono text-muted">密钥 {row.api_key || '未设置'}</span>
                    {row.proxy_url && <span className="mono text-muted">代理 {row.proxy_url}</span>}
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      超时 {row.timeout_secs ? `${row.timeout_secs}s` : '全局默认'} · 计费倍率 ×
                      {row.price_ratio}
                    </span>
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      鉴权 {AUTH_STYLES.find((item) => item.value === row.auth_style)?.label ?? row.auth_style}
                    </span>
                    {row.supported_protocols && row.supported_protocols.length < 3 && (
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        协议 {row.supported_protocols
                          .map((p) => TEST_PROTOCOLS.find((t) => t.value === p)?.label ?? p)
                          .join(' / ')}
                      </span>
                    )}
                  </Space>
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card size="small" title={`模型（${row.models.length}）`}>
                  {/* The one place the full list is readable and copyable —
                      the column tooltip only carries a sample. */}
                  {row.models.length ? (
                    <Typography.Paragraph
                      copyable={{ text: row.models.join('\n'), tooltips: ['复制全部模型', '已复制'] }}
                      style={{ marginBottom: 0 }}
                    >
                      <span
                        className="mono"
                        style={{
                          display: 'block',
                          fontSize: 12,
                          lineHeight: 1.8,
                          maxHeight: 120,
                          overflow: 'auto',
                        }}
                      >
                        {row.models.join('\n')}
                      </span>
                    </Typography.Paragraph>
                  ) : (
                    <span className="text-muted">未配置，仅按前缀匹配</span>
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card size="small" title="模型映射">
                  <pre className="code-block" style={{ maxHeight: 120 }}>
                    {stringifyMapping(row.model_mapping) || '未配置'}
                  </pre>
                </Card>
              </Col>
              <Col xs={24} lg={6}>
                <Card size="small" title="运行状态">
                  <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                    <span>最近测试：{row.tested_at ? formatTime(row.tested_at) : '从未测试'}</span>
                    <span>
                      模型同步：{row.models_synced_at ? formatTime(row.models_synced_at) : '从未同步'}
                    </span>
                    <span style={{ color: row.last_error ? 'var(--app-danger)' : undefined }}>
                      {row.last_error || '无错误记录'}
                    </span>
                    {row.note && <span className="text-muted">备注：{row.note}</span>}
                  </Space>
                </Card>
              </Col>
            </Row>
          ),
        }}
      />

      <Drawer
        open={drawerOpen}
        width={narrow ? '100%' : 640}
        title={editing ? `编辑渠道：${editing.name}` : '新建渠道'}
        onClose={closeDrawer}
        // Sticky at the bottom: after a 17-field form, save is where the eye
        // already is, not back at the top.
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={closeDrawer}>取消</Button>
            <Button type="primary" loading={saving} disabled={loadingCredential} onClick={submit}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={() => void submit()}>
          <Divider orientation="left" orientationMargin={0} style={{ marginTop: 0 }}>
            基本信息
          </Divider>

          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="例如：主渠道" />
          </Form.Item>

          <Form.Item
            name="base_url"
            label="接口地址"
            tooltip="填到域名即可，例如 https://api.openai.com；末尾带 /v1 也能正确识别"
            rules={[{ required: true, whitespace: true, message: '请输入接口地址' }]}
          >
            <Input placeholder="https://api.openai.com" />
          </Form.Item>

          <Form.Item
            name="api_key"
            label="上游密钥"
            tooltip={editing ? '当前显示已存储的明文密钥，修改后会覆盖原密钥' : '会以 AES-256-GCM 加密后落库'}
            rules={editing ? [] : [{ required: true, message: '请输入上游密钥' }]}
          >
            {/* Masked by default: the stored plaintext should not sit on a
                shared screen. The eye toggle reveals it on purpose. */}
            <Input.Password
              className="mono"
              autoComplete="new-password"
              disabled={loadingCredential}
              placeholder={
                loadingCredential
                  ? '正在读取密钥…'
                  : credentialFailed
                    ? '读取失败；留空保存则保持原密钥'
                    : editing
                      ? '未设置'
                      : 'sk-...'
              }
            />
          </Form.Item>

          <Divider orientation="left" orientationMargin={0}>
            路由与计费
          </Divider>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="priority" label="优先级" tooltip="数值越大越优先">
                <InputNumber
                  min={MIN_PRIORITY}
                  max={MAX_PRIORITY}
                  precision={0}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="weight" label="权重" tooltip="同优先级内按权重随机分配">
                <InputNumber
                  min={MIN_WEIGHT}
                  max={MAX_WEIGHT}
                  precision={0}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="price_ratio"
                label="计费倍率"
                // 0 is refused here rather than accepted and quietly turned
                // into 1 by the server. Unlike a user group, a channel has no
                // "free" setting: the server clamps a non-positive ratio to 1
                // so that an API caller omitting the field cannot make a
                // channel free by accident.
                tooltip="该渠道的费用乘数，1 为原价。这里不支持 0（与分组倍率不同）；要让某个分组免费请到「用户分组」设置"
              >
                <InputNumber min={0.01} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="groups"
            label="可用分组"
            tooltip="只有列在这里的分组，其用户才能路由到该渠道"
          >
            <Select mode="tags" options={groupOptions} placeholder="default" />
          </Form.Item>

          <Form.Item
            name="models"
            label={
              <Space size={8}>
                <span>支持的模型</span>
                <Button
                  size="small"
                  type="link"
                  icon={<CloudDownloadOutlined />}
                  loading={fetchingModels}
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => void fetchModelsForForm()}
                >
                  从上游拉取
                </Button>
              </Space>
            }
            tooltip="每个模型是一个标签，点 × 可移除；粘贴用逗号、空格或换行分隔的列表会自动拆分"
          >
            <Select
              mode="tags"
              placeholder="输入模型名后回车，或从上游拉取"
              // Pasting a list is how these usually arrive, so the separators
              // matter as much as the chips do.
              tokenSeparators={[',', '\n', ' ', '\t']}
              // The dropdown is left working on purpose: in tags mode the
              // typed value is committed by selecting it there, so forcing it
              // shut would stop new names being added by hand. There is
              // nothing to suggest, so its empty state is suppressed instead.
              notFoundContent={null}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item
            name="model_prefixes"
            label="模型前缀"
            tooltip="每行一个前缀，例如 gpt-4 可覆盖 gpt-4o、gpt-4.1；只有当没有渠道精确匹配该模型时才生效"
          >
            <Input.TextArea rows={3} placeholder={'gpt-4\nclaude-'} />
          </Form.Item>

          <Form.Item
            name="model_mapping"
            label="模型映射"
            tooltip="每行 客户端模型=上游模型，转发时只改写 model 字段"
          >
            <Input.TextArea rows={3} placeholder={'gpt-4o=gpt-4o-2024-11-20'} />
          </Form.Item>

          <Collapse
            ghost
            className="drawer-collapse"
            activeKey={connOpen ? ['conn'] : []}
            onChange={(keys) => setConnOpen(keys.length > 0)}
            style={{ marginBottom: 8 }}
            items={[
              {
                key: 'conn',
                label: (
                  <Typography.Text strong>
                    连接选项
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>
                      超时 / 鉴权 / 协议 / 代理
                    </Typography.Text>
                  </Typography.Text>
                ),
                // forceRender is load-bearing: a never-opened panel would keep
                // its fields out of validateFields, and submit would silently
                // reset them to defaults on an existing channel.
                forceRender: true,
                children: (
                  <>
                    <Row gutter={16}>
                      <Col xs={24} md={8}>
                        <Form.Item name="timeout_secs" label="超时（秒）" tooltip="0 表示使用全局默认">
                          <InputNumber min={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="rpm_limit"
                          label="RPM 限制"
                          tooltip="每分钟最大请求数，0 表示不限制"
                        >
                          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item name="status" label="状态">
                          <Select
                            options={[
                              { value: STATUS.ENABLED, label: '启用' },
                              { value: STATUS.DISABLED, label: '禁用' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="auth_style"
                          label="鉴权方式"
                          tooltip="自动会根据客户端请求端点选择；仅在兼容网关要求特殊鉴权头时覆盖"
                        >
                          <Select options={AUTH_STYLES} />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Form.Item
                      name="test_model"
                      label="测试模型"
                      tooltip="执行「模型测试」时的默认模型；留空则取第一个支持的模型，只配了前缀的渠道必须填"
                    >
                      <Input placeholder="留空则取第一个支持的模型" />
                    </Form.Item>

                    <Form.Item
                      name="supported_protocols"
                      label="支持的协议"
                      tooltip="勾选上游实际支持的请求协议，路由时只会把对应协议的请求转发到此渠道"
                    >
                      <Checkbox.Group>
                        {TEST_PROTOCOLS.map((item) => (
                          <Checkbox key={item.value} value={item.value}>
                            {item.label}
                          </Checkbox>
                        ))}
                      </Checkbox.Group>
                    </Form.Item>

                    <Form.Item name="headers" label="附加请求头" tooltip="每行 Header-Name=value">
                      <Input.TextArea rows={2} placeholder={'X-Custom=value'} />
                    </Form.Item>

                    <Form.Item name="proxy_url" label="HTTP 代理" tooltip="例如 http://127.0.0.1:7890">
                      <Input placeholder="留空表示直连" />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />

          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="仅管理员可见" />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        open={Boolean(tester)}
        width={720}
        title={tester ? `模型测试：${tester.channel.name}` : '模型测试'}
        onCancel={closeTest}
        footer={[
          <Button key="close" onClick={closeTest}>
            关闭
          </Button>,
          <Button key="run" type="primary" loading={testing} onClick={() => void runTest()}>
            {testPrompt.trim() ? '发起对话测试' : '测试连通性'}
          </Button>,
        ]}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                模型
              </Typography.Text>
              {/* AutoComplete rather than Select: a prefix-only channel has no
                  model list to choose from, so a typed-in name must work too. */}
              <AutoComplete
                allowClear
                style={{ width: '100%' }}
                value={testModel}
                placeholder="留空则用渠道配置的测试模型"
                onChange={(value) => setTestModel(value ?? '')}
                filterOption={(input, option) =>
                  String(option?.value ?? '')
                    .toLowerCase()
                    .includes(input.toLowerCase())
                }
                options={testModelOptions}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                请求协议
              </Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={testProtocol}
                onChange={setTestProtocol}
                options={TEST_PROTOCOLS.map((item) => ({ ...item }))}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                提示词模板
              </Typography.Text>
              <Select
                allowClear
                style={{ width: '100%' }}
                value={testTemplate || undefined}
                placeholder="选择后填入下方"
                onChange={selectTemplate}
                options={templates.map((item) => ({ value: item.id, label: item.name }))}
              />
            </Col>
          </Row>

          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              提示词
            </Typography.Text>
            <Input.TextArea
              rows={5}
              value={testPrompt}
              placeholder="可直接编辑，或从上方选择模板；清空则只测连通性"
              onChange={(event) => editPrompt(event.target.value)}
            />
          </div>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            对话测试会真实消耗上游额度（上限 1024 tokens）；清空提示词则只发 1 个 token 测连通性。
          </Typography.Text>

          {tester?.result && (
            <>
              <Descriptions column={2} size="small" bordered>
                <Descriptions.Item label="结果">
                  {tester.result.ok ? (
                    <Tag color="green">通过</Tag>
                  ) : (
                    <Tag color="red">失败</Tag>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="状态码">{tester.result.status || '-'}</Descriptions.Item>
                <Descriptions.Item label="模型">
                  <span className="mono">{tester.result.model}</span>
                  {/* An alias and its target are different names for different
                      things; showing only the requested one hides where the
                      probe actually went. */}
                  {tester.result.upstream_model &&
                    tester.result.upstream_model !== tester.result.model && (
                      <span className="mono" style={{ opacity: 0.55 }}>
                        {' → '}
                        {tester.result.upstream_model}
                      </span>
                    )}
                </Descriptions.Item>
                <Descriptions.Item label="耗时">
                  {formatDuration(tester.result.latency_ms)}
                </Descriptions.Item>
                {tester.result.usage && (tester.result.usage.total_tokens > 0 ||
                  tester.result.usage.prompt_tokens > 0 || tester.result.usage.completion_tokens > 0) && (
                  <Descriptions.Item label="Token 用量" span={2}>
                    输入 {formatNumber(tester.result.usage.prompt_tokens)} · 输出{' '}
                    {formatNumber(tester.result.usage.completion_tokens)} · 合计{' '}
                    {formatNumber(tester.result.usage.total_tokens ||
                      tester.result.usage.prompt_tokens + tester.result.usage.completion_tokens)}
                  </Descriptions.Item>
                )}
              </Descriptions>

              {tester.result.reply && (
                <div>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    模型回复
                  </Typography.Text>
                  <pre className="code-block" style={{ maxHeight: 300 }}>
                    {tester.result.reply}
                  </pre>
                </div>
              )}

              {!tester.result.ok && (
                <Alert
                  type="error"
                  showIcon
                  message="测试失败"
                  description={
                    <pre className="code-block" style={{ maxHeight: 220, marginTop: 8 }}>
                      {tester.result.message || '上游未返回具体错误'}
                    </pre>
                  }
                />
              )}
            </>
          )}
        </Space>
      </Modal>

      <Modal
        open={importOpen}
        width={640}
        title="快速导入渠道"
        onCancel={() => setImportOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setImportOpen(false)}>
            取消
          </Button>,
          <Tooltip key="probe" title={!importBaseURL ? '先粘贴或填写接口地址' : undefined}>
            {/* span：disabled 按钮不冒泡鼠标事件，Tooltip 需要有人接住 hover */}
            <span style={{ display: 'inline-block', marginInlineStart: 8 }}>
              <Button loading={importing} disabled={!importBaseURL} onClick={() => void probeImport()}>
                拉取模型
              </Button>
            </span>
          </Tooltip>,
          <Button
            key="apply"
            type="primary"
            disabled={!preview}
            onClick={() => void applyImport()}
          >
            填入表单
          </Button>,
        ]}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            把服务商给的地址和密钥整段贴进来即可，也支持 curl 命令，停顿即自动识别；
            识别结果可以手动修正，修改上方文本会重新覆盖。
          </Typography.Text>
          <Input.TextArea
            rows={5}
            value={importText}
            placeholder={'接口地址：https://api.example.com/v1\nAPI Key: sk-...'}
            onChange={(event) => setImportText(event.target.value)}
          />

          <Row gutter={12}>
            <Col xs={24} md={14}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                接口地址
              </Typography.Text>
              <Input
                value={importBaseURL}
                placeholder="https://api.example.com/v1"
                aria-label="接口地址"
                onChange={(event) => setImportBaseURL(event.target.value)}
              />
            </Col>
            <Col xs={24} md={10}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                密钥
              </Typography.Text>
              <Input
                value={importKey}
                placeholder="sk-..."
                aria-label="上游密钥"
                onChange={(event) => setImportKey(event.target.value)}
              />
            </Col>
          </Row>

          {preview && (
            <>
              {preview.existing_channel && (
                <Alert
                  type="warning"
                  showIcon
                  message={`已存在同名渠道「${preview.existing_channel.name}」`}
                  description="填入表单后会以覆盖方式编辑该渠道，而不是新建。"
                />
              )}
              {preview.model_error && (
                <Alert
                  type="error"
                  showIcon
                  message="拉取模型失败"
                  description={preview.model_error}
                />
              )}
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="建议名称">
                  {preview.suggested_name || '未识别'}
                </Descriptions.Item>
                <Descriptions.Item label="模型">
                  {preview.models.length ? (
                    <Tooltip
                      title={
                        preview.models.length > 20
                          ? `${preview.models.slice(0, 20).join('、')} …等 ${preview.models.length} 个`
                          : preview.models.join('、')
                      }
                    >
                      <span>已拉取 {preview.models.length} 个</span>
                    </Tooltip>
                  ) : (
                    <span className="text-muted">未拉取</span>
                  )}
                </Descriptions.Item>
              </Descriptions>
            </>
          )}
        </Space>
      </Modal>

      <Modal
        open={Boolean(picker)}
        width={760}
        title={picker?.channel ? `「${picker.channel.name}」的上游模型` : '上游模型'}
        onCancel={() => setPicker(null)}
        onOk={applyModels}
        okText={
          picker?.toForm
            ? `填入 ${selectedModels.length} 个模型`
            : `保存 ${selectedModels.length} 个模型`
        }
        okButtonProps={{ disabled: selectedModels.length === 0 }}
      >
        <Space style={{ marginBottom: 12 }} wrap>
          <Input
            allowClear
            placeholder="过滤模型"
            style={{ width: 220 }}
            value={pickerFilter}
            onChange={(event) => setPickerFilter(event.target.value)}
          />
          <Button onClick={() => setSelectedModels(picker?.models ?? [])}>全选</Button>
          <Button
            onClick={() =>
              setSelectedModels((current) =>
                Array.from(new Set([...current, ...visiblePickerModels])),
              )
            }
          >
            添加当前筛选
          </Button>
          <Button onClick={() => setSelectedModels([])}>清空</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已选 {selectedModels.length} / 共 {picker?.models.length ?? 0}
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
          {visiblePickerModels.length ? (
            <Checkbox.Group
              value={selectedModels}
              onChange={(values) => setSelectedModels(values as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {visiblePickerModels.map((item) => (
                <Checkbox key={item} value={item} className="mono">
                  {item}
                </Checkbox>
              ))}
            </Checkbox.Group>
          ) : (
            <EmptyState title="没有匹配的模型" compact />
          )}
        </div>
      </Modal>

      {/* Shown only when the clipboard API is unavailable, which happens over
          plain HTTP; the operator can still select the text by hand. */}
      <Modal
        open={Boolean(revealed)}
        title={revealed ? `「${revealed.name}」的地址与密钥` : '渠道信息'}
        width={560}
        onCancel={() => setRevealed(null)}
        onOk={() => setRevealed(null)}
        okText="关闭"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Typography.Paragraph
          copyable={{ text: revealed?.text ?? '', tooltips: ['复制', '已复制'] }}
          className="mono"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginBottom: 0 }}
        >
          {revealed?.text}
        </Typography.Paragraph>
      </Modal>
    </>
  )
}
