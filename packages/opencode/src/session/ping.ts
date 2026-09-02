import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { SystemPrompt } from "./system"
import { SessionPin } from "./pin"
import { ProviderTransform } from "@/provider/transform"
import { Plugin } from "@/plugin"
import { clone } from "remeda"
import { SessionPrompt } from "./prompt"
import { SessionPricing } from "./pricing"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Liveness } from "@/project/liveness"
import { SessionRecent } from "./recent"
import { sleep } from "@/util/abort"

export const CACHE_TTL = 5 * 60 * 1000
const DEFAULT_BEFORE_EXPIRY = 10
// How long the daemon sleeps between re-checks while it has nothing to ping
// (cache expired, no anchor yet, or session state transiently unreadable).
// Coarse on purpose: when a window IS live the loop sleeps the exact time to
// the ping instead, so this never affects ping timing.
const IDLE_TICK = 10 * 1000
// Floor under a due ping's sleep. A ping is worth firing slightly late; it is
// never worth a spin, and the daemon cannot tell "due now" from "dispatched
// nothing last pass" by the anchor alone.
const MIN_TICK = 1000
// Hard deadline for a single ping's stream. Healthy pings observed at 1.7-39s
// against a 5m TTL, so 60s bounds a stalled body without ever clipping a live
// one. Applies to the daemon's ping path ONLY — organic user turns are
// unbounded (the user owns that request). A stall past this is what stranded
// the daemon for 16m before this guard existed.
const PING_TIMEOUT = 60 * 1000
// Consecutive ping misses tolerated before the daemon stands down. A miss is a
// ping whose stream never emitted "start" (request never reached the server).
// Seeing "start" means the cache was read server-side, so the ping succeeded
// for warming purposes even if the body later errors or stalls. Any success
// resets this to 0; any organic turn re-arms from scratch.
const MAX_MISSES = 2

export async function beforeExpiry() {
  const cfg = await Config.get()
  const seconds = cfg.ping?.before_expiry ?? DEFAULT_BEFORE_EXPIRY
  return seconds * 1000
}

export namespace SessionPing {
  const log = Log.create({ service: "session.ping" })

  // Fired when a session's ping daemon arms or disarms on THIS server instance.
  // The hub keys "will-ping" off this live state, never off the persisted cache
  // anchor (which can outlive the daemon across a restart).
  export const Event = {
    Armed: BusEvent.define(
      "session.ping.armed",
      z.object({
        sessionID: z.string(),
        armed: z.boolean(),
      }),
    ),
  }

  const active = new Map<string, { abort: AbortController; id: number; directory: string }>()
  // Consecutive misses per session (in-memory: a process restart re-arms fresh,
  // which is itself a clean retry, consistent with "anything new resets").
  const misses = new Map<string, number>()
  let loopId = 0

  // Session IDs whose daemon is armed on this instance — the hub's truth source.
  export function list() {
    return [...active.keys()]
  }

  export const Armed = z.object({
    sessionID: z.string(),
    directory: z.string(),
    // Cache anchor (ms) the countdown ticks from; absent until the first request
    // dispatched this session. beforeExpiry (ms) is how early a ping fires.
    lastRequestAt: z.number().optional(),
    beforeExpiry: z.number(),
  })
  export type Armed = z.infer<typeof Armed>

  // Every armed session across every directory on this instance, enriched with
  // the countdown inputs (cache anchor + before-expiry). The home overview reads
  // this ONCE, globally, and scans its recent session IDs against it — no
  // per-directory bootstrap needed. Each session is read under its own directory
  // context (captured at arm time).
  export async function listArmed(): Promise<Armed[]> {
    const entries = [...active.entries()]
    return Promise.all(
      entries.map(([sessionID, entry]) =>
        Instance.provide({
          directory: entry.directory,
          fn: async () => {
            const session = await Session.get(sessionID).catch(() => undefined)
            return {
              sessionID,
              directory: entry.directory,
              lastRequestAt: session?.cache?.lastRequestAt,
              beforeExpiry: await beforeExpiry(),
            }
          },
        }),
      ),
    )
  }

  // Only IMPLICIT arms may consult this — attach and the boot restore, which act
  // on an intent recorded earlier rather than on something the user just did. An
  // explicit arm (a turn, the arm route) must NOT: it runs before its own
  // dispatch re-anchors the cache, so every session resumed after the TTL would
  // read as cold and never arm — and since arm() is the only writer of keepWarm,
  // the intent would never be recorded either.
  export function warm(session: Session.Info) {
    const base = session.cache?.lastRequestAt
    return !!base && base + CACHE_TTL > Date.now()
  }

  // Only the parent turn is resumed, and nothing it was waiting on comes back.
  // A subtask runs as its own session nothing relaunches; a pending question or
  // permission is a promise map that died with the process; a tool mid-execute is
  // left as an orphaned running part. All of it is the same fact from the model's
  // side (a call it made that can no longer return), so the prompt states it once
  // rather than enumerating causes. Without being told, the parent waits forever
  // on work that is already dead.
  export const CONTINUE_TEXT =
    "Pardon the interruption — the server needed a restart and your turn was cut off. Please continue what you were doing." +
    " Anything that was in flight is gone and will never return a result: a subtask you launched, a question or permission you were waiting on, a tool call part-way through." +
    " Redo whatever still matters."

  // A turn that never reached its own completion stamp. Every ordinary ending
  // writes one — a clean finish, an error, and a user Stop alike (the abort
  // unwinds through the same tail) — so its absence means the process died
  // holding the turn: a reboot, a crash, a kill. That makes this the discriminator
  // the supervisor cannot supply after a reboot, when the memory it snapshots
  // busy state from died with the machine.
  async function interrupted(sessionID: string) {
    for await (const msg of MessageV2.stream(sessionID)) {
      if (msg.info.role !== "assistant") continue
      return !msg.info.time.completed
    }
    return false
  }

  // Restore what a /restart restores, for the case it cannot cover: nothing
  // observed the previous server, so both tiers are rebuilt from disk instead of
  // from a snapshot taken before the kill.
  //
  // Cache liveness gates BOTH tiers, and does the work a boot-time comparison
  // would: the anchor cannot outlive the TTL, so a machine down longer than that
  // restores nothing — correctly, since neither a daemon nor a resumed turn has
  // a warm cache left to act on. It also keeps the blast radius honest, because
  // the persisted intent accumulates across every session ever left warm.
  export async function restore(resume: (session: Session.Info) => Promise<void>) {
    const entries = await SessionRecent.list()
    for (const entry of entries) {
      await Instance.provide({
        directory: entry.directory,
        fn: async () => {
          const session = await Session.get(entry.sessionID).catch(() => undefined)
          if (!session || session.parentID || !session.keepWarm || !warm(session)) return
          // A helper stopped by its own discharge stays stopped. Its stop lands
          // while its final message is still being written, so it reads as
          // interrupted here — and resuming it would restart the turn that just
          // ended and re-arm the daemon the discharge disarmed.
          if (session.spawn?.done) return
          if (await interrupted(session.id)) return resume(session)
          start(session.id)
        },
      }).catch((e) => log.error("restore failed", { sessionID: entry.sessionID, error: e }))
    }
  }

  // All three active mutations funnel through arm/disarm so the event fires
  // exactly when membership changes. The armed event MUST be stamped with the
  // session's own directory: the client routes it into a per-directory store
  // keyed by sessionID, and the ambient Instance.directory is unreliable here
  // (arm runs after an await, run's tail disarm runs fully detached, and a
  // route-driven stop only has the right context if the caller sent it). We
  // captured the directory at arm time, so re-provide it around the publish.
  function armed(sessionID: string, directory: string, value: boolean) {
    void Instance.provide({ directory, fn: () => Bus.publish(Event.Armed, { sessionID, armed: value }) })
  }

  async function arm(sessionID: string, entry: { abort: AbortController; id: number; directory: string }) {
    active.set(sessionID, entry)
    Liveness.setArmed(entry.directory, sessionID, true)
    // keepWarm is the persisted shadow of the daemon: it is written HERE and in
    // disarm, and NOWHERE else. Every intended arm (a prompt, an open, the
    // button) funnels through start()->arm; every disarm through stop()/tail->
    // disarm. session.get reconciles off this field but never writes it. One
    // writer per direction — no caller juggles the flag, no cross-caller races.
    await Session.update(sessionID, (draft) => {
      draft.keepWarm = true
    }).catch(() => {})
    armed(sessionID, entry.directory, true)
  }

  async function disarm(sessionID: string) {
    const entry = active.get(sessionID)
    if (!entry) return
    active.delete(sessionID)
    Liveness.setArmed(entry.directory, sessionID, false)
    void SessionRecent.setPing(sessionID, undefined)
    await Session.update(sessionID, (draft) => {
      draft.keepWarm = false
    }).catch(() => {})
    armed(sessionID, entry.directory, false)
  }

  export function start(sessionID: string) {
    // Re-arm: every call (including from an organic turn via prompt.ts) clears
    // the miss counter, even when a loop is already running. This is the "you
    // came back" reset, so it must run before the idempotency check below.
    misses.delete(sessionID)
    if (active.has(sessionID)) return
    // Capture the session's directory here, on the synchronous call path where
    // the instance context is still live (the route/prompt caller ran under it).
    // It is stored in the active entry so arm/disarm can stamp the armed event
    // with it later, when the ambient context is gone.
    const directory = Instance.directory
    // The daemon is opt-in. Read config off the synchronous call path so the two
    // sync callers (prompt.ts, session.ts) stay unchanged. When disabled, no loop
    // is armed: organic turns still re-anchor the cache TTL and the statusline
    // countdown still ticks (sliding to "--" on expiry), but no automatic ping
    // fires. probe() is unaffected — explicit cache-safe revert still pings.
    Config.get().then(async (cfg) => {
      if (!cfg.ping?.enabled) return
      // Re-check after the await: an organic turn may have armed a loop already.
      if (active.has(sessionID)) return
      const abort = new AbortController()
      const id = ++loopId
      await arm(sessionID, { abort, id, directory })
      run(sessionID, abort.signal, id)
    })
  }

  // Stopping is about the session's persisted INTENT, not about this process
  // holding a loop for it. `keepWarm` survives a restart while the daemon does
  // not, so returning early on a missing entry leaves a session flagged warm
  // with nothing running — and that flag is what the background reconciler
  // reads as "someone is still waiting on this", so it keeps jobs alive too.
  export async function stop(sessionID: string) {
    const entry = active.get(sessionID)
    if (entry) {
      entry.abort.abort()
      return disarm(sessionID)
    }
    await Session.update(sessionID, (draft) => {
      draft.keepWarm = false
    }).catch(() => {})
  }

  // Re-publish the ping deadline for an armed session after its cache re-anchors.
  // The daemon computes pingAt from lastRequestAt, then sleeps until it fires —
  // so a busy session that re-anchors mid-turn leaves the hub's pingAt pinned to
  // the OLD anchor until the loop wakes, and the overview countdown drifts from
  // the statusline (which reads the live anchor). Called at the re-anchor site,
  // this recomputes via evaluate() and emits the existing recent.updated event
  // so the overview snaps to the new deadline at once. No-op unless armed;
  // setPing itself no-ops when the value is unchanged.
  export async function refresh(sessionID: string) {
    if (!active.has(sessionID)) return
    const next = await evaluate(sessionID)
    if (next.type === "ping") void SessionRecent.setPing(sessionID, next.at)
  }

  // The daemon registry lives at module scope, outside any Instance context, so
  // Instance.dispose does not reach it. Disposing an instance without this would
  // leave its sessions' loops running, and each ping re-enters Instance.provide
  // for its captured directory — resurrecting the instance that was just torn
  // down. Called from Instance.dispose to stop every daemon for a directory.
  export function stopForDirectory(directory: string) {
    for (const [sessionID, entry] of active) if (entry.directory === directory) stop(sessionID)
  }

  export async function probe(sessionID: string, cacheProbeMessageID: string) {
    stop(sessionID)
    const abort = new AbortController()
    await ping(sessionID, abort.signal, { cacheProbeMessageID })
    start(sessionID)
  }

  // The daemon stays alive for the lifetime of the session/process. Whether it
  // pings is decided per-tick by evaluate(); "nothing to ping right now" never
  // ends the loop — it only schedules the next check. The loop exits only on
  // abort (a new prompt supersedes it, an explicit stop, or process death) or
  // when the session is not a parent (it should never have been started).
  async function run(sessionID: string, signal: AbortSignal, id: number) {
    // Only THIS loop, while it is still the armed one, may write the countdown.
    // evaluate()/sleep() are awaits, so an abort (stop, supersede) can land mid
    // await; stamping after that would strand a deadline past disarm's clear.
    // Gating every write on the live signal + loop id makes disarm the last word
    // regardless of async ordering — pingAt is a strict shadow of armed state.
    const stamp = (at: number | undefined) => {
      if (signal.aborted) return
      if (active.get(sessionID)?.id !== id) return
      void SessionRecent.setPing(sessionID, at)
    }
    while (!signal.aborted) {
      try {
        const next = await evaluate(sessionID)
        if (signal.aborted) break
        if (next.type === "stop") break
        stamp(next.type === "ping" ? next.at : undefined)
        await sleep(pause(next), signal)
        if (signal.aborted) break
        if (next.type === "ping" && (await ping(sessionID, signal)) === "skipped") {
          // A session with no message to send stays that way until a new turn,
          // which re-anchors and re-arms; sleeping the idle tick keeps the
          // daemon from rebuilding an unchanged history every pass.
          await sleep(IDLE_TICK, signal)
        }
      } catch (e: any) {
        if (e.name === "AbortError") break
        log.error("ping loop error", { sessionID, error: e })
        await sleep(IDLE_TICK, signal).catch(() => {})
      }
    }
    // Only disarm if we're still the active loop (not replaced by a newer one)
    const entry = active.get(sessionID)
    if (entry?.id === id) await disarm(sessionID)
  }

  type Next = { type: "ping"; delay: number; at: number } | { type: "idle" } | { type: "stop" }

  // How long the loop waits before acting on a decision. Only a DISPATCHED
  // request moves the cache anchor, so any pass that reaches evaluate() without
  // having dispatched gets the same already-due deadline back — a delay of 0.
  // Sleeping that verbatim rebuilds the whole session history back-to-back at
  // full CPU until the TTL lapses, with nothing reaching the log. The floor is
  // what bounds a due-but-undispatched ping to one pass per tick.
  export function pause(next: Next) {
    if (next.type !== "ping") return IDLE_TICK
    return Math.max(next.delay, MIN_TICK)
  }

  // Tri-state, never throws — read failures surface as "idle" so a transient
  // hiccup retries instead of killing the daemon.
  async function evaluate(sessionID: string): Promise<Next> {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session) return { type: "idle" }
    // Subtasks/child sessions never ping; if one somehow started, stop it.
    if (session.parentID) return { type: "stop" }
    // Stand down after too many consecutive misses (persistent network failure):
    // stay alive so an organic turn can re-arm via start(), but stop burning
    // cache-write cost on pings that keep failing. The user accepts a cold cache
    // on return in this case. start() clears misses, lifting the stand-down.
    if ((misses.get(sessionID) ?? 0) >= MAX_MISSES) return { type: "idle" }
    // The anchor decides, never whether a turn is in flight. A turn parked in a
    // long tool call dispatches nothing, so nothing moves the anchor, and that
    // is precisely when the window lapses and the ping is worth most. Standing
    // down for a busy session also cannot recover on its own: once the window
    // passes, the expiry branch below holds it idle until the turn dispatches
    // again. Overlapping a turn's own request costs a duplicate cache read and
    // nothing else, since a ping persists no message.
    const base = session.cache?.lastRequestAt
    if (!base) return { type: "idle" } // no request dispatched yet this session
    const now = Date.now()
    if (base + CACHE_TTL <= now) return { type: "idle" } // cache expired — wait for next turn
    const target = base + CACHE_TTL - (await beforeExpiry())
    return { type: "ping", delay: Math.max(0, target - now), at: target }
  }

  async function ping(sessionID: string, signal: AbortSignal, options?: { cacheProbeMessageID?: string }) {
    log.info("pinging", { sessionID, probe: options?.cacheProbeMessageID })

    const session = await Session.get(sessionID)
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    if (!msgs.length) return "skipped" as const

    let lastUser: MessageV2.User | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === "user") {
        lastUser = msgs[i].info as MessageV2.User
        break
      }
    }
    if (!lastUser) return "skipped" as const

    const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
    const snapshot = await SessionPin.get(sessionID)
    const agent = snapshot.agents[lastUser.agent] ?? (await Agent.get(lastUser.agent))
    const instructions = snapshot.instructions

    const sessionMessages = clone(msgs)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

    const variants = model.variants ?? ProviderTransform.variants(model)
    const variant = lastUser.variant ? variants[lastUser.variant] : undefined
    const stripReasoning =
      (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
      variant?.thinking?.type !== "enabled"

    const { messages: modelMessages, idToIndex } = MessageV2.toModelMessages(sessionMessages, model)
    const stripped = stripReasoning
      ? modelMessages.map((msg) => {
          if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
          return {
            ...msg,
            content: msg.content.filter((part) => part.type !== "reasoning"),
          }
        })
      : modelMessages

    // Append ephemeral "." user message
    const allMessages = [...stripped, { role: "user" as const, content: "." }]

    const tools = await SessionPrompt.resolveTools({
      agent,
      session,
      model,
      tools: lastUser.tools,
      processor: undefined as any,
      bypassAgentCheck: false,
      messages: msgs,
      snapshot,
    })

    // Anchor the cache TTL to dispatch time — a ping is a real request that
    // restarts the 5m window, and (unlike an organic turn) it is never
    // persisted as a message, so the session anchor is the only record of it.
    const dispatchedAt = Date.now()
    await Session.update(sessionID, (draft) => {
      draft.ping = {
        count: draft.ping?.count ?? 0,
        time: draft.ping?.time ?? 0,
        pending: true,
      }
      draft.cache = { lastRequestAt: dispatchedAt }
    })

    // Bound the ping with its own controller: abort on EITHER the daemon signal
    // (explicit stop / new prompt) OR a PING_TIMEOUT deadline. The deadline is
    // contained here so a stalled body aborts the ping WITHOUT killing the loop;
    // only a daemon-signal abort propagates out to break run().
    const pingAbort = new AbortController()
    const onParentAbort = () => pingAbort.abort()
    signal.addEventListener("abort", onParentAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      pingAbort.abort()
    }, PING_TIMEOUT)

    // "start" means the server accepted the request and began responding, i.e.
    // the cache prefix was read server-side. That alone makes the ping a success
    // for warming purposes — a later mid-stream error or a stalled body does not
    // un-warm the cache. So success is classified on `started`, independent of
    // whether we reach finish-step (usage metadata still requires finish-step,
    // so token/cost accounting stays gated on it).
    let started = false
    try {
      // LLM.stream itself can throw before returning (auth/provider/plugin
      // setup), so it lives inside the try — otherwise a setup failure would
      // skip cleanup and classification entirely.
      const { stream } = await LLM.stream({
        user: lastUser,
        agent,
        abort: pingAbort.signal,
        sessionID,
        system: {
          env: SystemPrompt.environment(),
          globalInstructions: instructions.global,
          projectInstructions: instructions.project,
          sessionContext: SystemPrompt.sessionContext({
            created: session.time.created,
            branch: session.branch,
          }),
        },
        // Warming a prefix the turn never reads is worse than not warming: the
        // ping must match the turn's question decision, not fall back to the default.
        canAsk: SessionPrompt.canAsk(session),
        messages: allMessages,
        sessionMessages,
        messageIdToIndex: idToIndex,
        tools,
        model,
        cacheProbeMessageID: options?.cacheProbeMessageID,
      })

      for await (const value of stream.fullStream) {
        if (pingAbort.signal.aborted) break
        if (value.type === "start") started = true
        if (value.type === "finish-step") {
          const usage = Session.getUsage({
            model,
            usage: value.usage,
            metadata: value.providerMetadata,
          })
          const weightedInput = SessionPricing.weightedInput(usage.tokens)
          const weightedOutput = usage.tokens.output + usage.tokens.reasoning
          // Keepalive pings are real API charges, so they count toward the same
          // session total as a normal turn, priced by the same function.
          const stepCost = await usage.cost
          await Session.update(sessionID, (draft) => {
            draft.tokens.input = usage.tokens.input
            draft.tokens.cacheRead = usage.tokens.cache.read
            draft.tokens.cacheWrite = usage.tokens.cache.write
            draft.tokens.output = usage.tokens.output
            draft.tokens.reasoning = usage.tokens.reasoning
            draft.tokens.cacheWrite5m = usage.tokens.cache.write5m ?? 0
            draft.tokens.cacheWrite1h = usage.tokens.cache.write1h ?? 0
            draft.total.input += weightedInput
            draft.total.output += weightedOutput
            draft.cost += stepCost
          })
          log.info("ping complete", {
            sessionID,
            cacheRead: usage.tokens.cache.read,
            cost: stepCost,
          })
          break
        }
      }
    } catch (e: any) {
      // A daemon-signal abort (superseding prompt / explicit stop) is not a ping
      // outcome — the prompt path owns the next state and is about to reset it,
      // so classify NOTHING and rethrow so run() breaks. Everything else (our
      // own PING_TIMEOUT, or a genuine stream/setup error) is a real ping
      // outcome: classify by `started`, then swallow a timeout (loop recovers)
      // or rethrow a genuine error (so probe() is not fooled into success).
      if (signal.aborted) throw e
      await classify(sessionID, started ? dispatchedAt : undefined)
      if (!timedOut) throw e
      return
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onParentAbort)
      await Session.update(sessionID, (draft) => {
        if (draft.ping?.pending) draft.ping = { ...draft.ping, pending: false }
      })
    }

    await classify(sessionID, started ? dispatchedAt : undefined)
  }

  // Seeing "start" => cache warmed => success: reset the miss counter and
  // advance telemetry count. Never seeing "start" => the request never reached
  // the server => miss: increment toward stand-down. The dispatch-time anchor is
  // kept in BOTH cases — the daemon stays armed so the next scheduled ping
  // rewarms; a single miss costs one rewrite, not a permanently cold cache.
  async function classify(sessionID: string, dispatchedAt?: number) {
    if (dispatchedAt !== undefined) {
      misses.delete(sessionID)
      // Classified success only: a miss never reached the server, so it is not
      // interaction and must not lift the session up the Recent ordering.
      void SessionRecent.setPinged(sessionID, dispatchedAt)
      await Session.update(sessionID, (draft) => {
        draft.ping = { count: (draft.ping?.count ?? 0) + 1, time: dispatchedAt }
      })
      return
    }
    misses.set(sessionID, (misses.get(sessionID) ?? 0) + 1)
    log.info("ping miss", { sessionID, consecutive: misses.get(sessionID) })
  }
}
