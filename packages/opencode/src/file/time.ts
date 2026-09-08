import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })

  // Hash a file's bytes so assert() can tell an mtime bump with identical
  // content (a formatter rewrite-in-place, our own post-write re-stamp, an
  // editor save, cloud sync, antivirus) from a real outside edit. Returns
  // undefined when the file can't be read, so the caller falls back to the
  // mtime-only check.
  export async function hash(file: string): Promise<string | undefined> {
    const bytes = await Bun.file(file)
      .arrayBuffer()
      .catch(() => undefined)
    if (!bytes) return undefined
    return Bun.hash(bytes).toString(16)
  }

  // Per-session read state plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: { mtime: number; hash?: string; offset?: number; limit?: number } | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  // offset/limit record which line range a Read tool call captured, so read-dedup
  // can distinguish "same range, re-read" (stub) from "different range" (real
  // read). Edit/Write leave them undefined: their entry is a write-guard stamp,
  // not a cached view, and deduping a later Read against it would point the model
  // at post-edit content it never read.
  export function read(
    sessionID: string,
    file: string,
    mtime?: number,
    hash?: string,
    offset?: number,
    limit?: number,
  ) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    read[sessionID][file] = { mtime: mtime ?? Date.now(), hash, offset, limit }
  }

  // Record a file's state after our own write: its true on-disk mtime (not the
  // wall clock, which lands before the write completes) plus a content hash. A
  // subsequent edit/write in the same session then sees a matching mtime (or a
  // matching hash if the mtime drifted) and does not force a spurious re-read.
  export async function restamp(sessionID: string, file: string) {
    const stats = await Bun.file(file)
      .stat()
      .catch(() => undefined)
    const mtime = stats?.mtime.getTime() ?? Date.now()
    const h = await hash(file)
    read(sessionID, file, mtime, h)
    // Return the stored state so edit/write can persist it on their tool part.
    // seed() rebuilds FileTime from durable parts at the top of every turn, so
    // without this the next turn restores the stale pre-edit read mtime and the
    // guard fires on the edited file. Persisting the post-write mtime+hash lets
    // seed() carry the edit forward across turns.
    return { mtime, hash: h }
  }

  // Rebuild a session's read map from durable records (mtime + content hash
  // persisted on Read tool parts). This replaces the in-memory map for the
  // session, so it reflects exactly the reads still present in history: after a
  // server restart the reads are restored, and after compaction the filtered-out
  // reads are dropped (forcing a real re-read instead of an unchanged stub). The
  // in-memory map is a cache of this durable truth, not the source of truth.
  export function seed(
    sessionID: string,
    entries: { file: string; mtime: number; hash?: string; offset?: number; limit?: number }[],
  ) {
    const { read } = state()
    const next: { [path: string]: { mtime: number; hash?: string; offset?: number; limit?: number } | undefined } = {}
    for (const entry of entries) {
      // Per file the greatest mtime wins, not the last entry in stream order.
      // Stream order is the order the model *called* the tools; concurrent calls
      // on one file complete out of that order, so the call that wrote last can
      // sort first and leave a pre-write stamp behind. mtime is the observed
      // filesystem timestamp, so the largest is the most recent observation.
      const seen = next[entry.file]
      if (seen && entry.mtime < seen.mtime) continue
      next[entry.file] = { mtime: entry.mtime, hash: entry.hash, offset: entry.offset, limit: entry.limit }
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
    // No read on record is the EXPECTED state after a compaction dropped the
    // earlier Read from context, or a restart the model does not know about. It
    // is not a mistake by the model, so the message is a plain precondition —
    // read the file, then retry — not an accusation. The model recovers by
    // reading; the wording is what stops that recovery reading as a failure.
    if (!entry)
      throw new Error(
        `Read ${filepath} before editing it. Its earlier contents are no longer in context (a summary or restart dropped them), so read it again first, then retry this edit.`,
      )
    const stats = await Bun.file(filepath).stat()
    // Compare against the file's mtime when it was read, not the wall-clock read
    // time. The read-mtime is durable (persisted on the Read tool part and
    // restored via seed()), so this stays correct across a server restart: an
    // outside edit during the gap bumps mtime past the stored value and forces a
    // re-read, while an untouched file still matches.
    if (stats.mtime.getTime() <= entry.mtime) return

    // mtime moved, but that alone does not mean the content changed. A formatter
    // rewrite-in-place, our own post-write re-stamp, an editor save, or cloud
    // sync all bump mtime without touching bytes. When we recorded a hash at read
    // time, compare the current bytes against it: an identical hash means the
    // read is still valid, so proceed instead of forcing a spurious re-read. Only
    // a genuine content change (or a missing hash, e.g. a partial/legacy read)
    // throws.
    if (entry.hash) {
      const current = await hash(filepath)
      if (current && current === entry.hash) return
    }

    throw new Error(
      `File ${filepath} has been modified since it was last read.\nLast modification: ${stats.mtime.toISOString()}\nLast read mtime: ${new Date(entry.mtime).toISOString()}\n\nPlease read the file again before modifying it.`,
    )
  }
}
