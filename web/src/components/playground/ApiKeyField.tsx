import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { App, Button, Dropdown, Input, Space, Switch, Tag, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { CloseOutlined, DownOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

import { api } from '../../api/client'
import type { Token } from '../../api/types'
import { STATUS } from '../../utils/format'

// Shared by both playground pages: a key pasted into one is offered by the other.
const KEYS_STORAGE = 'faketoken-playground-keys'
const REMEMBER_STORAGE = 'faketoken-playground-remember'
const MAX_REMEMBERED = 5

const readKeys = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_STORAGE) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const writeKeys = (keys: string[]) => {
  localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys))
  return keys
}

const maskKey = (key: string) =>
  key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key

/** The key being typed, plus the ones this browser remembers. */
export function useSavedKeys() {
  const { message, modal } = App.useApp()
  const [savedKeys, setSavedKeys] = useState<string[]>(readKeys)
  const [remember, setRemember] = useState(
    () => localStorage.getItem(REMEMBER_STORAGE) !== '0',
  )
  // Restored eagerly so the page is usable the moment it opens.
  const [apiKey, setApiKey] = useState(() => {
    const keys = readKeys()
    return localStorage.getItem(REMEMBER_STORAGE) !== '0' ? (keys[0] ?? '') : ''
  })
  // Keys read back from this site's own tokens. The server can hand them over
  // again at any time, so they are never copied into localStorage.
  const siteKeys = useRef(new Set<string>())

  const pickSiteKey = (key: string) => {
    siteKeys.current.add(key)
    setApiKey(key)
  }

  /** Moves a key that just worked to the front, when remembering is on. */
  const keep = useCallback(
    (key: string) => {
      if (!remember || siteKeys.current.has(key)) return
      // Read and written through storage, not state: an image job reports back
      // after its page may have unmounted, when a state update is dropped.
      setSavedKeys(
        writeKeys([key, ...readKeys().filter((item) => item !== key)].slice(0, MAX_REMEMBERED)),
      )
    },
    [remember],
  )

  const forgetAll = () => {
    localStorage.removeItem(KEYS_STORAGE)
    setSavedKeys([])
    message.success('已清除本机保存的密钥')
  }

  const forgetOne = (key: string) => {
    setSavedKeys((current) => writeKeys(current.filter((item) => item !== key)))
  }

  // Asked for explicitly: the saved keys cannot be recovered from here, and
  // the same confirmation guards the "remember" switch being turned off.
  const confirmForgetAll = (onConfirmed?: () => void) => {
    if (savedKeys.length === 0) {
      onConfirmed?.()
      return
    }
    modal.confirm({
      title: `清除本机保存的 ${savedKeys.length} 个密钥？`,
      content: '只影响这台浏览器上的记忆，密钥本身不会被删除，但需要重新粘贴才能继续调试。',
      okText: '清除',
      okButtonProps: { danger: true },
      onOk: () => {
        forgetAll()
        onConfirmed?.()
      },
    })
  }

  const toggleRemember = (checked: boolean) => {
    if (checked) {
      setRemember(true)
      localStorage.setItem(REMEMBER_STORAGE, '1')
      return
    }
    // Turning remembering off also wipes what was remembered; that is
    // destructive, so it gets the same confirmation as the explicit "clear"
    // entry.
    confirmForgetAll(() => {
      setRemember(false)
      localStorage.setItem(REMEMBER_STORAGE, '0')
    })
  }

  return {
    apiKey,
    setApiKey,
    pickSiteKey,
    keep,
    savedKeys,
    remember,
    forgetOne,
    confirmForgetAll,
    toggleRemember,
  }
}

export type SavedKeys = ReturnType<typeof useSavedKeys>

/** The signed-in account's own keys, for picking instead of pasting. */
const useSiteTokens = (enabled: boolean) => {
  const [tokens, setTokens] = useState<Token[]>([])
  // Only a finished request can say "this account has no keys": a failed one
  // says nothing about them.
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let live = true
    api
      .listTokens({ page_size: 200 })
      .then((page) => {
        if (!live) return
        setTokens(page.data ?? [])
        setLoaded(true)
      })
      // The menu just goes without them; pasting still works.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [enabled])
  return enabled ? { tokens, loaded } : { tokens: [] as Token[], loaded: false }
}

const TOKEN_PREFIX = 'token:'

/**
 * The key input and its menu: this site's own keys (when the target is this
 * site), the ones this browser remembers, and the remember switch.
 */
export default function ApiKeyField({
  keys,
  id,
  hint,
  emptyTokensHint,
  siteTokens = false,
}: {
  keys: SavedKeys
  id: string
  /** Where the key comes from, under the input. */
  hint: ReactNode
  /** Shown instead of the hint when the account has no keys at all. */
  emptyTokensHint?: ReactNode
  /** Offer the account's own keys; only meaningful when calling this site. */
  siteTokens?: boolean
}) {
  const { message } = App.useApp()
  const { tokens, loaded } = useSiteTokens(siteTokens)

  const tokenItems = tokens.map((token) => {
    const expired = token.expires_at !== null && dayjs(token.expires_at).isBefore(dayjs())
    const disabled = token.status !== STATUS.ENABLED
    return {
      key: `${TOKEN_PREFIX}${token.id}`,
      disabled: disabled || expired,
      label: (
        <Space size={8}>
          <span>{token.name}</span>
          <span className="mono text-muted">{token.key_prefix}</span>
          {(disabled || expired) && <Tag>{disabled ? '已停用' : '已过期'}</Tag>}
        </Space>
      ),
    }
  })

  const savedKeyItems = keys.savedKeys.map((key) => ({
    key,
    label: (
      <Space size={8}>
        <span className="mono">{maskKey(key)}</span>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined style={{ fontSize: 10 }} />}
          aria-label={`删除已保存的密钥 ${maskKey(key)}`}
          onClick={(event) => {
            event.stopPropagation()
            keys.forgetOne(key)
          }}
        />
      </Space>
    ),
  }))

  return (
    <div>
      <label className="field-label" htmlFor={id}>
        API 密钥
      </label>
      <Space.Compact style={{ marginTop: 6, width: '100%' }}>
        <Input.Password
          id={id}
          placeholder="sk-..."
          value={keys.apiKey}
          onChange={(event) => keys.setApiKey(event.target.value)}
        />
        {(tokenItems.length > 0 || savedKeyItems.length > 0) && (
          <Dropdown
            menu={{
              items: [
                ...(tokenItems.length
                  ? [{ type: 'group' as const, label: '我的密钥', children: tokenItems }]
                  : []),
                ...(savedKeyItems.length
                  ? [
                      { type: 'group' as const, label: '本机记住的', children: savedKeyItems },
                      { type: 'divider' as const },
                      { key: '__clear', label: '清除已保存的密钥', danger: true },
                    ]
                  : []),
              ] satisfies MenuProps['items'],
              onClick: ({ key }) => {
                if (key === '__clear') {
                  keys.confirmForgetAll()
                } else if (key.startsWith(TOKEN_PREFIX)) {
                  api
                    .revealToken(Number(key.slice(TOKEN_PREFIX.length)))
                    .then((revealed) => keys.pickSiteKey(revealed.key))
                    .catch(() => message.error('读取密钥失败'))
                } else {
                  keys.setApiKey(key)
                }
              },
            }}
          >
            <Button icon={<DownOutlined />} aria-label="选择密钥" />
          </Dropdown>
        )}
      </Space.Compact>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
        {siteTokens && loaded && tokens.length === 0 && emptyTokensHint ? emptyTokensHint : hint}
      </Typography.Text>
      <label
        style={{
          alignItems: 'center',
          cursor: 'pointer',
          display: 'flex',
          gap: 8,
          marginTop: 8,
        }}
      >
        <Switch
          size="small"
          checked={keys.remember}
          aria-label="在本浏览器记住密钥"
          onChange={keys.toggleRemember}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          在本浏览器记住密钥（明文存于 localStorage）
        </Typography.Text>
      </label>
    </div>
  )
}
