import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { App, Button } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import type { GeneratedImage } from '../utils/images'
import { deleteJob, loadJobs, saveJob } from './db'
import { describeFailure, readImageResult } from './request'
import type { ImageJob, JobRequest, StoredImage, StoredJob } from './types'

/** Where the jobs are shown; one settling anywhere else raises a notification. */
export const IMAGE_PAGE = '/admin/playground/images'

// Finished jobs kept, oldest dropped first. Running ones never count.
const HISTORY_LIMIT = 50

export interface JobSpec {
  request: JobRequest
  /** Makes the call. It runs here, so it outlives the page that asked. */
  send: (signal: AbortSignal) => Promise<Response>
  /** Once the target has accepted the key: any 2xx. */
  onAccepted?: () => void
}

interface ImageJobsValue {
  /** Newest first. */
  jobs: ImageJob[]
  running: number
  submit: (spec: JobSpec) => void
  stop: (id: string) => void
  remove: (id: string) => void
  /** Drops every finished job; running ones carry on. */
  clearFinished: () => void
}

const ImageJobsContext = createContext<ImageJobsValue | null>(null)

// Not crypto.randomUUID: it only exists in a secure context, and the console
// is also reached over plain HTTP on a LAN address.
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) =>
  b.createdAt - a.createdAt

/** Moves an image out of the response into a form IndexedDB keeps well. */
const storeImage = async (image: GeneratedImage): Promise<StoredImage> => {
  if (!image.src.startsWith('data:')) return { url: image.src, revisedPrompt: image.revisedPrompt }
  // fetch decodes a data: URL natively, far faster than atob over megabytes.
  const blob = await (await fetch(image.src)).blob()
  // Measured once, here, so the history never decodes every image to label it.
  let width: number | undefined
  let height: number | undefined
  try {
    const bitmap = await createImageBitmap(blob)
    width = bitmap.width
    height = bitmap.height
    bitmap.close()
  } catch {
    // Not decodable here; shown without its dimensions.
  }
  return { blob, revisedPrompt: image.revisedPrompt, width, height }
}

/** A 2xx body turned into the job's outcome. */
const settle = async (job: StoredJob, text: string): Promise<StoredJob> => {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { ...job, status: 'failed', error: `响应不是 JSON：\n${text.slice(0, 4000)}` }
  }
  const result = readImageResult(payload)
  return {
    ...job,
    status: 'done',
    images: await Promise.all(result.images.map(storeImage)),
    usage: result.usage,
    raw: result.raw,
    ...(result.images.length
      ? {}
      : { error: '响应里没有可显示的图片：既没有 data[].b64_json，也没有 data[].url。' }),
  }
}

/**
 * Runs image jobs above the routes, so a render that takes a minute survives
 * the page that started it, and keeps their history in IndexedDB.
 *
 * A job is still a fetch in this tab: reloading or closing it cuts the job off,
 * and the next load marks it interrupted.
 */
export function ImageJobsProvider({ children }: { children: ReactNode }) {
  const { notification } = App.useApp()
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [jobs, setJobs] = useState<ImageJob[]>([])
  // The list as last committed. Completions arrive long after the render that
  // started them, so they read this rather than a stale snapshot.
  const jobsRef = useRef<ImageJob[]>([])
  const controllers = useRef(new Map<string, AbortController>())
  const objectURLs = useRef(new Map<string, string[]>())
  // Removed while running: its completion must not write it back.
  const dropped = useRef(new Set<string>())
  const pathname = useRef(location.pathname)
  pathname.current = location.pathname

  const commit = useCallback((update: (current: ImageJob[]) => ImageJob[]) => {
    jobsRef.current = update(jobsRef.current)
    setJobs(jobsRef.current)
  }, [])

  const release = useCallback((id: string) => {
    objectURLs.current.get(id)?.forEach((url) => URL.revokeObjectURL(url))
    objectURLs.current.delete(id)
  }, [])

  const toView = useCallback(
    (job: StoredJob): ImageJob => {
      release(job.id)
      const created: string[] = []
      const images = job.images.map((image) => {
        const shape = { revisedPrompt: image.revisedPrompt, width: image.width, height: image.height }
        if (!image.blob) return { ...shape, src: image.url ?? '' }
        const src = URL.createObjectURL(image.blob)
        created.push(src)
        return { ...shape, src, bytes: image.blob.size, type: image.blob.type }
      })
      objectURLs.current.set(job.id, created)
      return { ...job, images }
    },
    [release],
  )

  // History, once. A job still marked running was cut off by a reload or a
  // closed tab. The page is administrator-only: nobody else's browser gets
  // the database created.
  useEffect(() => {
    if (!isAdmin) return
    let live = true
    loadJobs()
      .then(async (stored) => {
        const settled = await Promise.all(
          stored.map(async (job) => {
            if (job.status !== 'running') return job
            const interrupted: StoredJob = { ...job, status: 'interrupted' }
            await saveJob(interrupted).catch(() => undefined)
            return interrupted
          }),
        )
        if (!live) return
        const known = new Set(jobsRef.current.map((job) => job.id))
        const restored = settled
          .filter((job) => !known.has(job.id))
          .sort(newestFirst)
          .slice(0, HISTORY_LIMIT)
          .map(toView)
        commit((current) => [...current, ...restored].sort(newestFirst))
      })
      // No IndexedDB here: the history lasts for this session only.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [isAdmin, commit, toView])

  // Signing out unmounts this: stop what is running and let the images go.
  useEffect(() => {
    const running = controllers.current
    const urls = objectURLs.current
    return () => {
      running.forEach((controller) => controller.abort())
      urls.forEach((list) => list.forEach((url) => URL.revokeObjectURL(url)))
    }
  }, [])

  const trim = useCallback(() => {
    const excess = jobsRef.current.filter((job) => job.status !== 'running').slice(HISTORY_LIMIT)
    if (!excess.length) return
    const drop = new Set(excess.map((job) => job.id))
    drop.forEach((id) => {
      release(id)
      void deleteJob(id).catch(() => undefined)
    })
    commit((current) => current.filter((job) => !drop.has(job.id)))
  }, [commit, release])

  const notify = useCallback(
    (job: StoredJob) => {
      // On the page the list already shows it, and a stop was asked for.
      if (pathname.current === IMAGE_PAGE || job.status === 'aborted') return
      const ok = job.status === 'done' && job.images.length > 0
      const prompt = job.request.prompt
      notification[ok ? 'success' : 'error']({
        key: job.id,
        message: ok ? `生图完成，共 ${job.images.length} 张` : '生图失败',
        description: prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt,
        actions: (
          <Button
            size="small"
            type="primary"
            onClick={() => {
              notification.destroy(job.id)
              navigate(IMAGE_PAGE)
            }}
          >
            查看
          </Button>
        ),
        // A failure waits to be read; a success can fade.
        duration: ok ? 8 : 0,
      })
    },
    [notification, navigate],
  )

  const run = useCallback(
    async (job: StoredJob, spec: JobSpec, controller: AbortController) => {
      let settled: StoredJob
      try {
        const response = await spec.send(controller.signal)
        const text = await response.text()
        if (response.ok) {
          spec.onAccepted?.()
          settled = await settle(job, text)
        } else {
          settled = { ...job, status: 'failed', error: describeFailure(response.status, text) }
        }
      } catch (error) {
        settled = controller.signal.aborted
          ? { ...job, status: 'aborted' }
          : {
              ...job,
              status: 'failed',
              error:
                error instanceof TypeError
                  ? `无法连接到服务，请检查网络或服务是否在运行。\n${String(error)}`
                  : String(error),
            }
      }
      settled = { ...settled, finishedAt: Date.now() }
      controllers.current.delete(job.id)

      // Checked again after the write: a removal can land while it is saving.
      const gone = () => dropped.current.has(job.id)
      if (!gone()) await saveJob(settled).catch(() => undefined)
      if (gone()) {
        dropped.current.delete(job.id)
        void deleteJob(job.id).catch(() => undefined)
        return
      }

      commit((current) => current.map((item) => (item.id === job.id ? toView(settled) : item)))
      trim()
      notify(settled)
    },
    [commit, toView, trim, notify],
  )

  const submit = useCallback(
    (spec: JobSpec) => {
      const job: StoredJob = {
        id: newId(),
        createdAt: Date.now(),
        status: 'running',
        request: spec.request,
        images: [],
        usage: null,
      }
      const controller = new AbortController()
      controllers.current.set(job.id, controller)
      commit((current) => [toView(job), ...current])
      // Saved while running, so a later load can tell it was cut off.
      void saveJob(job).catch(() => undefined)
      void run(job, spec, controller)
    },
    [commit, toView, run],
  )

  const stop = useCallback((id: string) => controllers.current.get(id)?.abort(), [])

  const remove = useCallback(
    (id: string) => {
      if (jobsRef.current.find((job) => job.id === id)?.status === 'running') {
        dropped.current.add(id)
        controllers.current.get(id)?.abort()
      }
      release(id)
      commit((current) => current.filter((job) => job.id !== id))
      void deleteJob(id).catch(() => undefined)
    },
    [commit, release],
  )

  const clearFinished = useCallback(() => {
    jobsRef.current
      .filter((job) => job.status !== 'running')
      .forEach((job) => {
        release(job.id)
        void deleteJob(job.id).catch(() => undefined)
      })
    commit((current) => current.filter((job) => job.status === 'running'))
  }, [commit, release])

  const value = useMemo<ImageJobsValue>(
    () => ({
      jobs,
      running: jobs.filter((job) => job.status === 'running').length,
      submit,
      stop,
      remove,
      clearFinished,
    }),
    [jobs, submit, stop, remove, clearFinished],
  )

  return <ImageJobsContext.Provider value={value}>{children}</ImageJobsContext.Provider>
}

export function useImageJobs() {
  const context = useContext(ImageJobsContext)
  if (!context) throw new Error('useImageJobs 必须在 ImageJobsProvider 内使用')
  return context
}
