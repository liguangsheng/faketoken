import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { api, type ConsoleSettings } from '../api/client'

/**
 * What the console renders before the real settings arrive, and if they never
 * do. These are the server's boot defaults, which is emphatically not the same
 * as what an operator has stored — see `loaded` below.
 */
const FALLBACK: ConsoleSettings = {
  default_page_size: 20,
  init_quota_usd: 1,
  log_body_limit: 4 * 1024 * 1024,
  allow_register: false,
  import_priority: 999,
  import_weight: 100,
  log_detail_keep: 1000,
  blocked_keywords: '',
  require_invite_code: false,
  blocked_status: 200,
  blocked_reply: '',
  max_retries: 3,
  retry_backoff_ms: 200,
}

interface SettingsValue {
  settings: ConsoleSettings
  /** Convenience accessor: nearly every caller only wants this one. */
  defaultPageSize: number
  /** False until the first fetch settles, so tables can wait for the real value. */
  ready: boolean
  /**
   * True only once the stored settings have actually been read.
   *
   * The difference from `ready` matters: a failed fetch leaves the fallback in
   * place, and saving that back would overwrite every stored value with a
   * default. Anything that writes settings has to refuse while this is false.
   */
  loaded: boolean
  refresh: () => Promise<void>
  apply: (settings: ConsoleSettings) => void
}

const SettingsContext = createContext<SettingsValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ConsoleSettings>(FALLBACK)
  const [ready, setReady] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.settings())
      setLoaded(true)
    } catch {
      // The console still renders on the fallback, but it must not be mistaken
      // for the stored configuration; `loaded` stays false so the settings
      // form refuses to write it back.
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo<SettingsValue>(
    () => ({
      settings,
      defaultPageSize: settings.default_page_size || FALLBACK.default_page_size,
      ready,
      loaded,
      refresh,
      // Applied straight from the settings page so the change is visible
      // everywhere without a reload.
      apply: (next: ConsoleSettings) => {
        setSettings(next)
        setLoaded(true)
      },
    }),
    [settings, ready, loaded, refresh],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettings 必须在 SettingsProvider 内使用')
  return context
}
