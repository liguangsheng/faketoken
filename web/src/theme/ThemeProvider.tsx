import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'

import { dark as darkPalette, light as lightPalette } from './palette'

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

/** antd's tokens, drawn from the palette so colours exist in one place. */
function buildTheme(resolved: ResolvedMode): ThemeConfig {
  const dark = resolved === 'dark'
  const palette = dark ? darkPalette : lightPalette

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

  const token: ThemeConfig['token'] = {
    ...shared,
    colorPrimary: palette.brand,
    colorInfo: palette.brand,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.danger,
    colorBgLayout: palette.bg,
    colorBgContainer: palette.surface,
    colorBgElevated: palette.elevated,
    colorBorder: palette.borderStrong,
    colorBorderSecondary: palette.border,
    colorText: palette.text,
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: palette.textMuted,
    colorTextQuaternary: palette.textFaint,
  }

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token,
    components: {
      Layout: {
        headerHeight: 56,
        headerPadding: '0 16px',
        headerBg: palette.headerBg,
        siderBg: palette.siderBg,
        // The sider renders with theme="light", which reads its own tokens.
        lightSiderBg: palette.siderBg,
        lightTriggerBg: palette.triggerBg,
        lightTriggerColor: palette.triggerColor,
        bodyBg: palette.bg,
        triggerBg: palette.triggerBg,
        triggerColor: palette.triggerColor,
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemBorderRadius: 8,
        itemHeight: 38,
        itemMarginInline: 10,
        itemMarginBlock: 2,
        iconMarginInlineEnd: 10,
        itemSelectedBg: palette.menuSelectedBg,
        itemSelectedColor: palette.menuSelectedColor,
        itemHoverBg: palette.menuHoverBg,
        activeBarWidth: 0,
        activeBarBorderWidth: 0,
      },
      Card: {
        headerFontSize: 15,
        headerHeight: 50,
        paddingLG: 20,
        boxShadowTertiary: palette.cardShadow,
      },
      Table: {
        headerBg: palette.labelBg,
        headerColor: palette.textMuted,
        headerSplitColor: 'transparent',
        // Every table in the console renders at size="small", so the SM value
        // is the one that actually applies. The default-size padding stays as
        // a sane fallback, but a new table should be small like the rest.
        cellPaddingBlock: 11,
        cellPaddingBlockSM: 8,
        rowHoverBg: palette.rowHoverBg,
        borderColor: palette.borderFaint,
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
        itemSelectedBg: palette.tooltipBg,
        trackBg: palette.labelBg,
      },
      Modal: {
        titleFontSize: 16,
      },
      Statistic: {
        contentFontSize: 26,
      },
      Tooltip: {
        colorBgSpotlight: palette.tooltipBg,
      },
      Form: {
        labelColor: palette.formLabel,
        itemMarginBottom: 18,
      },
      Descriptions: {
        labelBg: palette.labelBg,
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

  // The attribute drives every custom CSS variable, including the page's own
  // background, so nothing else has to be patched when the mode flips.
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
