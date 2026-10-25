import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { TablePaginationConfig } from 'antd'

import { useSettings } from '../settings/SettingsContext'

interface Page<T> {
  data?: T[]
  total: number
}

interface Options<T> {
  /** Fetches one page. May close over current filter values. */
  fetcher: (params: { page: number; pageSize: number }) => Promise<Page<T>>
  /** Noun for the "共 N 个…" footer, e.g. `密钥`. */
  unit: string
  /** Filter values: any change sends the list back to page 1 and refetches. */
  deps?: unknown[]
  /** Hidden for lists that want the pager even on one page. */
  hideOnSinglePage?: boolean
  showSizeChanger?: boolean
  onError?: (text: string) => void
}

export interface PagedList<T> {
  rows: T[]
  setRows: Dispatch<SetStateAction<T[]>>
  total: number
  loading: boolean
  /** Non-null while the last attempt failed; draw it instead of "暂无数据". */
  error: string | null
  reload: () => Promise<void>
  /** Spread into `<Table pagination>`; the sizes and labels live here. */
  pagination: TablePaginationConfig
}

const firstPage = 1

/**
 * Page state, loading and stale-response protection for a paginated admin list.
 *
 * The fetcher is read from a ref, so pages pass an inline closure over their
 * filters without wrapping it in `useCallback` and without the callbacks
 * changing identity underneath effects.
 */
export default function usePagedList<T>({
  fetcher,
  unit,
  deps = [],
  showSizeChanger = true,
  hideOnSinglePage,
  onError,
}: Options<T>): PagedList<T> {
  const { defaultPageSize } = useSettings()
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(firstPage)
  const [pageSize, setPageSize] = useState(defaultPageSize)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Two overlapping requests can land out of order — typing in a search box
  // fires one per keystroke. Only the newest may write; the loser is dropped.
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const result = await fetcherRef.current({ page, pageSize })
      if (mine !== seq.current) return
      setRows(result.data ?? [])
      setTotal(result.total)
      setError(null)
    } catch (caught) {
      if (mine !== seq.current) return
      const text = caught instanceof Error ? caught.message : '加载失败'
      setError(text)
      onErrorRef.current?.(text)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [page, pageSize])

  // A single filter change is one reload, not two: the page reset below and the
  // refetch share one commit. Skipped on mount, which has nothing to reset.
  const mounted = useRef(false)
  const [filtersVersion, setFiltersVersion] = useState(0)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setPage(firstPage)
    setFiltersVersion((version) => version + 1)
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load()
  }, [load, filtersVersion])

  // The last row of a page can be deleted, leaving an empty page behind with no
  // control on screen to escape it.
  useEffect(() => {
    const pages = Math.max(firstPage, Math.ceil(total / pageSize))
    if (page > pages) setPage(pages)
  }, [page, pageSize, total])

  return {
    rows,
    setRows,
    total,
    loading,
    error,
    reload: load,
    pagination: {
      current: page,
      pageSize,
      total,
      showSizeChanger,
      // Only hide the bar when even the smallest page size would fit
      // everything: hiding it while the size changer is on would strand anyone
      // who picked a page size larger than the current result set.
      hideOnSinglePage: hideOnSinglePage ?? total <= 10,
      showTotal: (count) => `共 ${count} 个${unit}`,
      onChange: (nextPage, nextSize) => {
        setPage(nextPage)
        setPageSize(nextSize)
      },
    },
  }
}
