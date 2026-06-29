import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: { mtime: number } | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  export function read(sessionID: string, file: string, mtime?: number) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    read[sessionID][file] = { mtime: mtime ?? Date.now() }
  }

  // Rebuild a session's read map from durable records (the mtimes persisted on
  // Read tool parts). This replaces the in-memory map for the session, so it
  // reflects exactly the reads still present in history: after a server restart
  // the reads are restored, and after compaction the filtered-out reads are
  // dropped (forcing a real re-read instead of an unchanged stub). The in-memory
  // map is a cache of this durable truth, not the source of truth.
  export function seed(sessionID: string, entries: { file: string; mtime: number }[]) {
    const { read } = state()
    const next: { [path: string]: { mtime: number } | undefined } = {}
    for (const entry of entries) {
      next[entry.file] = { mtime: entry.mtime }
    }
    read[sessionID] = next
  }

  export function get(sessionID: string, file: string) {
    return state().read[sessionID]?.[file]
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function assert(sessionID: string, filepath: string) {
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    const entry = get(sessionID, filepath)
    if (!entry) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)
    const stats = await Bun.file(filepath).stat()
    // Compare against the file's mtime when it was read, not the wall-clock read
    // time. The read-mtime is durable (persisted on the Read tool part and
    // restored via seed()), so this stays correct across a server restart: an
    // outside edit during the gap bumps mtime past the stored value and forces a
    // re-read, while an untouched file still matches.
    if (stats.mtime.getTime() > entry.mtime) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${stats.mtime.toISOString()}\nLast read mtime: ${new Date(entry.mtime).toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }
  }
}
