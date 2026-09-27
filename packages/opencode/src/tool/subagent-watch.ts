import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { SessionBusy } from "../session/busy"
import { SessionPrompt } from "../session/prompt"
import { BackgroundJob } from "../background/job"
import { Log } from "../util/log"

// Watches a subagent's session for true quiescence and injects its result into
// the parent only once everything the subagent set in motion has stopped.
//
// A subagent finishes its model turn the moment it stops emitting tool calls,
// but a bash job it launched keeps running and re-wakes the child when it lands
// — so injecting at end-of-turn ships a result that omits work still in flight.
// The watcher tracks a SET of in-flight things (the turn itself, each running
// job, an external interruption) and injects only after the set has stayed
// empty for a debounce window, which lets a job-result turn re-open the set
// before the timer fires.
//
// It runs OUTSIDE any request (fed by bus events, a timer, a GlobalBus emit), so
// every instance-scoped call is wrapped in Instance.provide with the parent's
// directory — the child shares that directory, so both resolve there.
export namespace SubagentWatch {
  const log = Log.create({ service: "subagent-watch" })

  export const DEFAULT_DEBOUNCE_MS = 7000

  export interface StartInput {
    child: Session.Info
    // The session the result goes to, for the log line. Absent for a headless
    // run, whose result goes to an HTTP caller rather than a session.
    parentID?: string
    // The initial in-flight set, rebuilt from disk on a resume (running jobs +
    // an unfinished turn). A fresh launch seeds nothing and lets the events
    // populate it.
    seed?: Set<string>
    // Delivers the result the watcher assembled. Kept as a callback so the
    // single inject implementation stays in agent.ts and this module needs no
    // import back (which would close a cycle). Receives the child's last
    // assistant text at fire time.
    inject: (output: string) => Promise<void>
    // Overridable so tests can use a tiny window instead of the 3s default.
    debounceMs?: number
  }

  interface Watcher {
    inflight: Set<string>
    debounceMs: number
    timer?: ReturnType<typeof setTimeout>
    dispose: () => void
    fire: () => void
  }

  const watchers = new Map<string, Watcher>()

  export function start(input: StartInput) {
    // One watcher per child: a resume path and a launch path can both reach
    // here for the same session, and a second timer would inject twice.
    if (watchers.has(input.child.id)) return

    const childID = input.child.id
    const parentID = input.parentID
    const directory = input.child.directory
    const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS
    const inflight = new Set(input.seed ?? [])

    const arm = () => {
      const w = watchers.get(childID)
      if (!w) return
      if (w.timer) clearTimeout(w.timer)
      // Only an empty set arms the timer; any member keeps it disarmed.
      if (w.inflight.size > 0) return
      w.timer = setTimeout(w.fire, w.debounceMs)
    }

    const add = (key: string) => {
      const w = watchers.get(childID)
      if (!w) return
      // "interrupted" and the next turn are mutually exclusive: a fresh turn
      // clears the interruption it followed.
      if (key === "turn") w.inflight.delete("interrupted")
      w.inflight.add(key)
      if (w.timer) {
        clearTimeout(w.timer)
        w.timer = undefined
      }
    }

    const remove = (key: string) => {
      const w = watchers.get(childID)
      if (!w) return
      w.inflight.delete(key)
      arm()
    }

    // The child's own turn: SessionBusy publishes busySelf both ways on the
    // plain Bus, resolved from the publisher's instance context. The child
    // shares the parent's directory, so a subscription made under that directory
    // receives it.
    const unsubBusy = Bus.subscribe(SessionBusy.Event.Working, (evt) => {
      if (evt.properties.sessionID !== childID) return
      if (evt.properties.busySelf) add("turn")
      else remove("turn")
    })

    // An external stop (user Stop, Session.stop, restart) fires this; the loop's
    // own end-of-turn cancel does not. Holds the injection so a cut turn never
    // reports a partial result.
    const unsubInterrupted = Bus.subscribe(SessionPrompt.Event.Interrupted, (evt) => {
      if (evt.properties.sessionID !== childID) return
      add("interrupted")
    })

    // Jobs ride the GlobalBus (cross-instance), so subscribe there. Membership
    // keys on status ONLY: a job is in the set while running, out of it the
    // moment it leaves running, regardless of whether its result was delivered.
    const onGlobal = (event: { payload?: { type?: string; properties?: { job?: BackgroundJob.Info } } }) => {
      if (event.payload?.type !== BackgroundJob.Event.Updated.type) return
      const job = event.payload.properties?.job
      if (!job || job.sessionID !== childID) return
      if (job.status === "running") add(`job:${job.id}`)
      else remove(`job:${job.id}`)
    }
    GlobalBus.on("event", onGlobal)

    const dispose = () => {
      const w = watchers.get(childID)
      if (w?.timer) clearTimeout(w.timer)
      unsubBusy()
      unsubInterrupted()
      GlobalBus.off("event", onGlobal)
      watchers.delete(childID)
    }

    const fire = () => {
      const w = watchers.get(childID)
      // A member snuck in between the timer being set and it firing — re-arm.
      if (!w || w.inflight.size > 0) return
      dispose()
      void Instance.provide({
        directory,
        fn: async () => {
          const output = await lastText(childID)
          await input.inject(output)
          await Session.update(childID, (draft) => {
            draft.time.injected = Date.now()
          }).catch(() => {})
          log.info("injected subagent result", { child: childID, parent: parentID })
        },
      }).catch((error) => log.error("subagent watch inject failed", { child: childID, error }))
    }

    const watcher: Watcher = { inflight, debounceMs, dispose, fire }
    watchers.set(childID, watcher)
    // Seeded members keep the timer disarmed; an empty seed arms it now.
    arm()
  }

  export function stop(childID: string) {
    watchers.get(childID)?.dispose()
  }

  // A subagent's result is the last text part of its last assistant message.
  // The one reader, shared by the watcher's fire and the completed-record write
  // in agent.ts, so the payload injected and the payload recorded cannot drift.
  export async function lastText(sessionID: string) {
    const messages = await Session.messages({ sessionID })
    const last = messages.filter((m) => m.info.role === "assistant").at(-1)
    return last?.parts.findLast((p) => p.type === "text")?.text ?? ""
  }

  // Test-only: how many watchers are live.
  export function count() {
    return watchers.size
  }
}
