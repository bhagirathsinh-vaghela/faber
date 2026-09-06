import { Log } from "@/util/log"

// Reference-counts the LIVE sessions per directory so an instance is disposed
// only when its directory has none. A session is a "user" of its directory's
// instance while it is busy (a turn is running) or ping-armed (its cache is
// being kept warm). Both axes are tracked here, keyed by directory; children
// share their parent's directory, so a busy subagent keeps the parent's
// instance alive through the same entry.
//
// This is the instance-lifetime source of truth, deliberately NOT derived from
// SessionRecent: that LRU is capped and root-only, so a busy child would read
// as zero users and its turn would be aborted on dispose.
export namespace Liveness {
  const log = Log.create({ service: "liveness" })

  // Grace window before disposing a directory that just went idle. Absorbs the
  // turn-end -> ping-arm and idle -> re-prompt gaps so a session that is briefly
  // between alive states doesn't lose its warm instance.
  const GRACE = 3 * 1000

  const busy = new Map<string, Set<string>>()
  const armed = new Map<string, Set<string>>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  export function alive(directory: string) {
    return (busy.get(directory)?.size ?? 0) > 0 || (armed.get(directory)?.size ?? 0) > 0
  }

  function edit(map: Map<string, Set<string>>, directory: string, sessionID: string, present: boolean) {
    const set = map.get(directory) ?? new Set<string>()
    if (present) set.add(sessionID)
    else set.delete(sessionID)
    if (set.size) map.set(directory, set)
    else map.delete(directory)
  }

  function reconcile(directory: string) {
    const existing = pending.get(directory)
    if (alive(directory)) {
      if (existing) {
        clearTimeout(existing)
        pending.delete(directory)
      }
      return
    }
    if (existing) return
    pending.set(
      directory,
      setTimeout(async () => {
        pending.delete(directory)
        if (alive(directory)) return
        log.info("no live sessions, disposing", { directory })
        const { Instance } = await import("./instance")
        await Instance.disposeDirectory(directory)
      }, GRACE),
    )
  }

  export function setBusy(directory: string, sessionID: string, value: boolean) {
    edit(busy, directory, sessionID, value)
    reconcile(directory)
  }

  export function setArmed(directory: string, sessionID: string, value: boolean) {
    edit(armed, directory, sessionID, value)
    reconcile(directory)
  }
}
