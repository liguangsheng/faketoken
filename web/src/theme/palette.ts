/**
 * Every colour the console paints, in one place.
 *
 * Two consumers read this: `ThemeProvider` (antd component tokens) and, through
 * the vite plugin, the `--app-*` variables in the injected style block that
 * `index.css` refers to. Adding a colour here is the only way to use one.
 *
 * The two palettes are written out in full rather than derived, so that a tweak
 * to one mode can never silently shift the other.
 */
export interface Palette {
  brand: string
  brandSoft: string
  bg: string
  surface: string
  surfaceSunken: string
  elevated: string
  border: string
  borderStrong: string
  /** Hairline inside tables and cards, weaker than `border`. */
  borderFaint: string
  text: string
  textSecondary: string
  textMuted: string
  textFaint: string
  shadowSm: string
  shadow: string
  shadowLg: string
  cardShadow: string
  success: string
  warning: string
  danger: string
  successSoft: string
  warningSoft: string
  dangerSoft: string
  /** Secondary data colour (cost lines, rank bars); brand stays for primary. */
  accent: string
  /** Heatmap ramp, step 0 to 4. */
  heat: readonly [string, string, string, string, string]
  headerBg: string
  siderBg: string
  triggerBg: string
  triggerColor: string
  menuSelectedBg: string
  menuSelectedColor: string
  menuHoverBg: string
  rowHoverBg: string
  tooltipBg: string
  formLabel: string
  labelBg: string
}

export const light: Palette = {
  brand: '#4f46e5',
  brandSoft: 'rgba(79, 70, 229, 0.1)',
  bg: '#f5f6f8',
  surface: '#ffffff',
  surfaceSunken: '#fafbfc',
  elevated: '#ffffff',
  border: '#e8eaef',
  borderStrong: '#d8dbe3',
  borderFaint: '#eef0f4',
  text: '#1a1d26',
  textSecondary: '#4b5262',
  textMuted: '#6b7280',
  textFaint: '#9ca3af',
  shadowSm: '0 1px 2px rgba(16, 24, 40, 0.04)',
  shadow: '0 1px 2px rgba(16, 24, 40, 0.04), 0 6px 16px -6px rgba(16, 24, 40, 0.08)',
  shadowLg: '0 12px 32px -8px rgba(16, 24, 40, 0.16)',
  cardShadow: '0 1px 2px rgba(16, 24, 40, 0.04), 0 6px 16px -6px rgba(16, 24, 40, 0.06)',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  successSoft: 'rgba(22, 163, 74, 0.12)',
  warningSoft: 'rgba(217, 119, 6, 0.12)',
  dangerSoft: 'rgba(220, 38, 38, 0.12)',
  accent: '#0ea5e9',
  // Step 1 still clears 2:1 against the card surface, so the faintest day
  // reads as a mark.
  heat: ['#eef0f3', '#9ba6fb', '#6f73f0', '#4f46e5', '#332b9e'],
  headerBg: 'rgba(255, 255, 255, 0.82)',
  siderBg: '#ffffff',
  triggerBg: '#f2f3f6',
  triggerColor: '#1a1d26',
  menuSelectedBg: 'rgba(79, 70, 229, 0.09)',
  menuSelectedColor: '#4f46e5',
  menuHoverBg: 'rgba(15, 23, 42, 0.04)',
  rowHoverBg: '#f7f8fa',
  tooltipBg: 'rgba(26, 29, 38, 0.94)',
  formLabel: '#4b5262',
  labelBg: '#fafbfc',
}

export const dark: Palette = {
  brand: '#8b87f5',
  brandSoft: 'rgba(139, 135, 245, 0.16)',
  bg: '#0c0e13',
  surface: '#14171f',
  surfaceSunken: '#101319',
  elevated: '#1a1e28',
  border: '#242833',
  borderStrong: '#333846',
  borderFaint: '#242833',
  text: '#e6e8ee',
  textSecondary: '#b6bcc9',
  textMuted: '#98a0b0',
  textFaint: '#6b7385',
  shadowSm: '0 1px 2px rgba(0, 0, 0, 0.3)',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 16px -6px rgba(0, 0, 0, 0.5)',
  shadowLg: '0 12px 32px -8px rgba(0, 0, 0, 0.6)',
  cardShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#f87171',
  successSoft: 'rgba(74, 222, 128, 0.16)',
  warningSoft: 'rgba(251, 191, 36, 0.16)',
  dangerSoft: 'rgba(248, 113, 113, 0.16)',
  accent: '#38bdf8',
  // Reversed on dark: more usage is lighter, further from the surface.
  heat: ['#1d212b', '#4840c4', '#6763ea', '#8b87f5', '#bcbafb'],
  headerBg: 'rgba(20, 23, 31, 0.82)',
  siderBg: '#101319',
  triggerBg: '#1a1e28',
  triggerColor: '#e6e8ee',
  menuSelectedBg: 'rgba(139, 135, 245, 0.16)',
  menuSelectedColor: '#a9a6f8',
  menuHoverBg: 'rgba(255, 255, 255, 0.05)',
  rowHoverBg: 'rgba(255, 255, 255, 0.03)',
  tooltipBg: '#262c39',
  formLabel: '#b6bcc9',
  labelBg: '#171b24',
}

/** The names `index.css` refers to, mapped onto one palette. */
export function cssVars(palette: Palette): Record<string, string> {
  return {
    '--app-brand': palette.brand,
    '--app-brand-soft': palette.brandSoft,
    '--app-bg': palette.bg,
    '--app-surface': palette.surface,
    '--app-surface-sunken': palette.surfaceSunken,
    '--app-border': palette.border,
    '--app-border-strong': palette.borderStrong,
    '--app-text': palette.text,
    '--app-text-muted': palette.textMuted,
    '--app-text-faint': palette.textFaint,
    '--app-shadow-sm': palette.shadowSm,
    '--app-shadow': palette.shadow,
    '--app-shadow-lg': palette.shadowLg,
    '--app-success': palette.success,
    '--app-warning': palette.warning,
    '--app-danger': palette.danger,
    '--app-success-soft': palette.successSoft,
    '--app-warning-soft': palette.warningSoft,
    '--app-danger-soft': palette.dangerSoft,
    '--app-accent': palette.accent,
    '--app-heat-0': palette.heat[0],
    '--app-heat-1': palette.heat[1],
    '--app-heat-2': palette.heat[2],
    '--app-heat-3': palette.heat[3],
    '--app-heat-4': palette.heat[4],
  }
}
