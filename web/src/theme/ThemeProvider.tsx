import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedMode = 'light' | 'dark'

const STORAGE_KEY = 'faketoken-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

interface ThemeValue {
  mode: ThemeMode
  resolved: ResolvedMode
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

const readStoredMode = (): ThemeMode => {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

const systemMode = (): ResolvedMode =>
  window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'

const FONT_FAMILY =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"

const FONT_FAMILY_CODE =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/**
 * The two palettes are intentionally written out in full rather than derived,
 * so that a tweak to one mode can never silently shift the other.
 */
function buildTheme(resolved: ResolvedMode): ThemeConfig {
  const dark = resolved === 'dark'

  const shared: ThemeConfig['token'] = {
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    fontFamily: FONT_FAMILY,
    fontFamilyCode: FONT_FAMILY_CODE,
    fontSize: 14,
    controlHeight: 34,
    wireframe: false,
    motionDurationMid: '0.15s',
  }

  const token: ThemeConfig['token'] = dark
    ? {
        ...shared,
        colorPrimary: '#8b87f5',
        colorInfo: '#8b87f5',
        colorSuccess: '#4ade80',
        colorWarning: '#fbbf24',
        colorError: '#f87171',
        colorBgLayout: '#0c0e13',
        colorBgContainer: '#14171f',
        colorBgElevated: '#1a1e28',
        colorBorder: '#333846',
        colorBorderSecondary: '#242833',
        colorText: '#e6e8ee',
        colorTextSecondary: '#b6bcc9',
        colorTextTertiary: '#98a0b0',
        colorTextQuaternary: '#6b7385',
      }
    : {
        ...shared,
        colorPrimary: '#4f46e5',
        colorInfo: '#4f46e5',
        colorSuccess: '#16a34a',
        colorWarning: '#d97706',
        colorError: '#dc2626',
        colorBgLayout: '#f5f6f8',
        colorBgContainer: '#ffffff',
        colorBgElevated: '#ffffff',
        colorBorder: '#d8dbe3',
        colorBorderSecondary: '#e8eaef',
        colorText: '#1a1d26',
        colorTextSecondary: '#4b5262',
        colorTextTertiary: '#6b7280',
        colorTextQuaternary: '#9ca3af',
      }

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token,
    components: {
      Layout: {
        headerHeight: 56,
        headerPadding: '0 16px',
        headerBg: dark ? 'rgba(20, 23, 31, 0.82)' : 'rgba(255, 255, 255, 0.82)',
        siderBg: dark ? '#101319' : '#ffffff',
        // The sider renders with theme="light", which reads its own tokens.
        lightSiderBg: dark ? '#101319' : '#ffffff',
        lightTriggerBg: dark ? '#1a1e28' : '#f2f3f6',
        lightTriggerColor: dark ? '#e6e8ee' : '#1a1d26',
        bodyBg: dark ? '#0c0e13' : '#f5f6f8',
        triggerBg: dark ? '#1a1e28' : '#f2f3f6',
        triggerColor: dark ? '#e6e8ee' : '#1a1d26',
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemBorderRadius: 8,
        itemHeight: 38,
        itemMarginInline: 10,
        itemMarginBlock: 2,
        iconMarginInlineEnd: 10,
        itemSelectedBg: dark ? 'rgba(139, 135, 245, 0.16)' : 'rgba(79, 70, 229, 0.09)',
        itemSelectedColor: dark ? '#a9a6f8' : '#4f46e5',
        itemHoverBg: dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.04)',
        activeBarWidth: 0,
        activeBarBorderWidth: 0,
      },
      Card: {
        headerFontSize: 15,
        headerHeight: 50,
        paddingLG: 20,
        boxShadowTertiary: dark
          ? '0 1px 2px rgba(0, 0, 0, 0.3)'
          : '0 1px 2px rgba(16, 24, 40, 0.04), 0 6px 16px -6px rgba(16, 24, 40, 0.06)',
      },
      Table: {
        headerBg: dark ? '#171b24' : '#fafbfc',
        headerColor: dark ? '#98a0b0' : '#6b7280',
        headerSplitColor: 'transparent',
        // Every table in the console renders at size="small", so the SM value
        // is the one that actually applies. The default-size padding stays as
        // a sane fallback, but a new table should be small like the rest.
        cellPaddingBlock: 11,
        cellPaddingBlockSM: 8,
        rowHoverBg: dark ? 'rgba(255, 255, 255, 0.03)' : '#f7f8fa',
        borderColor: dark ? '#242833' : '#eef0f4',
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        fontWeight: 500,
      },
      Tag: {
        borderRadiusSM: 6,
      },
      Segmented: {
        itemSelectedBg: dark ? '#262c39' : '#ffffff',
        trackBg: dark ? '#171b24' : '#f0f1f4',
      },
      Modal: {
        titleFontSize: 16,
      },
      Statistic: {
        contentFontSize: 26,
      },
      Tooltip: {
        colorBgSpotlight: dark ? '#262c39' : 'rgba(26, 29, 38, 0.94)',
      },
      Form: {
        labelColor: dark ? '#b6bcc9' : '#4b5262',
        itemMarginBottom: 18,
      },
      Descriptions: {
        labelBg: dark ? '#171b24' : '#fafbfc',
      },
    },
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode)
  const [system, setSystem] = useState<ResolvedMode>(systemMode)

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY)
    const listener = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light')
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  const resolved: ResolvedMode = mode === 'system' ? system : mode

  // The attribute drives every custom CSS variable in index.css; the meta tag
  // keeps browser UI (form controls, scrollbars) in sync.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      resolved,
      setMode: (next) => {
        localStorage.setItem(STORAGE_KEY, next)
        setModeState(next)
      },
    }),
    [mode, resolved],
  )

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={buildTheme(resolved)}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}

export function useThemeMode() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useThemeMode 必须在 ThemeProvider 内使用')
  return context
}
