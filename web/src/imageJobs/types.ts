import type { ImageOptions } from './request'

/** What was asked, kept with the job so it can be read back or run again. */
export interface JobRequest {
  model: string
  prompt: string
  n: number
  options: ImageOptions
  extra: Record<string, unknown>
  /** 'auto', 'manual' or a channel id; see the route field. */
  route: string
  /** Names only: the files themselves are not kept. */
  referenceNames: string[]
  /** Where it went, as shown to the reader. */
  endpoint: string
  /** The pinned channel or the upstream, when the call did not go automatic. */
  target?: { label: string; value: string }
}

/** interrupted: still running when the tab was reloaded or closed. */
export type JobStatus = 'running' | 'done' | 'failed' | 'aborted' | 'interrupted'

export interface StoredImage {
  /** The bytes, for an image that came back inline. */
  blob?: Blob
  /** The link, for one that came back as a URL only. */
  url?: string
  revisedPrompt: string
  width?: number
  height?: number
}

export interface StoredJob {
  id: string
  createdAt: number
  finishedAt?: number
  status: JobStatus
  request: JobRequest
  images: StoredImage[]
  usage: { input?: number; output?: number } | null
  /** The response with its base64 folded away. */
  raw?: string
  error?: string
}

/** An image as the page shows it: a URL an <img> can point at. */
export interface JobImage {
  src: string
  revisedPrompt: string
  bytes?: number
  type?: string
  width?: number
  height?: number
}

export interface ImageJob extends Omit<StoredJob, 'images'> {
  images: JobImage[]
}
