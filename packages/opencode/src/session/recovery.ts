import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Db } from "@/storage/db"
import { Meta } from "@/storage/meta"
import { Debt } from "@/storage/debt"
import { Jobs } from "@/storage/jobs"
import { Messages } from "@/storage/messages"
import { Sessions } from "@/storage/sessions"
import { Storage } from "@/storage/storage"
import { Scheduler } from "@/scheduler"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { Provider } from "../provider/provider"
import { SessionBusy } from "./busy"
import { SessionPrompt } from "./prompt"
import { CACHE_TTL, SessionPing } from "./ping"
import { BackgroundJob } from "@/background/job"
import { BackgroundNotify } from "@/background/notify"
import { BackgroundProcess } from "@/background/process"

// The one place that decides what a restart, a finished subagent, or a finished
// job owes, and pays it. Everything else only writes facts (a prompt, a step
// finishing, a stop, a job settling, a debt row); this reads them from the
// database and acts. Level-triggered: every pass re-derives the whole picture,
// so a missed event costs latency, never a lost result.
//
// What is owed is a row in the debt table (storage/debt.ts): a responder (a job
// or a child session) owes its caller an outcome, and the one message that
// delivers it removes the row in the same transaction.
export namespace Recovery {
  const log = Log.create({ service: "recovery" })

  // Failed resumes in a row before a cut turn is left alone.
  export const CAP = 3
  export const SWEEP_MS = 60 * 1000
  // A process not started `live` competes for the lease only once it has been
  // up this long. A supervisor's staging build lives for its health check and
  // is killed well before this, so it never runs recovery against the live
  // server's sessions, even when the live server is an older build that holds
  // no lease at all.
  export const GRACE_MS = 60 * 1000
  const LEASE_TTL = 3 * SWEEP_MS
  const LEASE = "recovery.lease"
  // Failed attempts in a row before this process pauses paying a debt (the row
  // stays), or before a waiting message is left for a person to answer.
  const STRIKES = 3
  // How long a debt that hit STRIKES waits before this process tries it again.
  const RETRY_MS = 10 * 60 * 1000
  // A delivered message younger than this is still its own wake's to answer:
  // the process that wrote it may not have marked its turn yet.
  const SETTLE_MS = 10 * 1000

  export const SUBAGENT_RESUME_TEXT =
    "Pardon the interruption — your turn was cut off before it finished. Continue what you were doing and finish the task you were given; your result is still awaited by the session that launched you."

  export function resumeText(running: number) {
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

  const STOPPED =
    "The user stopped this subagent before it finished. Its work so far is in its session; continue it with this session_id to pick up where it left off."

  // ---- decisions ---------------------------------------------------------

  export const boot = BackgroundProcess.boot
  const alive = BackgroundProcess.alive

  type Reader = Awaited<ReturnType<typeof Messages.reader>>

  // A session row, or undefined when there is none. Any other failure (a busy
  // database, a row that no longer parses) is not "gone": it rethrows, so the
  // caller's retry accounting sees it and nothing is cleared on its account.
  async function find(sessionID: string) {
    return Sessions.read(sessionID).catch((error: unknown) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
  }

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
  // turn in flight here, no turn marker, nothing still owed to it, no message
  // waiting for a turn (a result delivered a moment ago that the loop it woke
  // has not picked up yet; one a stop already dropped does not count), and a
  // last turn that was not interrupted (which waits for a new message instead).
  export async function done(session: Session.Info) {
    if (SessionBusy.busy(session.id) || session.turn) return false
    if (await Debt.owing(session.id)) return false
    const read = await Messages.reader()
    return !read.waiting(session.id, session.time.stopped) && !read.interrupted(session.id, session.time.stopped)
  }

  // Whether the sweep of unanswered messages should start a turn in
  // `session`: a subagent that owes nothing has already reported, and a turn
  // for it would produce a result nobody collects.
  async function awaited(session: Session.Info) {
    return !session.parentID || (await Debt.has(session.id))
  }

  // ---- lease -------------------------------------------------------------

  // False until the boot grace has passed (`init`) or a test opens the gate
  // (`start`). A process that never calls either never acts, so a staging
  // build stays inert.
  let ready = false
  let booted = false

  export function start() {
    ready = true
  }

  // Close the gate `start` opened, for a test that must leave the process as
  // it found it.
  export function stop() {
    ready = false
  }

  // One server acts at a time: the one holding the lease. A holder is taken
  // over only once it is gone or has stopped renewing.
  export async function lease(now = Date.now()) {
    if (!ready) return false
    const raw = await Meta.get(LEASE)
    const held = raw ? (JSON.parse(raw) as { pid: number; boot?: number; at: number }) : undefined
    const mine = held?.pid === process.pid && held.boot === boot
    // A holder the process table could not answer for is kept as live.
    const live = !!held && !mine && now - held.at <= LEASE_TTL && (await alive(held)) !== false
    if (live) return false
    return Meta.update(LEASE, (value) =>
      value === raw ? JSON.stringify({ pid: process.pid, boot, at: now }) : undefined,
    )
  }

  // ---- delivery ----------------------------------------------------------

  export type Part = Omit<MessageV2.TextPart, "id" | "messageID" | "sessionID" | "type">
  type Outcome = { status: "completed" | "failed" | "cancelled"; output: string }

  function text(parts: Part[]) {
    return parts.map((part) => ({ ...part, type: "text" as const }))
  }

  // Send `parts` to `sessionID` the way a typed prompt is sent, paying the debt
  // `responder` owes inside the transaction that writes the message: both or
  // neither, so two passes (or two processes) racing on one debt deliver it
  // once. When `judged` is given the claim also holds only while the row is
  // still the one judged: no message has joined it since (`asks`), and it was
  // not paid and reopened by a new message in between (`created`), which a
  // count alone cannot tell apart. A Stop on the caller that lands after the
  // payer decided to pay does not refuse the write: that window is accepted,
  // and the turn it starts is stopped again by hand.
  // Checked before the send too, so the usual loser does no work; one that
  // still loses inside the send has run the send's side effects (the arm, the
  // revert cleanup), which the winner ran on the same session anyway.
  // Like any prompt it joins the running turn or starts one; `wake: false`
  // only writes it, for a turn about to start that will read it. Returns
  // whether this caller delivered.
  export async function deliver(
    sessionID: string,
    parts: Part[],
    responder: string,
    options: { wake?: boolean; join?: boolean; judged?: Pick<Debt.Row, "asks" | "created"> } = {},
  ) {
    if (!(await Debt.has(responder))) return false
    const claim = await Debt.claimer()
    const judged = options.judged
    const message = await SessionPrompt.deliver({
      sessionID,
      parts: text(parts),
      model: Provider.INHERIT,
      variant: Provider.INHERIT,
      wake: options.wake,
      join: options.join,
      claim: () => {
        const row = claim.get(responder)
        if (!row) return false
        if (judged && (row.asks !== judged.asks || row.created !== judged.created)) return false
        return claim.pay(responder)
      },
    })
    if (message) await SessionBusy.push(sessionID)
    return !!message
  }

  // Tell a session something that is not a debt (a running job's check-in),
  // the way everything else is told: the same send, joining the running turn
  // or starting one. It is written only while `job` is still running, read in
  // the writing transaction; a message into a subagent joins its open debt
  // without opening one.
  export async function notify(sessionID: string, parts: Part[], job: string) {
    const status = await Jobs.reader()
    const archived = await Sessions.archivedReader()
    const message = await SessionPrompt.deliver({
      sessionID,
      parts: text(parts),
      model: Provider.INHERIT,
      variant: Provider.INHERIT,
      join: true,
      // Read inside the write. A check-in into a session a Stop is settling is
      // dropped, since its turn was just cancelled and the Stop pays what the
      // job still owes; so is one into an archived session, which is put away
      // like a payment into one.
      claim: () => status(job) === "running" && !held(sessionID) && !archived(sessionID),
    })
    return !!message
  }

  // Start a turn for a message that is waiting for one, found by the sweep of
  // unanswered messages, unless the session should not run one: stopped
  // since `delivered`, a subagent that owes nothing, or a turn already
  // live in another process (that turn reads the message itself, and one it
  // misses is picked up by the next pass).
  //
  // `loop` joins a loop that is still running and returns its result, and a
  // loop past its last read of the history but not yet finished never sees the
  // new message; so this asks again while a message is still waiting,
  // stopping at a loop that failed or was aborted. A message whose wakes keep
  // failing is left for a person after STRIKES of them, and a subagent's
  // caller is told.
  // Keyed by session, holding the message whose wakes are failing: a later
  // message resets it, so the map holds at most one entry per session.
  const wakes = new Map<string, { message: string; count: number }>()

  async function rouse(sessionID: string, delivered: number) {
    const read = await Messages.reader()
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await find(sessionID)
      // listUnanswered already skips archived sessions; this re-check covers
      // an archive landing between that list and this attempt.
      if (!session || session.time.archived || (session.time.stopped ?? 0) >= delivered) return
      if (!(await awaited(session))) return
      if (session.turn && session.turn.pid !== process.pid && (await alive(session.turn)) !== false) return
      const waiting = read.pending(sessionID, session.time.stopped)?.id ?? ""
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
        if (count >= STRIKES)
          await fail(sessionID, failure instanceof Error ? failure.message : String(failure), delivered)
        return
      }
      wakes.delete(sessionID)
      if (!read.waiting(sessionID)) return
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

  function notification(input: { child: Session.Info; status: Outcome["status"]; output: string; duration: number }) {
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

  // A child whose turn could not run for work sent at `since` (its launch
  // threw, its wakes kept failing) reports the error rather than leaving its
  // caller waiting. A stop or Esc since then is the person's, not a failure: a
  // Stop pays its own notice and an Esc waits for a new message. A turn still
  // marked or running (which reports on its own), and a child still owed
  // something itself (whose result starts the turn whose end reports), are
  // left to that.
  export async function fail(sessionID: string, message: string, since: number) {
    const child = await find(sessionID)
    if (!child || child.turn || (child.time.stopped ?? 0) >= since) return
    if (SessionBusy.busy(sessionID) || (await Debt.owing(sessionID))) return
    const debt = await Debt.get(sessionID)
    if (debt?.kind !== "subagent") return
    await pay(debt, { forced: { status: "failed", output: message } })
  }

  function part(child: Session.Info, ending: Outcome, created: number): Part {
    const duration = Date.now() - created
    return {
      text: notification({ child, status: ending.status, output: ending.output, duration }),
      synthetic: true,
      backgroundSubagentResult: {
        subagentId: child.id,
        description: description(child),
        status: ending.status,
        agent: child.current?.agent,
        sessionID: child.id,
        duration,
      },
    }
  }

  // What a child's last assistant message told: its status, and its text or
  // its error.
  async function told(childID: string): Promise<Outcome> {
    const last = (await Session.messages({ sessionID: childID })).findLast((m) => m.info.role === "assistant")
    const ending = outcome(last?.info as MessageV2.Assistant | undefined)
    const output =
      ending.status === "failed" ? (ending.detail ?? "") : (last?.parts.findLast((p) => p.type === "text")?.text ?? "")
    return { status: ending.status, output }
  }

  // Pay `debt` if its outcome is known. `forced` is an outcome the one asking
  // decided (a failure, a give-up, a stop), used whatever state the responder
  // is in. One attempt per debt at a time, since a turn ending and a pass
  // reaching the same debt together would otherwise count one failure twice.
  // A forced or `fresh` payment waits until no attempt is in flight and then
  // runs its own rather than sharing that answer: the one in flight judged
  // state from before the fact this caller just wrote. Several such callers
  // waiting on one attempt each wake to find another's in flight and wait
  // again, so they never run side by side. After
  // STRIKES failures in a row this process pauses on the debt for RETRY_MS,
  // and the row stays. A forced payment is never paused: its outcome does not
  // depend on the responder, and a Stop must not leave a debt open.
  const struck = new Map<string, { count: number; at: number }>()
  const paying = new Map<string, Promise<void>>()

  function stuck(responder: string, now = Date.now()) {
    const entry = struck.get(responder)
    return !!entry && entry.count >= STRIKES && now - entry.at < RETRY_MS
  }

  async function pay(debt: Debt.Row, options: { forced?: Outcome; wake?: boolean; fresh?: boolean } = {}) {
    const current = paying.get(debt.responder)
    if (current && !options.forced && !options.fresh) return current
    while (paying.get(debt.responder)) await paying.get(debt.responder)
    if (!options.forced && stuck(debt.responder)) return
    const attempt: Promise<void> = settle(debt, options.forced, options.wake ?? true)
      .then(() => void struck.delete(debt.responder))
      .catch((error) => {
        const count = (struck.get(debt.responder)?.count ?? 0) + 1
        struck.set(debt.responder, { count, at: Date.now() })
        log.error("could not pay a debt", { responder: debt.responder, caller: debt.caller, attempt: count, error })
      })
      .finally(() => {
        if (paying.get(debt.responder) === attempt) paying.delete(debt.responder)
      })
    paying.set(debt.responder, attempt)
    return attempt
  }

  async function settle(debt: Debt.Row, forced: Outcome | undefined, wake: boolean) {
    const caller = await find(debt.caller)
    // A caller that no longer exists can never be paid.
    if (!caller) return Debt.remove(debt.responder).then(() => SessionBusy.push(debt.caller))
    // An archived session is put away: a late payment is recorded, never run.
    const held = stopping.has(caller.id)
    const awake = wake && !held && !caller.time.archived
    // A notice (a job's or a child's) into a session being stopped only joins
    // its debt: opening one would tell its parent it was stopped after it had
    // already reported.
    if (debt.kind === "job") return job(debt, caller, awake, held)
    return subagent(debt, caller, forced, awake, held)
  }

  // Sessions a Stop is settling right now. A payment into one never wakes it,
  // so a job that exits on its own while the Stop kills the levels below
  // cannot start a turn in a session the Stop has already cancelled.
  // Counted, so one of two overlapping Stops releasing a shared session does
  // not un-hold it while the other still settles it.
  const stopping = new Map<string, number>()

  export function hold(ids: string[]) {
    for (const id of ids) stopping.set(id, (stopping.get(id) ?? 0) + 1)
  }

  export function held(id: string) {
    return stopping.has(id)
  }

  export function release(ids: string[]) {
    for (const id of ids) {
      const left = (stopping.get(id) ?? 0) - 1
      if (left > 0) stopping.set(id, left)
      else stopping.delete(id)
    }
  }

  async function job(debt: Debt.Row, caller: Session.Info, wake: boolean, join: boolean) {
    const record = await BackgroundJob.get(debt.responder)
    // The record is gone, and its output with it: nothing is left to pay with.
    if (!record) return Debt.remove(debt.responder).then(() => SessionBusy.push(debt.caller))
    if (record.status === "running") return
    const kind = BackgroundJob.outcome(record)
    await enter(caller.directory, async () => {
      const body = BackgroundNotify.render(record, await BackgroundJob.output(record.id), kind, Date.now())
      await deliver(
        caller.id,
        [{ text: body, synthetic: true, backgroundJobResult: BackgroundNotify.meta(record, kind) }],
        record.id,
        { wake, join },
      )
    })
  }

  async function subagent(
    debt: Debt.Row,
    caller: Session.Info,
    forced: Outcome | undefined,
    wake: boolean,
    join: boolean,
  ) {
    const child = await find(debt.responder)
    if (!child) return Debt.remove(debt.responder).then(() => SessionBusy.push(debt.caller))
    // The asks the debt has counted when the child is judged, checked again in
    // the paying write: a message that joined it in between is still
    // unanswered, so this report does not cover it and the debt stays open
    // for the next one.
    const judged = await Debt.get(child.id)
    if (!judged) return
    await enter(caller.directory, async () => {
      const ending = forced ?? ((await done(child)) ? await told(child.id) : undefined)
      if (!ending) return
      // A Stop's outcome (the only forced "cancelled") holds whatever asked
      // since; a give-up does not, since a later ask is new work to answer.
      const stop = forced?.status === "cancelled"
      if (
        await deliver(caller.id, [part(child, ending, judged.created)], child.id, {
          wake,
          join,
          judged: stop ? undefined : judged,
        })
      )
        log.info("delivered subagent result", { child: child.id, caller: caller.id, status: ending.status })
    })
  }

  // A Stop on `sessionID` settles everything around it. Every job it launched
  // has been stopped, so each reports how it ended; then its caller is told it
  // was stopped. Session.stop reaches its children first, so a subagent debt
  // owed to it is already paid by then. Only `wake` decides whether that last
  // notice starts its caller's turn; the job notices never start this
  // session's, which is stopping. Fresh, so an attempt in flight that judged
  // before the stop cannot stand in for these. Strikes are cleared first: the
  // jobs were just killed, a fact the earlier failures never saw.
  export async function stopped(sessionID: string, options: { wake: boolean }) {
    const unpaid: string[] = []
    for (const debt of await Debt.owed(sessionID)) {
      if (debt.kind !== "job") continue
      struck.delete(debt.responder)
      await pay(debt, { fresh: true, wake: false })
      // Still running means a launch in flight the kill could not reach yet;
      // its spawn settles it. Any other row left open is a payment that failed.
      const record = (await Debt.has(debt.responder)) ? await BackgroundJob.get(debt.responder) : undefined
      if (record && record.status !== "running") unpaid.push(debt.responder)
    }
    const own = await Debt.get(sessionID)
    if (own?.kind === "subagent") {
      struck.delete(own.responder)
      await pay(own, { forced: { status: "cancelled", output: STOPPED }, wake: options.wake })
      if (await Debt.has(own.responder)) unpaid.push(own.responder)
    }
    // A payment that failed leaves its row for a later pass, which would
    // deliver it outside the Stop; the Stop reports it instead.
    if (unpaid.length > 0) throw new Error(`could not pay ${unpaid.join(", ")} during the stop of session ${sessionID}`)
  }

  // ---- what a caller is owed ----------------------------------------------

  // A responder child's state while its debt is open. A message waiting for
  // its turn is work about to run; only a last turn an interrupt ended waits
  // for a new message.
  async function state(child: Session.Info, read: Reader) {
    if (
      SessionBusy.busy(child.id) ||
      child.turn ||
      read.waiting(child.id, child.time.stopped) ||
      (await Debt.owing(child.id))
    )
      return "running" as const
    return read.interrupted(child.id, child.time.stopped) ? ("interrupted" as const) : ("unpaid" as const)
  }

  export const Owing = z
    .object({
      responder: z.string(),
      kind: z.enum(["job", "subagent"]),
      created: z.number(),
      // Paying it failed repeatedly; this process tries again after a pause.
      stuck: z.boolean(),
      // running: still working; interrupted: waiting for a new message;
      // unpaid: its outcome is known and about to be delivered.
      state: z.enum(["running", "interrupted", "unpaid"]),
      description: z.string(),
      command: z.string().optional(),
      elapsed: z.number(),
    })
    .meta({ ref: "Debt" })
  export type Owing = z.infer<typeof Owing>

  // Every open debt owed to `callerID`, with its responder's live state. A
  // responder whose job record or child session is gone is left out, the way
  // settling drops it.
  export async function debts(callerID: string): Promise<Owing[]> {
    // A caller that does not exist throws, rather than reading as owed nothing.
    await Sessions.read(callerID)
    const read = await Messages.reader()
    const now = Date.now()
    const rows = await Promise.all(
      (await Debt.owed(callerID)).map(async (debt): Promise<Owing | undefined> => {
        const base = {
          responder: debt.responder,
          kind: debt.kind,
          created: debt.created,
          stuck: stuck(debt.responder, now),
          elapsed: now - debt.created,
        }
        if (debt.kind === "job") {
          const record = await BackgroundJob.get(debt.responder)
          if (!record) return undefined
          return {
            ...base,
            state: record.status === "running" ? "running" : "unpaid",
            description: record.description,
            command: record.command,
          }
        }
        const child = await find(debt.responder)
        if (!child) return undefined
        return { ...base, state: await state(child, read), description: description(child) }
      }),
    )
    return rows.filter((row): row is Owing => row !== undefined)
  }

  // ---- the subagents dialog ---------------------------------------------

  export const Status = z.enum(["running", "interrupted", "unpaid", "completed", "failed", "stopped"])
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
  // before and after a restart. Only an open debt makes a child live
  // (running, interrupted, or unpaid). A child with none shows what the
  // result it delivered said, and one that never delivered anything (in
  // flight across the upgrade that started the debt table) shows stopped.
  export async function subagents(parentID: string) {
    const [children, transcript, read] = await Promise.all([
      Session.children(parentID),
      Session.messages({ sessionID: parentID }),
      Messages.reader(),
    ])
    const reports = new Map(
      transcript.flatMap((msg) =>
        msg.parts.flatMap((p) =>
          p.type === "text" && p.backgroundSubagentResult
            ? [
                [
                  p.backgroundSubagentResult.subagentId,
                  { status: p.backgroundSubagentResult.status, at: msg.info.time.created },
                ] as const,
              ]
            : [],
        ),
      ),
    )
    const rows = await Promise.all(
      children.map(async (child): Promise<Subagent> => {
        const debt = await Debt.get(child.id)
        const report = reports.get(child.id)
        // The children list comes from an in-memory index a write in another
        // process does not refresh; the state reads the row itself.
        const status: Subagent["status"] = debt
          ? await state((await find(child.id)) ?? child, read)
          : report && report.status !== "cancelled"
            ? report.status
            : "stopped"
        const base: Subagent = {
          id: child.id,
          parentSessionID: parentID,
          status,
          description: description(child),
          agent: child.current?.agent ?? MessageV2.UNKNOWN_AGENT,
          time: {
            created: debt?.created ?? child.time.created,
            ...(debt ? {} : { completed: report?.at ?? child.time.updated }),
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

  // The first pass this process runs under the lease removes the headless
  // runs a restart cut. Each step re-takes the lease, which is also its
  // heartbeat, so a long pass cannot outlive it unnoticed.
  async function pass() {
    if (!(await lease())) return
    if (!booted) {
      const { HeadlessAgent } = await import("./headless")
      await HeadlessAgent.sweep(boot * 1000)
      booted = true
    }
    await arm()
    for (const session of await Sessions.listTurning()) if (await lease()) await within(session, () => resume(session))
    for (const debt of await Debt.list()) if (await lease()) await pay(debt)
    const read = await Messages.reader()
    for (const session of await Sessions.listUnanswered(Date.now() - SETTLE_MS)) {
      // The first unanswered message since the last stop: an older one an
      // Esc left behind would otherwise stand in for it and read as stopped.
      const waiting = read.pending(session.id, session.time.stopped)
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

  // Pay what one session is owed, and what it owes, without waiting for a
  // leased pass. Every payment is claimed inside its delivery transaction, so
  // it runs without the lease, even inside the boot grace. Called when a turn
  // ends and when a job exits. `fresh` is for a caller that has just written
  // a fact (a turn ended, a job exited): an attempt already in flight judged
  // state from before it, so a new one runs after it.
  export async function collect(sessionID: string, options: { wake?: boolean; fresh?: boolean } = {}) {
    for (const debt of await Debt.owed(sessionID)) await pay(debt, options)
    const own = await Debt.get(sessionID)
    if (own) await pay(own, { fresh: options.fresh, wake: options.wake })
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
    const stopped = (session.time.stopped ?? 0) >= turn.at
    const resumes = turn.resumes ?? 0
    const quit = stopped || resumes >= CAP
    const next = quit ? undefined : { at: turn.at, pid: process.pid, boot, nonce: turn.nonce, resumes: resumes + 1 }
    // Claimed against the marker read at the start of the pass: a turn that
    // started since (its own marker) is live and is left alone.
    const mutate = await Sessions.mutator()
    const claimed = await Db.transaction(
      () =>
        !!mutate(session.id, (draft) => {
          if (draft.turn?.at !== turn.at || draft.turn.pid !== turn.pid || draft.turn.nonce !== turn.nonce) return false
          draft.turn = next
          // A subagent that gives up has reported failed, so it ends the way
          // an interrupt does and the sweep of unanswered messages does not
          // start the turn the cap just refused. A root is only unmarked:
          // it stays live, so a result still owed to it wakes it as usual.
          if (quit && !stopped && session.parentID) draft.time.stopped = Date.now()
          return true
        }),
    )
    if (!claimed) return
    await Session.reload(session.id).catch((error) =>
      log.error("could not reload a claimed cut turn", { sessionID: session.id, error }),
    )
    if (quit) {
      log.info("leaving a cut turn", { sessionID: session.id, stopped, resumes })
      // Reported only once nothing else will: a turn running here (a steer)
      // or a debt of its own still open, whose result starts the turn whose
      // end reports.
      const debt = await Debt.get(session.id)
      if (!stopped && debt?.kind === "subagent" && !SessionBusy.busy(session.id) && !(await Debt.owing(session.id)))
        await pay(debt, { forced: { status: "failed", output: `could not resume after ${resumes} attempts` } })
      return
    }
    // This process's marker, left by a resume that will not run a turn.
    const clear = () =>
      Session.mark(session.id, (draft) => {
        if (draft.turn?.pid === process.pid && draft.turn.at === turn.at) draft.turn = undefined
      })
    const waiting = session.parentID
      ? 0
      : (await Debt.owed(session.id)).filter((debt) => debt.kind === "subagent").length
    log.info("resuming a cut turn", { sessionID: session.id, attempt: resumes + 1 })
    // A resume that never reached a turn of its own leaves this process's
    // marker on the session, which reads as alive forever. Marking it dead has
    // the next pass count it against the cap.
    const unmark = (error: unknown) => {
      log.error("resume failed", { sessionID: session.id, error })
      return Session.mark(session.id, (draft) => {
        if (draft.turn?.pid === process.pid && draft.turn.at === turn.at) draft.turn.boot = 0
      }).catch((failure) => log.error("could not mark a failed resume", { sessionID: session.id, error: failure }))
    }
    const sessions = await Sessions.reader()
    void SessionPrompt.deliver({
      sessionID: session.id,
      parts: [
        {
          type: "text",
          text: session.parentID ? SUBAGENT_RESUME_TEXT : resumeText(waiting),
          synthetic: true,
        },
      ],
      model: Provider.INHERIT,
      variant: Provider.INHERIT,
      join: true,
      // Still this resume's marker, and no stop since the turn started: a stop
      // that landed after the claim above wins over the resume.
      claim: () => {
        const current = sessions(session.id)
        const marker = current?.turn
        const mine = marker?.pid === process.pid && marker.at === turn.at && marker.nonce === turn.nonce
        return mine && (current?.time.stopped ?? 0) < turn.at
      },
      failed: unmark,
    })
      .then(async (message) => {
        if (message) return
        log.info("a cut turn's resume lost its claim", { sessionID: session.id })
        await clear()
      })
      .catch(unmark)
  }

  // ---- arming ------------------------------------------------------------

  // Re-arm keep-warm pings on root sessions whose cache is still warm and that
  // no daemon in this process keeps, on every pass rather than only the first:
  // a cache still warm at any pass is one worth keeping. `keepWarm` is the
  // intent: a Stop clears it, and an Esc leaves it, so an interrupted session is
  // re-armed like any other.
  async function arm() {
    for (const session of await Sessions.listWarm(Date.now() - CACHE_TTL))
      if (!SessionPing.running(session.id)) await within(session, async () => SessionPing.start(session.id))
  }

  // ---- lifecycle ---------------------------------------------------------

  // `serve` passes `live` when the supervisor runs it as its live server. A
  // live server needs no grace: the supervisor marks only the server it keeps,
  // never one it stages, so it acts at once and a restart costs no minute of
  // waiting.
  export function init(options: { live?: boolean } = {}) {
    SessionBusy.onIdle(() => void poke())
    Scheduler.register({ id: "recovery", interval: SWEEP_MS, scope: "global", run: () => poke() })
    setTimeout(
      () => {
        start()
        void poke()
      },
      options.live ? 0 : GRACE_MS,
    ).unref()
  }
}
