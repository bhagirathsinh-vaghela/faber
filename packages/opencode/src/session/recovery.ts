import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Db } from "@/storage/db"
import { Meta } from "@/storage/meta"
import { Owed } from "@/storage/owed"
import { Messages } from "@/storage/messages"
import { Parts } from "@/storage/parts"
import { Sessions } from "@/storage/sessions"
import { Scheduler } from "@/scheduler"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionBusy } from "./busy"
import { SessionPrompt } from "./prompt"
import { SessionRevert } from "./revert"
import { CACHE_TTL, SessionPing } from "./ping"
import { BackgroundJob } from "@/background/job"
import { BackgroundNotify } from "@/background/notify"
import { BackgroundProcess } from "@/background/process"

// The one place that decides what a restart, a finished subagent, or a finished
// job owes, and pays it. Everything else only writes facts (a prompt, a step
// finishing, a stop, a job settling); this reads them from the database and
// acts. Level-triggered: every pass re-derives the whole picture, so a missed
// event costs latency, never a lost result.
//
// Owed, in one line each:
//   subagent — has a parent, reports (`time.injected` defined), and a prompt
//              into it is newer than both its last delivery and its last stop.
//   job      — a `job_owed` row exists.
// Delivery writes the result message and removes the debt in ONE transaction.
export namespace Recovery {
  const log = Log.create({ service: "recovery" })

  // Failed resumes in a row before a cut turn is left alone.
  export const CAP = 3
  export const SWEEP_MS = 60 * 1000
  // A process only competes for the lease once it has been up this long. A
  // supervisor's staging build lives for its health check and is killed well
  // before this, so it never runs recovery against the live server's sessions,
  // even when the live server is an older build that holds no lease at all.
  export const GRACE_MS = 60 * 1000
  const LEASE_TTL = 3 * SWEEP_MS
  const LEASE = "recovery.lease"
  const BASELINE = "recovery.baseline"
  // A delivered message younger than this is still its own wake's to answer.
  const SETTLE_MS = 10 * 1000
  // Failed attempts in a row before a job's result is recorded as lost, or a
  // waiting message is left for a person to answer.
  const STRIKES = 3

  export const SUBAGENT_RESUME_TEXT =
    "Pardon the interruption — your turn was cut off before it finished. Continue what you were doing and finish the task you were given; your result is still awaited by the session that launched you."

  export function parentResumeText(running: number) {
    const head =
      "Pardon the interruption — your turn was cut off before it finished. Please continue what you were doing."
    const dead =
      " A question or permission you were waiting on, or a tool call part-way through, is gone and will never return — redo whatever still matters."
    const alive =
      running === 1
        ? " The subagent you launched is still running and will report its result back as before, so do NOT re-launch it; wait for it."
        : ` The ${running} subagents you launched are still running and will report their results back as before, so do NOT re-launch them; wait for them.`
    return head + dead + (running > 0 ? alive : "")
  }

  // ---- decisions ---------------------------------------------------------

  export function owed(session: Session.Info, prompted: number) {
    if (!session.parentID || session.time.injected === undefined) return false
    return prompted > Math.max(session.time.injected, session.time.stopped ?? 0)
  }

  export const boot = BackgroundProcess.boot
  const alive = BackgroundProcess.alive

  // A turn marker whose process is gone: the turn was cut by a crash or restart.
  // This process's own markers are never cut: its turns clear them as they
  // unwind, and one read mid-unwind would resume a turn that is still ending.
  // A headless run's session is never resumed: the request waiting on it died
  // with its server, and the boot sweep removes the session.
  export async function cut(session: Session.Info) {
    if (!session.turn || session.ephemeral) return false
    return (await alive(session.turn)) === false
  }

  // Done means nothing more will come of the work the session was given: no
  // turn in flight here, no turn marker, no job it still waits on, and no
  // message waiting for a turn (a result delivered a moment ago that the loop
  // it woke has not picked up yet). Subagents cannot nest, so a child has no
  // owed descendants to wait on.
  export async function done(session: Session.Info) {
    if (SessionBusy.busy(session.id) || session.turn) return false
    if (await BackgroundJob.running(session.id)) return false
    if (await Owed.pending(session.id)) return false
    return (await Messages.reader()).newest(session.id)?.role !== "user"
  }

  // Whether a turn should be started for a message waiting in `session`. A
  // subagent that no longer reports (stopped, interrupted, or already
  // delivered) has nobody to collect what a new turn would produce, so a late
  // job result into it lands in its transcript without waking it.
  function wanted(session: Session.Info, prompted: number) {
    if (!session.parentID || session.time.injected === undefined) return true
    return owed(session, prompted)
  }

  // ---- lease -------------------------------------------------------------

  // False until the boot grace has passed (`init`) or a test opens the gate
  // (`start`). A process that never calls either never acts, so a staging
  // build or `opencode run` stays inert.
  let ready = false
  let booted = false
  // Whether this process runs recovery at all. A turn run by one that does not
  // (`opencode run`) is marked transient: if its process goes away, the person
  // who ran it went with it, and its turn is not resumed.
  export let active = false

  export function start() {
    ready = true
    active = true
  }

  // Close the gate `start` opened, for a test that must leave the process as
  // it found it.
  export function stop() {
    ready = false
    active = false
  }

  // A process on its way out (`acp` when its client leaves): it pays and wakes
  // nothing more, and turns it had running are the next server's to resume.
  let closed = false
  export function close() {
    closed = true
    ready = false
  }

  // Whether this process is the one people drive (`serve`, which a supervisor
  // runs), as opposed to one an editor or a person starts beside it (`web`,
  // `acp`). The lease is held by the first; the others take it only while no
  // `serve` holds it, and hand it back the moment one does.
  let primary = false

  export async function lease(now = Date.now()) {
    if (!ready) return false
    const raw = await Meta.get(LEASE)
    const held = raw ? (JSON.parse(raw) as { pid: number; boot?: number; at: number; primary?: boolean }) : undefined
    const mine = held?.pid === process.pid && held.boot === boot
    // A holder the process table could not answer for is kept as live.
    const live = !!held && !mine && now - held.at <= LEASE_TTL && (await alive(held)) !== false
    // A `serve` takes the lease from a live secondary holder; a secondary
    // never takes it from a live holder of either kind. A holder recorded
    // before the field existed was a `serve`.
    const free = !live || (primary && held?.primary === false)
    if (!free) return false
    return Meta.update(LEASE, (value) =>
      value === raw ? JSON.stringify({ pid: process.pid, boot, at: now, primary }) : undefined,
    )
  }

  // ---- baseline ----------------------------------------------------------

  // The first time a database meets this code, every turn marker, owed result,
  // and unanswered delivery already on it predates the rules and is stopped
  // instead of acted on: the database's history is not replayed into its
  // sessions. Jobs still running are made owed so their results still arrive.
  //
  // Only state from before the first attempt's process is touched, so work
  // started since is left alone. That instant is recorded before any stamping,
  // so a baseline cut short resumes on the next boot against the same instant
  // rather than a later one. "done" is recorded after the stamping; a stamp
  // that fails throws, and the pass that called this acts on nothing until a
  // later pass completes it. A session whose stamp fails STRIKES times is
  // given up on, logged, so one broken record cannot hold every other session
  // unrecovered.
  const stuck = new Map<string, number>()

  export async function baseline() {
    const mark = await Meta.get(BASELINE)
    if (mark?.startsWith("done")) return 0
    const since = mark ? Number(mark.split(" ")[1]) : boot * 1000
    if (!mark) await Meta.update(BASELINE, (value) => value ?? `pending ${since}`)
    const read = await Messages.reader()
    // A never-prompted child has no prompt to date it, so its creation does:
    // one made since is a launch in progress, not history.
    const unprompted = (await Sessions.listUnprompted()).filter((child) => child.time.created < since)
    const stale = [
      ...(await Sessions.listOwed()),
      ...(await Sessions.listTurning()),
      ...(await Sessions.listUnanswered(since)),
      ...unprompted,
    ].filter(
      (session) =>
        (session.turn ? session.turn.pid !== process.pid : true) &&
        read.prompted(session.id) < since &&
        (stuck.get(session.id) ?? 0) < STRIKES,
    )
    // Re-checked per session: one prompted since the scan above is new work.
    const stamp = (draft: Session.Info) => {
      if (read.prompted(draft.id) >= since) return
      draft.time.stopped = Math.max(draft.time.stopped ?? 0, since - 1)
      if (draft.turn && draft.turn.pid !== process.pid) draft.turn = undefined
    }
    const before = new Map(stale.map((session) => [session.id, session.time.stopped]))
    // Written to storage first, which needs no instance and so reaches sessions
    // whose directory is gone; then re-read by an instance already open for
    // it, so it does not keep serving the old copy. One not open reads fresh
    // when a request opens it, so none is opened here for history.
    const failures = await Promise.all(
      stale.map(async (session) => {
        const failed = await Sessions.update(session.id, stamp).then(
          () => false,
          (error) => {
            const count = (stuck.get(session.id) ?? 0) + 1
            stuck.set(session.id, count)
            log.error("baseline failed", { sessionID: session.id, attempt: count, error })
            return count < STRIKES
          },
        )
        if (Instance.cached(session.directory))
          await Instance.provide({ directory: session.directory, fn: () => Session.reload(session.id) }).catch(
            () => undefined,
          )
        return failed
      }),
    )
    // Every job still running is made owed, read against the stop times from
    // before the stamping above: a session a person stopped earlier owes
    // nothing, while one this baseline just stamped still gets its result.
    for (const job of await BackgroundJob.list()) {
      if (job.status !== "running") continue
      // By membership, not value: a stamped session that was never stopped
      // before has `undefined` here, and a live read would see the stamp.
      const stopped = before.has(job.sessionID)
        ? before.get(job.sessionID)
        : (await Sessions.read(job.sessionID).catch(() => undefined))?.time.stopped
      if ((stopped ?? 0) < job.time.created) await Owed.add(job.id, job.sessionID)
    }
    const failed = failures.filter(Boolean).length
    if (failed > 0) throw new Error(`baseline could not stop ${failed} of ${stale.length} sessions`)
    await Meta.update(BASELINE, () => `done ${Date.now()}`)
    log.info("baseline", { stopped: stale.length })
    return stale.length
  }

  // ---- delivery ----------------------------------------------------------

  // `unprompted` pays a child whose own prompt never got written for a launch
  // at `since`, so the owed rule cannot see it: it claims only a child neither
  // delivered, prompted, nor stopped since that launch.
  //
  // `subagent` pays what its caller judged against the prompt `prompted` (an
  // ended turn's answer, a cut turn's failure): a launch that prompts the
  // child again while the caller works makes the judgement stale, so the
  // claim is refused and the new launch's own turn reports.
  type Payment =
    | { kind: "subagent"; child: string; status: "completed" | "failed"; prompted: number }
    | { kind: "unprompted"; child: string; since: number; status: "failed" }
    | { kind: "job"; job: string }

  export type Part = Omit<MessageV2.TextPart, "id" | "messageID" | "sessionID" | "type">

  // Whether `payment` is still due, read synchronously so the same test runs
  // before the transaction (to skip work) and inside it (to claim).
  function due(payment: Payment, child: Session.Info | undefined, prompted: number) {
    if (payment.kind === "job") return true
    if (!child) return false
    if (payment.kind === "subagent")
      return owed(child, prompted) && payment.prompted === prompted
    const since = payment.since
    return (child.time.injected ?? 0) < since && prompted < since && (child.time.stopped ?? 0) < since
  }

  // Mint one synthetic message carrying `parts` into `sessionID` and pay the
  // debt, both or neither. The claim is re-checked inside the transaction, so
  // two passes (or two processes) racing on one debt deliver it once. Returns
  // whether this caller delivered.
  export async function deliver(sessionID: string, parts: Part[], payment: Payment, wake = true) {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session) return false
    const [write, attach, mutate, read, claim, lookup] = await Promise.all([
      Messages.writer(),
      Parts.writer(),
      Sessions.mutator(),
      Messages.reader(),
      Owed.claimer(),
      Sessions.reader(),
    ])
    // Checked before the revert cleanup, which commits the session's pending
    // revert: a debt already paid elsewhere must not cost the person their undo.
    const child = payment.kind === "job" ? undefined : lookup(payment.child)
    const payable =
      payment.kind === "job" ? await Owed.has(payment.job) : due(payment, child, read.prompted(payment.child))
    if (!payable) return false
    if (session.revert) await SessionRevert.cleanup(session)
    const history = await Session.messages({ sessionID })
    const params = await MessageV2.currentParams(sessionID, history)
    const info: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "user",
      // After any stop this delivery saw: an Esc stamped in the same
      // millisecond would otherwise read as a stop after the delivery, and no
      // turn would ever answer it. At most a millisecond ahead of the clock,
      // so a stop dated later (a clock stepped back) wins and never pushes the
      // message past replies written after it. A stop landing after this read
      // still wins.
      time: { created: Math.max(Date.now(), Math.min((session.time.stopped ?? 0) + 1, Date.now() + 1)) },
      ...params,
      synthetic: true,
      promptIndex: MessageV2.nextPromptIndex(history),
    }
    const rows = parts.map(
      (part): MessageV2.TextPart => ({
        ...part,
        id: Identifier.ascending("part"),
        messageID: info.id,
        sessionID,
        type: "text",
      }),
    )
    const paid = await Db.transaction(() => {
      const won =
        payment.kind === "job"
          ? claim(payment.job)
          : !!mutate(payment.child, (draft) => {
              const prompted = read.prompted(payment.child)
              if (!due(payment, draft, prompted)) return false
              draft.time.injected = Math.max(info.time.created, prompted)
              draft.time.reported = payment.status
              return true
            })
      if (!won) return false
      write(info)
      for (const part of rows) attach(part)
      return true
    })
    if (!paid) return false
    MessageV2.uncache(info.id)
    await Session.updateMessage(info)
    for (const part of rows) Session.publishPart(part)
    if (payment.kind !== "job") await Session.reload(payment.child).catch(() => undefined)
    if (wake) void rouse(sessionID, info.time.created).catch((error) => log.error("wake failed", { sessionID, error }))
    return true
  }

  // Start a turn for a message that is waiting for one, unless the session
  // should not run one: stopped since `delivered`, a subagent nobody collects
  // from any more, a session whose person left with the process that ran it
  // (its last turn transient), or a turn already live in another process
  // (that turn reads the message itself, and one it misses is picked up by
  // the next pass).
  //
  // `loop` joins a loop that is still running and returns its result, and a
  // loop past its last read of the history but not yet finished never sees the
  // new message; so this asks again while the newest message is still a user
  // message, stopping at a loop that failed or was aborted. A message whose
  // wakes keep failing is left for a person after STRIKES of them, and a
  // subagent's parent is told.
  // Keyed by session, holding the message whose wakes are failing: a later
  // message resets it, so the map holds at most one entry per session.
  const wakes = new Map<string, { message: string; count: number }>()

  async function rouse(sessionID: string, delivered: number) {
    if (closed) return
    const read = await Messages.reader()
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await Sessions.read(sessionID).catch(() => undefined)
      if (!session || (session.time.stopped ?? 0) >= delivered) return
      // Its reader left with the transient process that ran its last turn.
      // While that process lives it is still attached, and is woken. A
      // subagent that process left owed has no turn coming (a live launch
      // replaces `left` as its turn starts), so once its prompt has waited
      // past SETTLE_MS its parent is told instead what its turn ended with
      // (a job result landed after it). A turn still marked is a cut one,
      // which resume reports; a parent that is gone is never paid, so the
      // child stops owing it, as settle does.
      if (typeof session.left === "object" && (await alive(session.left)) === false) {
        const waited = read.prompted(sessionID)
        if (!session.parentID || session.turn || !owed(session, waited) || Date.now() - waited <= SETTLE_MS) return
        if (!(await Sessions.read(session.parentID).catch(() => undefined))) {
          log.error("lost a result", { child: sessionID, parent: session.parentID })
          await Session.mark(sessionID, (draft) => void (draft.time.stopped = Date.now()))
          return
        }
        const last = await answer(sessionID, waited)
        await report(session, last.status, last.output, waited)
        return
      }
      const prompted = read.prompted(sessionID)
      if (!wanted(session, prompted)) return
      if (session.turn && session.turn.pid !== process.pid && (await alive(session.turn)) !== false) return
      const waiting = read.newest(sessionID)?.id ?? ""
      const prior = wakes.get(sessionID)
      if (prior?.message === waiting && prior.count >= STRIKES) return
      const failure = await SessionPrompt.loop(sessionID).then(
        () => undefined,
        (error: unknown) => error ?? new Error(`the wake of session ${sessionID} was aborted`),
      )
      if (failure) {
        const count = (prior?.message === waiting ? prior.count : 0) + 1
        wakes.set(sessionID, { message: waiting, count })
        log.error("wake failed", { sessionID, attempt: count, error: failure })
        if (count >= STRIKES && session.parentID && owed(session, prompted))
          await fail(sessionID, failure instanceof Error ? failure.message : String(failure), prompted, prompted)
        return
      }
      wakes.delete(sessionID)
      if (read.newest(sessionID)?.role !== "user") return
    }
  }

  // The agent tool titles a child "<description> (@<agent> subagent)".
  function description(child: Session.Info) {
    return child.title.replace(/ \(@[^)]+ subagent\)$/, "")
  }

  // How a child's last turn ended, read off its newest assistant message: an
  // error other than an abort is a failure, anything else a completion.
  function outcome(last: MessageV2.Assistant | undefined) {
    const error = last?.error
    if (!error || error.name === "MessageAbortedError") return { status: "completed" as const }
    return {
      status: "failed" as const,
      detail: "message" in error.data ? String(error.data.message) : error.name,
    }
  }

  export function notification(input: {
    child: Session.Info
    status: "completed" | "failed"
    output: string
    duration: number
  }) {
    const agent = input.child.current?.agent ?? MessageV2.UNKNOWN_AGENT
    return [
      `<background-subagent-result>`,
      `subagent_id: ${input.child.id}`,
      `status: ${input.status}`,
      `duration: ${Math.round(input.duration / 1000)}s`,
      `agent: ${agent}`,
      `session_id: ${input.child.id}`,
      ``,
      input.status === "failed" ? `ERROR: ${input.output}` : input.output,
      `</background-subagent-result>`,
    ].join("\n")
  }

  // A child whose turn could not run for a launch at `since` (its prompt threw,
  // before or after its message was written) reports the error rather than
  // leaving its parent waiting forever.
  //
  // `failed` is the prompt whose turn failed, when the caller knows it; the
  // failure is judged against it, so a launch that prompts the child again
  // before this runs is left to its own turn (see Payment). Without one it
  // is the child's prompt as read here.
  export async function fail(childID: string, error: string, since: number, failed?: number) {
    const child = await Session.get(childID).catch(() => undefined)
    if (!child?.parentID) return
    // A prompt for this launch that did land joined a turn that is running,
    // or one its instance cut: that turn's end reports, and a cut one is
    // resumed. A marker alone proves nothing: it may be an earlier launch's.
    const prompted = (await Messages.reader()).prompted(childID)
    const stored = await Sessions.read(childID).catch(() => undefined)
    if (stored?.turn && prompted >= since) return
    if (await report(child, "failed", error, failed ?? prompted)) return
    // The prompt was never written, so the owed rule cannot see this launch.
    // It was made for this parent, so it reports anyway.
    await deliver(child.parentID, [part(child, "failed", error, 0)], {
      kind: "unprompted",
      child: child.id,
      since,
      status: "failed",
    })
  }

  function part(child: Session.Info, status: "completed" | "failed", output: string, prompted: number): Part {
    const duration = Date.now() - (prompted || child.time.created)
    return {
      text: notification({ child, status, output, duration }),
      synthetic: true,
      backgroundSubagentResult: {
        subagentId: child.id,
        description: description(child),
        status,
        agent: child.current?.agent,
        sessionID: child.id,
        duration,
      },
    }
  }

  // `judged` is the prompt the caller read its outcome against, read before
  // anything it judged by (see Payment).
  function report(child: Session.Info, status: "completed" | "failed", output: string, judged: number) {
    return deliver(
      child.parentID!,
      [part(child, status, output, judged)],
      { kind: "subagent", child: child.id, status, prompted: judged },
    )
  }

  // ---- the subagents dialog ---------------------------------------------

  export const Status = z.enum(["running", "completed", "failed", "stopped"])
  export const Subagent = z
    .object({
      id: z.string(),
      parentSessionID: z.string(),
      status: Status,
      description: z.string(),
      agent: z.string(),
      time: z.object({ created: z.number(), completed: z.number().optional() }),
      // A running child's tool activity; absent once it is no longer running.
      progress: z.object({ toolCount: z.number(), currentActivity: z.string().optional() }).optional(),
    })
    .meta({ ref: "Subagent" })
  export type Subagent = z.infer<typeof Subagent>

  // A session's subagents as the database has them, so the list is the same
  // before and after a restart. Status is the owed rule read out loud: owed is
  // running, a stop newer than the last prompt and not yet answered by a
  // delivery is stopped, else what the last delivery told the parent. A child
  // with nothing delivered and no prompt was made a moment ago and is about to
  // run.
  export async function subagents(parentID: string) {
    const read = await Messages.reader()
    const children = (await Session.children(parentID)).filter((child) => child.time.injected !== undefined)
    const rows = await Promise.all(
      children.map(async (child): Promise<Subagent> => {
        const prompted = read.prompted(child.id)
        // A stop after the delivery (the parent stopped or archived later)
        // interrupted nothing: the row keeps what was reported.
        const delivered = !!child.time.injected && child.time.injected >= prompted
        const stopped = !delivered && child.time.stopped !== undefined && child.time.stopped >= prompted
        const newest = read.newest(child.id)
        const last = newest?.role === "assistant" ? newest : undefined
        // A child delivered before this field existed carries no report; its
        // last assistant message stands in, as it always did.
        const reported = child.time.reported ?? (child.time.injected ? outcome(last).status : undefined)
        const status =
          owed(child, prompted) || (!reported && !stopped && child.time.injected === 0)
            ? "running"
            : stopped
              ? "stopped"
              : (reported ?? "failed")
        const base: Subagent = {
          id: child.id,
          parentSessionID: parentID,
          status,
          description: description(child),
          agent: child.current?.agent ?? MessageV2.UNKNOWN_AGENT,
          time: {
            created: prompted || child.time.created,
            ...(status === "running"
              ? {}
              : { completed: stopped ? child.time.stopped : child.time.injected || last?.time.completed }),
          },
        }
        if (status !== "running") return base
        // Only a running child's progress changes, so only its transcript is read.
        const tools = (await Session.messages({ sessionID: child.id })).flatMap((m) =>
          m.parts.filter((p): p is MessageV2.ToolPart => p.type === "tool"),
        )
        const current = tools.findLast((t) => t.state.status === "running") ?? tools.at(-1)
        return {
          ...base,
          progress: {
            toolCount: tools.filter((t) => t.state.status === "completed").length,
            currentActivity: current
              ? `${current.state.status === "running" ? "Running" : "Completed"} ${current.tool}`
              : undefined,
          },
        }
      }),
    )
    return rows.sort((a, b) => b.time.created - a.time.created)
  }

  // ---- the pass ----------------------------------------------------------

  let running: Promise<void> | undefined
  let queued: Promise<void> | undefined

  // Ask for a pass. Resolves after a pass that STARTED after this call, so a
  // caller that just wrote a fact sees it acted on. Requests made while a pass
  // runs share one follow-up pass, so a burst of turn endings costs two passes.
  export function poke(): Promise<void> {
    if (queued) return queued
    if (running) {
      queued = running.then(() => {
        queued = undefined
        return poke()
      })
      return queued
    }
    running = pass()
      .catch((error) => log.error("pass failed", { error }))
      .finally(() => {
        running = undefined
      })
    return running
  }

  // The first pass this process runs under the lease does the boot work
  // before anything else: the baseline (so history is never replayed), the
  // re-arm of warm sessions, and the removal of headless runs a restart cut.
  // A baseline that throws leaves `booted` false, so this pass acts on nothing
  // and the next one tries again. Each step re-takes the lease, which is also
  // its heartbeat, so a long pass cannot outlive it unnoticed.
  async function pass() {
    if (!(await lease())) return
    if (!booted) {
      await baseline()
      await arm()
      const { HeadlessAgent } = await import("./headless")
      await HeadlessAgent.sweep(boot * 1000)
      booted = true
    }
    for (const session of await Sessions.listTurning()) if (await lease()) await within(session, () => resume(session))
    for (const child of await Sessions.listUnprompted())
      if (child.time.created < boot * 1000 && (await lease())) await within(child, () => orphan(child))
    for (const child of await Sessions.listOwed()) if (await lease()) await within(child, () => settle(child))
    for (const debt of await Owed.list()) if (await lease()) await payJob(debt.jobID, debt.sessionID)
    const read = await Messages.reader()
    for (const session of await Sessions.listUnanswered(Date.now() - SETTLE_MS)) {
      const waiting = read.newest(session.id)
      if (!waiting || SessionBusy.busy(session.id) || !(await lease())) continue
      await within(
        session,
        async () =>
          void rouse(session.id, waiting.time.created).catch((error) =>
            log.error("wake failed", { sessionID: session.id, error }),
          ),
      )
    }
  }

  // Pay what one session is owed without waiting for a leased pass: its
  // settled jobs' results and, for a subagent, its result to its parent. Every
  // payment is claimed inside its delivery transaction, so any process may
  // call this for a session it just ran, even one that never holds the lease
  // (`opencode run`) or one still inside its boot grace. Called when a turn
  // ends in any process, and when a job exits in a process running the
  // orchestrator. A child still marking a turn has not finished it, so its
  // result waits for that.
  export async function collect(sessionID: string) {
    if (closed) return
    const session = await Sessions.read(sessionID).catch(() => undefined)
    if (!session) return
    for (const debt of (await Owed.list()).filter((debt) => debt.sessionID === sessionID))
      await payJob(debt.jobID, debt.sessionID)
    if (!session.turn && session.parentID && owed(session, (await Messages.reader()).prompted(sessionID)))
      await within(session, () => settle(session))
  }

  // Recovery opens an instance for a session's directory when no request has.
  // It is bootstrapped like one a request opens (plugins, the file watcher),
  // because a later request reuses it.
  function within(session: Session.Info, fn: () => Promise<unknown>) {
    return enter(session.directory, fn).catch((error) =>
      log.error("recovery step failed", { sessionID: session.id, error }),
    )
  }

  async function enter<R>(directory: string, fn: () => R) {
    const { InstanceBootstrap } = await import("@/project/bootstrap")
    return Instance.provide({ directory, init: InstanceBootstrap, fn })
  }

  async function resume(session: Session.Info) {
    if (!(await cut(session))) return
    const turn = session.turn!
    // A turn run by a process that does not recover its own work is over when
    // that process is; so is one whose session was stopped.
    const stopped = (session.time.stopped ?? 0) >= turn.at
    const resumes = turn.resumes ?? 0
    const quit = stopped || turn.transient || resumes >= CAP
    const next = quit ? undefined : { at: turn.at, pid: process.pid, boot, nonce: turn.nonce, resumes: resumes + 1 }
    // Claimed against the marker read at the start of the pass: a turn that
    // started since (its own marker) is live and is left alone.
    const mutate = await Sessions.mutator()
    const claimed = await Db.transaction(
      () =>
        !!mutate(session.id, (draft) => {
          if (draft.turn?.at !== turn.at || draft.turn.pid !== turn.pid || draft.turn.nonce !== turn.nonce) return false
          draft.turn = next
          return true
        }),
    )
    if (!claimed) return
    await Session.reload(session.id).catch(() => undefined)
    if (quit) {
      log.info("leaving a cut turn", { sessionID: session.id, stopped, transient: turn.transient, resumes })
      // For the prompt the cut turn was answering. A newer one is a launch
      // continuing the child, which its own turn reports; one that joined the
      // cut turn has none coming, and is reported by the unanswered sweep
      // (rouse) once it has waited SETTLE_MS.
      const prompted = (await Messages.reader()).prompted(session.id)
      if (!stopped && session.parentID && prompted <= turn.at && owed(session, prompted))
        await report(
          session,
          "failed",
          turn.transient
            ? "the process running it exited before it finished"
            : `could not resume after ${resumes} attempts`,
          prompted,
        )
      return
    }
    // A stop that landed after the claim above wins over the resume.
    if (await Sessions.halted(session.id, turn.at)) {
      await Session.mark(session.id, (draft) => {
        if (draft.turn?.pid === process.pid && draft.turn.at === turn.at) draft.turn = undefined
      })
      return
    }
    const children = session.parentID
      ? []
      : (await Sessions.listOwed()).filter((child) => child.parentID === session.id)
    const waiting = (await Promise.all(children.map(done))).filter((finished) => !finished).length
    log.info("resuming a cut turn", { sessionID: session.id, attempt: resumes + 1 })
    void SessionPrompt.prompt({
      sessionID: session.id,
      parts: [
        {
          type: "text",
          text: session.parentID ? SUBAGENT_RESUME_TEXT : parentResumeText(waiting),
          synthetic: true,
        },
      ],
    }).catch(async (error) => {
      // A resume that never reached its turn leaves this process's marker on
      // the session. Mark it dead so the next pass counts it against the cap.
      log.error("resume failed", { sessionID: session.id, error })
      await Session.mark(session.id, (draft) => {
        if (draft.turn?.pid === process.pid && draft.turn.at === turn.at) draft.turn.boot = 0
      }).catch((failure) => log.error("could not mark a failed resume", { sessionID: session.id, error: failure }))
    })
  }

  // A child launched before this process whose prompt was never written: its
  // launch died with the server, so it reports failed instead of reading as
  // running forever.
  async function orphan(child: Session.Info) {
    const parent = await Sessions.read(child.parentID!).catch(() => undefined)
    if (!parent) return Session.mark(child.id, (draft) => void (draft.time.stopped = Date.now()))
    await deliver(child.parentID!, [part(child, "failed", "the server stopped before this subagent started", 0)], {
      kind: "unprompted",
      child: child.id,
      since: boot * 1000,
      status: "failed",
    })
  }

  async function settle(child: Session.Info) {
    // Read before `done`: a prompt that lands before this read makes the
    // child not done, and one after it makes the claim refuse (see Payment).
    const judged = (await Messages.reader()).prompted(child.id)
    if (!(await done(child))) return
    // A parent that no longer exists can never be paid; stop owing it.
    if (!(await Sessions.read(child.parentID!).catch(() => undefined))) {
      log.error("lost a result", { child: child.id, parent: child.parentID })
      await Session.mark(child.id, (draft) => void (draft.time.stopped = Date.now()))
      return
    }
    const messages = await Session.messages({ sessionID: child.id })
    const last = told(messages.findLast((m) => m.info.role === "assistant"))
    if (await report(child, last.status, last.output, judged))
      log.info("delivered subagent result", { child: child.id, parent: child.parentID })
  }

  // What an assistant message told: its status, and its text or its error.
  function told(last: MessageV2.WithParts | undefined) {
    const ending = outcome(last?.info as MessageV2.Assistant | undefined)
    const output =
      ending.status === "failed" ? (ending.detail ?? "") : (last?.parts.findLast((p) => p.type === "text")?.text ?? "")
    return { status: ending.status, output }
  }

  // What a child's turn ended with for its prompt dated `prompted`, read as
  // settle reads it: its newest step, whatever that step told. Each step
  // links to the newest user message when it began, which a job result or a
  // compaction landing mid-turn replaces, so a step belongs to this prompt
  // when the message it links to is the prompt or newer; a compaction's
  // summary is the model's own bookkeeping, never an answer. Only a step that
  // asked for tools and got no further (cut between steps, or stopped at a
  // declined permission) tells nothing. Read uncompacted, so a mid-turn
  // compaction does not hide the prompt.
  async function answer(sessionID: string, prompted: number) {
    const messages = await Session.messages({ sessionID, compacted: false })
    const since = new Set(
      messages.filter((m) => m.info.role === "user" && m.info.time.created >= prompted).map((m) => m.info.id),
    )
    const last = messages.findLast(
      (m) => m.info.role === "assistant" && !m.info.summary && since.has(m.info.parentID),
    )
    if (last?.info.role !== "assistant") return { status: "failed" as const, output: "it never answered its prompt" }
    if (!last.info.error && (!last.info.finish || ["tool-calls", "unknown"].includes(last.info.finish)))
      return { status: "failed" as const, output: "it stopped before it answered its prompt" }
    return told(last)
  }

  // A job whose delivery throws is retried, and recorded as lost only after
  // STRIKES failed attempts in a row, so one transient failure does not drop a
  // result while a permanent one does not hold its session open forever. One
  // attempt per job at a time: a turn ending and a pass reaching the same debt
  // together would otherwise count one failure twice.
  const strikes = new Map<string, number>()
  const paying = new Map<string, Promise<void>>()

  function payJob(jobID: string, sessionID: string) {
    const current = paying.get(jobID)
    if (current) return current
    const attempt = pay(jobID, sessionID)
      .catch((error) => log.error("could not pay a job's result", { jobID, sessionID, error }))
      .finally(() => paying.delete(jobID))
    paying.set(jobID, attempt)
    return attempt
  }

  async function pay(jobID: string, sessionID: string) {
    const job = await BackgroundJob.get(jobID)
    if (!job) {
      await Owed.remove(jobID)
      return
    }
    if (job.status === "running") return
    const lose = async (error?: unknown) => {
      log.error("lost a result", { jobID, sessionID, error })
      await BackgroundJob.update(jobID, (draft) => void (draft.time.lost = Date.now()))
      await Owed.remove(jobID)
      strikes.delete(jobID)
    }
    await enter(BackgroundJob.owner(job), async () => {
      const kind = job.status === "killed" ? "timeout" : "completed"
      const text = BackgroundNotify.render(job, await BackgroundJob.output(job.id), kind, Date.now())
      const delivered = await deliver(
        sessionID,
        [{ text, synthetic: true, backgroundJobResult: BackgroundNotify.meta(job, kind) }],
        { kind: "job", job: jobID },
      )
      strikes.delete(jobID)
      if (delivered || (await Session.get(sessionID).catch(() => undefined))) return
      await lose()
    }).catch(async (error) => {
      const count = (strikes.get(jobID) ?? 0) + 1
      if (count < STRIKES) {
        log.error("result delivery failed", { jobID, sessionID, attempt: count, error })
        strikes.set(jobID, count)
        return
      }
      await lose(error)
    })
  }

  // ---- arming ------------------------------------------------------------

  // Re-arm keep-warm pings on root sessions whose cache is still warm, for the
  // boot after a restart. `keepWarm` is the intent: a Stop clears it, and an
  // Esc leaves it, so an interrupted session is re-armed like any other.
  async function arm() {
    for (const session of await Sessions.listWarm(Date.now() - CACHE_TTL))
      await within(session, async () => SessionPing.start(session.id))
  }

  // ---- lifecycle ---------------------------------------------------------

  // `serve` passes `primary`; `web` and `acp` do not (see `primary` above).
  export function init(options: { primary?: boolean } = {}) {
    active = true
    primary = options.primary ?? false
    SessionBusy.onIdle(() => void poke())
    Scheduler.register({ id: "recovery", interval: SWEEP_MS, scope: "global", run: () => poke() })
    setTimeout(() => {
      start()
      void poke()
    }, GRACE_MS).unref()
  }
}
