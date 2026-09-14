import { Grid } from 'antd'
import type { Breakpoint } from 'antd'

/**
 * One column's contribution to a table's scroll width.
 *
 * `width` mirrors a column's declared width. `flexMin` is for the column that
 * declares none and absorbs whatever is left over — it still needs a floor, or
 * a narrow window leaves it nothing and the cell collapses to zero.
 */
export type ColumnWidth = ({ width: number } | { flexMin: number }) & {
  responsive?: Breakpoint[]
}

export type TableGeometry = Record<string, ColumnWidth>

/**
 * The width `scroll.x` has to carry at the window's current breakpoint.
 *
 * Two independent things decide how a scrolling antd table looks, and they
 * have to agree. rc-table hard-sets the table element to `width: <scroll.x>`
 * (Table.js → `scrollTableStyle`), so that number — not the columns — is what
 * the table is actually as wide as. antd separately drops every column whose
 * `responsive` breakpoints are all unmatched (InternalTable → `!responsive ||
 * responsive.some(...)`). Hide columns but leave `scroll.x` at the desktop
 * total and the survivors are stretched across a width reserved for columns
 * that are no longer rendered: the same scroll distance as before, showing
 * less. That is worse than the crush the breakpoints were added to fix.
 *
 * This reads the same `Grid.useBreakpoint` antd's own filter reads, so the two
 * cannot drift apart.
 *
 * Chrome antd renders but the caller never declares — the selection checkbox,
 * the expand caret — belongs in the geometry as well, or the sum comes up
 * short by exactly its width.
 */
export function useTableScrollX(geometry: TableGeometry): number {
  const screens = Grid.useBreakpoint()

  return Object.values(geometry).reduce((sum, column) => {
    if (column.responsive && !column.responsive.some((breakpoint) => screens[breakpoint])) {
      return sum
    }
    return sum + ('width' in column ? column.width : column.flexMin)
  }, 0)
}
