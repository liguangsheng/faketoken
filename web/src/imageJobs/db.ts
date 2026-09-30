import type { StoredJob } from './types'

// Image jobs are kept in this browser's IndexedDB. An image runs to megabytes,
// far past what localStorage holds, and a Blob read back from here stays on
// disk until something actually displays it.

const DB_NAME = 'faketoken-image-jobs'
const STORE = 'jobs'

let opening: Promise<IDBDatabase> | null = null

// Opened once and reused. A browser that refuses (private mode, storage
// disabled) rejects every call below; callers carry on in memory.
const database = () =>
  (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))

/** One request in its own transaction, settled when the transaction commits. */
const inStore = <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = work(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )

export const loadJobs = () => inStore<StoredJob[]>('readonly', (store) => store.getAll())

export const saveJob = (job: StoredJob) => inStore('readwrite', (store) => store.put(job))

export const deleteJob = (id: string) => inStore('readwrite', (store) => store.delete(id))
