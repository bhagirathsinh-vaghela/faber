import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { swap } from "../util/text"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { OpenProjects } from "../project/open"
import { Global } from "../global"
import { Bus } from "../bus"
import { STOPPED as Stopped } from "../util/abort"
import { BusEvent } from "../bus/bus-event"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import PROMPT_PLAN_SPARSE from "../session/prompt/plan-sparse.txt"
import PROMPT_PLAN_REENTRY from "../session/prompt/plan-reentry.txt"
import PROMPT_PLAN_SUBAGENT from "../session/prompt/plan-subagent.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import SUBAGENT from "../session/prompt/subagent.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { McpCatalog } from "../mcp/catalog"
import { AgentCatalog } from "../agent/catalog"
import { Skill } from "../skill"
import { current as currentSkillBody } from "../tool/skill"
import { Coverage } from "./coverage"
import { Config } from "../config/config"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $, fileURLToPath } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { Wildcard } from "../util/wildcard"
import { Filesystem } from "../util/filesystem"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { AgentTool } from "@/tool/agent"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { SessionStatus } from "./status"
import { SessionBusy } from "./busy"
import { LLM } from "./llm"
import { SessionPing } from "./ping"
import { Recovery } from "./recovery"
import { SessionPin } from "./pin"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import { Image } from "@/image/image"
import { Db } from "@/storage/db"
import { Messages } from "@/storage/messages"
import { Parts } from "@/storage/parts"
import { Sessions } from "@/storage/sessions"
import { Debt } from "@/storage/debt"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  const DISPOSED = "instance disposed"
  // A stopped turn's end pays nothing: the Stop pays the session itself.
  export const STOPPED = Stopped

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        // Named, so the turn's marker is left dead rather than cleared: the
        // instance going away cut the turn, and recovery resumes it.
        item.abort.abort(DISPOSED)
        for (const callback of item.callbacks) {
          callback.reject(new DOMException("Aborted", "AbortError"))
        }
      }
    },
  )

  // Each in-flight turn's parameters, claimed synchronously by its opener before
  // the opener's first await. A prompt that joins a running turn adopts these
  // instead of resolving its own, so one turn runs under one parameter set. The
  // slot is a Promise so a join arriving while the opener is still resolving
  // waits for it rather than racing to resolve in parallel. It settles
  // undefined when the opener wrote nothing, and the joiner resolves its own.
  const turnParams = Instance.state(() => new Map<string, Promise<ReturnType<typeof MessageV2.inherit> | undefined>>())

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubagentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubagentPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  // A launch inside the server, where the model and variant are always stated:
  // a concrete pick, "inherit" (the session's current), or "default" (the
  // agent's, then the config's). The literals stand in for Provider.INHERIT and
  // Provider.DEFAULT, which cannot be read at module load without a cycle.
  export const Launch = PromptInput.extend({
    model: z.union([PromptInput.shape.model.unwrap(), z.literal("inherit"), z.literal("default")]),
    variant: z.string(),
  })
  export type Launch = z.infer<typeof Launch>
  export type Choice = Launch["model"]

  export const prompt = fn(Launch, (input) => send(input).then((sent) => sent.answer))

  // What createUserMessage writes: a prompt, or a loop-minted compaction
  // request, whose part no client may send.
  type Draft = Omit<Launch, "parts"> & {
    parts: (PromptInput["parts"][number] | { type: "compaction"; auto: boolean })[]
  }

  // Only a delivery's claim can come back empty, so a prompt always has its
  // message.
  function settled(message: MessageV2.WithParts | undefined) {
    if (!message) throw new Error("a prompt with no claim wrote no message")
    return message
  }

  // Run inside the transaction that writes the message; false writes nothing.
  // How a delivery pays a debt exactly once, and how a launch records one in
  // the same write as its prompt.
  export type Claim = (message: MessageV2.User) => boolean

  // What the infrastructure sends a session (a job or subagent result, a
  // check-in, a continue after a restart) goes the way a typed prompt does, so
  // it is ordered against everything else arriving and answered by the turn it
  // starts or joins. `claim` pays for the message inside the transaction that
  // writes it; `failed` hears a turn it started that throws, since that turn
  // runs detached. `wake: false` writes the message and leaves the turn to a
  // caller that is about to start one. `join` marks a message the loop
  // minted: it may join a subagent's open debt but never opens one, and never
  // counts as a prompt or moves the session's parameters. `params`
  // wins even over a running turn's parameters (a plan switch names its
  // agent). Returns the message, or undefined when the claim was lost.
  export async function deliver(input: {
    sessionID: string
    parts: Draft["parts"]
    claim?: Claim
    failed?: (error: unknown) => unknown
    wake?: boolean
    join?: boolean
    model: Choice
    variant: string
    params?: { agent?: string }
    system?: Draft["system"]
    tools?: Draft["tools"]
  }) {
    return run(
      {
        sessionID: input.sessionID,
        parts: input.parts,
        noReply: input.wake === false,
        agent: input.params?.agent,
        model: input.model,
        variant: input.variant,
        system: input.system,
        tools: input.tools,
      },
      undefined,
      {
        claim: input.claim,
        join: input.join,
        params: input.params,
        detach: input.failed ?? ((error) => log.error("delivered turn failed", { sessionID: input.sessionID, error })),
      },
    )
  }

  // The one writer of a question once it is answered or goes unanswered: the
  // tool part is
  // replaced, under its own id, by an empty text record, and the question with
  // its answer is written as the user's message in the same transaction. Both
  // carry the question so the transcript still draws its card. It only appends
  // after what a keep-warm ping may have cached. `halted` is a question a
  // Stop or Esc ended: the stop is moved past its note, so nothing resumes or
  // wakes on it. Nothing is written once a message other than an answer follows
  // the question's step (a prompt sent after an Esc, a result that joined):
  // the note would read as the reply to it. Returns the message, or undefined
  // when nothing was written.
  export async function transcribe(input: {
    part: MessageV2.ToolPart
    opener: MessageV2.User
    answers?: string[][]
    reason?: string
    halted?: boolean
  }) {
    const asked = input.part.state.input.questions as (Question.Info & MessageV2.QuestionRecord["questions"][number])[]
    const questions = asked.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
      ...(q.multiple !== undefined && { multiple: q.multiple }),
    }))
    const reason = input.reason ?? "it was withdrawn"
    const record: MessageV2.QuestionRecord = {
      callID: input.part.callID,
      questions,
      ...(input.answers ? { answers: input.answers } : { error: reason }),
    }
    const replaced: MessageV2.TextPart = {
      id: input.part.id,
      messageID: input.part.messageID,
      sessionID: input.part.sessionID,
      type: "text",
      text: "",
      synthetic: true,
      question: record,
    }
    const write = await Parts.writer()
    const read = await Messages.reader()
    const parts = await Parts.reader()
    const sent = await deliver({
      sessionID: input.part.sessionID,
      parts: [
        {
          type: "text",
          text: MessageV2.record(questions, input.answers ? { answers: input.answers } : { reason }),
          question: record,
        },
      ],
      // Read from the step's parent (the opener), not the step: a message the
      // step never saw can sort before it, its id minted before the step's.
      claim: () => {
        const later = read
          .after(input.part.sessionID, input.opener.id)
          .filter(
            (info) =>
              info.id !== input.opener.id && info.role === "user" && !MessageV2.reply({ info, parts: parts(info.id) }),
          )
        if (later.length > 0) return false
        write(replaced)
        return true
      },
      model: Provider.INHERIT,
      variant: Provider.INHERIT,
      params: MessageV2.inherit(input.opener),
      // The rest of the turn reads the answer as its newest user message, so it
      // carries the opener's own system text and tool switches.
      system: input.opener.system,
      tools: input.opener.tools,
      join: true,
      wake: false,
    }).then(
      (message) => ({ message }),
      (error: unknown) => ({ error }),
    )
    // A throw after the write committed (a plugin hook) still wrote the note:
    // it is read back so the part is published and the stop moved past it, and
    // then the throw goes on to the caller.
    const note =
      "message" in sent
        ? sent.message?.info
        : read
            .after(input.part.sessionID, input.opener.id)
            .find(
              (info) =>
                info.role === "user" &&
                parts(info.id).some((p) => p.type === "text" && p.question?.callID === record.callID),
            )
    if (note) Session.publishPart(replaced)
    if (note && input.halted)
      await Session.update(
        input.part.sessionID,
        (draft) => void (draft.time.stopped = Math.max(draft.time.stopped ?? 0, note.time.created)),
        { touch: false },
      )
    if ("error" in sent) throw sent.error
    return sent.message
  }

  // Write `input` and run its turn, resolving once the message is durable,
  // with the written message and the turn's pending answer. A turn that fails
  // reports through Recovery.fail when the session is a subagent, the same way
  // however the message arrived.
  export async function send(input: Launch) {
    const persisted = Promise.withResolvers<Written>()
    let written: Written | undefined
    const answer = run(input, (message) => {
      written = message
      persisted.resolve(message)
    })
      .then(settled)
      .catch(async (error) => {
        if (error === STOPPED) throw error
        log.error("prompt failed", { sessionID: input.sessionID, error })
        if (written)
          await Recovery.fail(
            input.sessionID,
            error instanceof Error ? error.message : String(error),
            written.info.time.created,
          ).catch((failure) => log.error("could not report a failed prompt", { sessionID: input.sessionID, failure }))
        throw error
      })
    const message = await Promise.race([persisted.promise, answer.then(() => persisted.promise)])
    return { message, answer }
  }

  // A written user message, and for one into a subagent whether it opened the
  // child's debt or joined the one still open.
  export type Written = NonNullable<Awaited<ReturnType<typeof createUserMessage>>>

  async function run(
    input: Draft,
    onPersisted?: (message: Written) => void | Promise<void>,
    internal?: Omit<Minted, "joined"> & { detach?: (error: unknown) => unknown },
  ) {
    // Claim the turn's parameters synchronously, before the first await, so two
    // prompts racing on an idle session cannot both resolve their own: the first
    // installs the slot, the second sees it and joins. The opener resolves the
    // slot once its message is built; a join awaits that. noReply writes a
    // message without running a turn, so it never claims.
    const claimed = !input.noReply && !turnParams().has(input.sessionID)
    const slot = Promise.withResolvers<ReturnType<typeof MessageV2.inherit> | undefined>()
    if (claimed) turnParams().set(input.sessionID, slot.promise)
    const joinedParams = !claimed ? turnParams().get(input.sessionID) : undefined
    const unclaim = input.noReply ? () => {} : SessionBusy.claim(input.sessionID)
    // An opener that ends without a message (a lost claim, a throw) settles the
    // slot empty and frees it, so a prompt that joined meanwhile resolves its
    // own parameters instead of waiting forever.
    const release = () => {
      unclaim()
      if (!claimed) return
      slot.resolve(undefined)
      if (turnParams().get(input.sessionID) === slot.promise) turnParams().delete(input.sessionID)
    }
    return open().then(
      (message) => {
        if (!message) release()
        return message
      },
      (error) => {
        release()
        throw error
      },
    )

    async function open() {
      // The cache-ping daemon stays ARMED across the turn — we do NOT stop it here.
      // A turn that keeps dispatching model requests inside CACHE_TTL re-anchors the
      // cache faster than the daemon's scheduled ping, so evaluate() naturally keeps
      // the daemon quiet (its ping target slides past every dispatch). The daemon
      // only fires when a turn STALLS with no dispatch for longer than
      // CACHE_TTL - beforeExpiry — a blocking question, a long-running tool, or a
      // single slow model step — which is exactly the gap that used to let the cache
      // die mid-turn (footer "--" then a cache miss on resume). Keeping it armed
      // makes that stall self-heal. Any brief ping/turn overlap is safe: the cache
      // prefix is read-only shared state and lastRequestAt is last-writer-wins.
      const session = await Session.get(input.sessionID)
      // Adopt before any pin read (createUserMessage pins otherwise): a child
      // must share its parent's snapshot, not the current generation.
      if (session.parentID) SessionPin.adopt(session.id, session.parentID)

      const message = await createUserMessage(input, { ...internal, joined: joinedParams })
      if (!message) return undefined
      const params = MessageV2.inherit(message.info as MessageV2.User)
      slot.resolve(params)
      // Parameters that win over the running turn's (a plan switch) become the
      // turn's own, or the next result to join would adopt the agent switched
      // from. Only the turn this message joined: if that turn ended while it was
      // written, the slot is gone or a newer turn's.
      if (!claimed && internal?.params && joinedParams && turnParams().get(input.sessionID) === joinedParams)
        turnParams().set(input.sessionID, Promise.resolve(params))
      // Arm the daemon at turn START, not just the tail. Sending a prompt is the
      // intended "keep this session" action, so it arms now — one lever (start()
      // arms and sets keepWarm as its shadow). This costs no ping: a busy turn
      // re-anchors the cache on every dispatch, sliding pingAt past now so the
      // armed daemon stays quiet; it fires ONLY if the turn stalls past a cache
      // window, which is exactly the mid-turn gap we want it to catch. The upshot
      // is the session reads warm the whole time it is busy, and a client that
      // Stopped it can't leave it cold once real work resumes. A delivered result
      // arms it the same way: the turn it starts warms the cache as any other does.
      // A write that starts no turn (noReply: a Stop's notices, a payment into an
      // archived session, compaction's writes) never arms: it would re-warm a
      // session its Stop just disarmed.
      if (Session.attended(session) && input.noReply !== true) SessionPing.start(session.id)
      // Reset ping telemetry ({ count, time, pending }) for the new turn's display.
      // This is display state only (statusline's "N× pinged" / in-flight indicator);
      // it does not touch cache.lastRequestAt, so it never affects the cache clock.
      if (session.ping && claimed) {
        await Session.update(input.sessionID, (draft) => {
          draft.ping = undefined
        })
      }

      await Session.touch(input.sessionID)

      // this is backwards compatibility for allowing `tools` to be specified when
      // prompting
      const permissions: PermissionNext.Ruleset = []
      for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({
          permission: tool,
          action: enabled ? "allow" : "deny",
          pattern: "*",
        })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        await Session.update(session.id, (draft) => {
          draft.permission = permissions
        })
      }

      if (input.noReply === true) {
        await onPersisted?.(message)
        return message
      }

      // Started before the caller hears the message is written: `answer`
      // claims the turn synchronously, so a cancel issued once `send` resolves
      // reaches the turn instead of landing before it exists.
      const turn = answer(input.sessionID, message.info as MessageV2.User).finally(unclaim)
      await onPersisted?.(message)
      if (internal?.detach) {
        void turn.catch(internal.detach)
        return message
      }
      return turn
    }
  }

  // `loop` joins a turn still unwinding and returns that turn's answer, which
  // never read a message written after its last look at the history. So a send
  // asks again while a user message is still waiting (Messages.reader), unless
  // a stop has landed since it was written. A turn it joined that ends
  // aborted without a stop (a shell command's) answers nothing, so that is
  // asked again too.
  async function answer(sessionID: string, sent: MessageV2.User) {
    const reading = Messages.reader()
    // A session that cannot be read reads as stopped forever.
    const stopped = () =>
      Sessions.read(sessionID).then(
        (session) => session.time.stopped ?? 0,
        () => Infinity,
      )
    const unstopped = async () => (await stopped()) < sent.time.created
    for (let attempt = 1; ; attempt++) {
      const running = loop(sessionID)
      // Read after `loop` claims or joins: the controller of the turn this
      // attempt waits on.
      const signal = state()[sessionID]?.abort.signal
      // A stopped turn ends however it ends (a turn cut before its first step
      // throws), and reports as STOPPED so no caller reads it as a failure.
      const last = await running.catch(async (error) => {
        if (signal?.reason === STOPPED) throw STOPPED
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error
        if (attempt >= 3 || !(await unstopped())) throw error
        return undefined
      })
      if (!last) continue
      if (attempt >= 3 || signal?.reason === STOPPED || !(await reading).waiting(sessionID, await stopped()))
        return last
      if (!(await unstopped())) return last
    }
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: `file://${filepath}`,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  // Post-op file stamps a completed tool part contributes to FileTime.seed.
  // Two shapes exist because one filePath cannot describe a patch: single-file
  // tools stamp their own input path, while apply_patch persists a `stamps` list
  // covering every file it touched. A tool that writes files without emitting
  // one of these shapes is invisible to seed, so the next turn asks the model to
  // re-read a file it just wrote.
  export function fileStamps(part: MessageV2.Part) {
    if (part.type !== "tool" || part.state.status !== "completed") return []
    const meta = part.state.metadata
    if (Array.isArray(meta?.stamps))
      return meta.stamps.flatMap((stamp: { file?: unknown; mtime?: unknown; hash?: unknown }) =>
        typeof stamp?.file === "string" && typeof stamp.mtime === "number"
          ? [
              {
                file: Filesystem.resolve(Instance.directory, stamp.file),
                mtime: stamp.mtime,
                hash: typeof stamp.hash === "string" ? stamp.hash : undefined,
              },
            ]
          : [],
      )
    if (typeof part.state.input?.filePath !== "string" || typeof meta?.mtime !== "number") return []
    return [
      {
        file: Filesystem.resolve(Instance.directory, part.state.input.filePath),
        mtime: meta.mtime,
        hash: typeof meta.hash === "string" ? meta.hash : undefined,
        offset: typeof meta.offset === "number" ? meta.offset : undefined,
        limit: typeof meta.limit === "number" ? meta.limit : undefined,
      },
    ]
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  // `own` is the handle of the turn ending itself. An Esc cancels that turn
  // before its loop unwinds, and a prompt sent in between may hold the session
  // by the time it does: a newer handle, or a claimed turn whose loop has not
  // started. Neither is this turn's to drop.
  export function cancel(sessionID: string, reason?: typeof STOPPED, own?: AbortController) {
    log.info("cancel", { sessionID, stopped: reason === STOPPED })
    const s = state()
    const match = s[sessionID]
    if (own && match && match.abort !== own) return
    // The turn is over, so its parameter claim must go too — otherwise the next
    // fresh turn on this session would adopt the finished turn's parameters as a
    // phantom join. A turn whose handle is already gone had its claim dropped
    // with it; any claim now is a newer turn's.
    if (!own || match) turnParams().delete(sessionID)
    // Both branches drop the session's open prompts. A prompt outlives the tool
    // call that raised it only as a dot nobody can answer, and the no-match
    // branch is reached with one still open: a session waiting on a permission
    // is not in-flight by the time a Stop arrives.
    void Question.clear(sessionID)
    void PermissionNext.clear(sessionID)
    if (!match) {
      // Disarming is never inferred from the absence of a handle: this branch
      // cannot tell an idle session apart from a turn whose handle a prior
      // cancel() already dropped, and every aborted turn reaches here twice
      // (route, then the loop's defer). Callers that mean "disarm" — /abort,
      // ping/stop, session delete — call SessionPing.stop themselves.
      SessionBusy.exit(sessionID)
      SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    match.abort.abort(reason)
    for (const item of match.callbacks) {
      item.reject(new DOMException("Aborted", "AbortError"))
    }
    delete s[sessionID]
    // The in-flight handle is gone — clear the turn flag and the retry detail.
    SessionBusy.exit(sessionID)
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    const abort = start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    // Each ended turn is announced once, so the client plays one sound: idle
    // for a finish, the error for a failure or an Esc. The processor announces
    // an error raised while it runs; an Esc that lands between steps never
    // reaches it and is announced here. A finish is announced by SessionBusy
    // once no subagent or job is still owed, so it is the session going quiet
    // rather than this turn ending. A Stop ends the session rather than a
    // turn anyone waits on, and a dispose hands the turn to the next server to
    // resume, so neither is announced. Declared first, so it runs last, once
    // the turn is fully over.
    let failed = false
    let interrupted = false
    using _announce = defer(() => {
      SessionBusy.forget(sessionID)
      if (abort.reason === DISPOSED || abort.reason === STOPPED || failed) return
      if (interrupted)
        return void Bus.publish(Session.Event.Error, {
          sessionID,
          error: new MessageV2.AbortedError({ message: "interrupted" }).toObject(),
        })
      SessionBusy.finish(sessionID)
    })
    // Declared before the cancel below, so it runs after it: once the turn is
    // over here, whatever the session is owed is paid by this process, even
    // one that never holds the lease. A turn its instance's dispose cut is the
    // next server's, and nothing is opened for a directory going away. A
    // stopped turn's debts are the Stop's to pay.
    using _collect = defer(() => {
      if (abort.reason === DISPOSED || abort.reason === STOPPED) return
      void Recovery.collect(sessionID, { fresh: true }).catch((error) =>
        log.error("could not collect", { sessionID, error }),
      )
    })
    const own = state()[sessionID].abort
    using _ = defer(() => cancel(sessionID, undefined, own))

    let step = 0
    const session = await Session.get(sessionID)
    // Pin prompt-shaping state on the first turn after boot; child sessions
    // inherit the parent's pin so a config refresh mid-task can't split them.
    if (session.parentID) SessionPin.adopt(sessionID, session.parentID)
    // The in-flight handle now exists. Paired with the defer(cancel) above,
    // which calls SessionBusy.exit on every loop exit.
    SessionBusy.enter(sessionID)
    // Disposed before the cancel above (reverse declaration order), so the
    // marker is gone by the time the busy-exit edge wakes recovery. A marker
    // left behind means this process died holding the turn.
    const marker = { at: Date.now(), pid: process.pid, boot: Recovery.boot, nonce: ulid() }
    await Session.mark(sessionID, (draft) => {
      draft.turn = { ...marker, resumes: draft.turn?.resumes }
    })
    // Cleared only while it is still this turn's: a prompt sent right after an
    // interrupt starts the next turn before this one finishes unwinding. A turn
    // its instance cut is marked dead instead, which recovery resumes.
    await using _turn = {
      [Symbol.asyncDispose]: () =>
        Session.mark(sessionID, (draft) => {
          if (draft.turn?.nonce !== marker.nonce || draft.turn.pid !== marker.pid) return
          if (abort.reason === DISPOSED) draft.turn.boot = 0
          else draft.turn = undefined
        }).then(
          () => {},
          (error) => log.error("could not clear the turn marker", { sessionID, error }),
        ),
    }
    const snapshot = await SessionPin.get(sessionID)
    while (true) {
      log.info("loop", { step, sessionID })
      if (abort.aborted) {
        interrupted = true
        break
      }
      const loadTimer = log.time("messages.load")
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      loadTimer.stop()
      log.info("messages.load count", { count: msgs.length })

      // Raise the ID floor to this session's newest message before minting any
      // new ids this turn. filterCompacted always keeps the tail, so the max id
      // here is the session's true newest. This stops a process whose wall clock
      // is behind the persisted ids (a backward step while the server was down)
      // from minting an assistant/part that sorts before its own parent — the
      // inversion that wedged the turn loop. Complements the link-based checks:
      // those survive an existing inversion, this prevents new ones.
      for (const msg of msgs) Identifier.seed(msg.info.id)

      // Rebuild the read-time map from durable history. Every tool that reads or
      // writes a file persists its post-op mtime+hash, so a file's entry reflects
      // the most recent access. That means a server restart restores prior reads
      // (no false "read it first" on edit), a compacted-away read is dropped so
      // the next Read returns real content instead of an unchanged stub, AND a
      // write in a prior turn carries its post-write mtime+hash forward instead
      // of the stale pre-write read state (which would make the guard fire on the
      // file this session just wrote).
      FileTime.seed(
        sessionID,
        msgs.flatMap((msg) => msg.parts.flatMap(fileStamps)),
      )

      // A compaction or subagent part is satisfied when a finished assistant
      // message links back to the message that holds it (both branches set the
      // assistant's parentID to that message's id). Keying "done" on this link
      // instead of on sort position makes it immune to ID inversion: a mis-timed
      // clock can reorder the summary before its own request, but the parentID
      // pointer is unchanged, so a completed task can never look pending again.
      const satisfied = new Set(
        msgs.flatMap((msg) => (msg.info.role === "assistant" && msg.info.finish ? [msg.info.parentID] : [])),
      )

      let lastUser: MessageV2.User | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubagentPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        if (satisfied.has(msg.info.id)) continue
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subagent")
        tasks.push(...task)
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      if (MessageV2.answered(msgs, lastUser.id)) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      // pending subagent
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subagent") {
        const taskTool = await AgentTool.init()
        const subagentModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: subagentModel.id,
          providerID: subagentModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        // Internal subagent path (no LLM to pick a toolset): map the agent name
        // to a built-in toolset, defaulting to "general" (full tools) for
        // custom agents, which preserves their pre-toolset unrestricted access.
        const toolsets = await Agent.toolsets()
        const toolset = toolsets[task.agent] ? task.agent : "general"
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: AgentTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              toolset,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          toolset,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "agent",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          async metadata(input) {
            await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subagent execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "agent",
            sessionID,
            callID: part.id,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments: result.attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          await deliver({
            sessionID,
            parts: [
              {
                type: "text",
                text: "Summarize the agent tool output above and continue with your task.",
                synthetic: true,
                internal: true,
              },
            ],
            model: Provider.INHERIT,
            variant: Provider.INHERIT,
            params: MessageV2.inherit(lastUser),
            join: true,
            wake: false,
          })
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const compaction = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
        })
        if (compaction === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (lastFinished && (await SessionCompaction.isOverflow({ message: lastFinished, model }))) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await resolveAgent(lastUser.agent, snapshot)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
        model,
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
        // Only a person's answer, dismissal, Esc or Stop is written down. A
        // server going away, or a turn ending on its own error, writes nothing:
        // a note would start another turn at once, beside a step the next
        // request leaves out, and the restart's resume says the question is gone.
        question: async (part, outcome) => {
          if ("withdrawn" in outcome && (abort.reason === DISPOSED || !abort.aborted)) return false
          const written = await transcribe({
            part,
            opener: lastUser,
            ...("answers" in outcome && { answers: outcome.answers }),
            ...("dismissed" in outcome && { reason: "the user dismissed it" }),
            ...("withdrawn" in outcome && { reason: "the turn was stopped", halted: true }),
          })
          return !!written
        },
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn. A
      // question's answer carries no agent part and is skipped.
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user" && !MessageV2.reply(m))
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
        snapshot,
      })

      if (step === 1 && !session.ephemeral) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      const sessionMessages = clone(msgs)

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

      const instructions = snapshot.instructions
      // Read one-shot cache probe (index or message ID) and clear immediately
      const probeSession = await Session.get(sessionID)
      const cacheProbeIndex = probeSession?.cacheProbeIndex
      const cacheProbeMessageID = probeSession?.cacheProbeMessageID
      if (cacheProbeIndex !== undefined || cacheProbeMessageID !== undefined) {
        await Session.update(sessionID, (draft) => {
          draft.cacheProbeIndex = undefined
          draft.cacheProbeMessageID = undefined
        })
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system: {
          env: SystemPrompt.environment(),
          globalInstructions: session.bare ? [] : instructions.global,
          projectInstructions: session.bare ? [] : instructions.project,
          sessionContext: SystemPrompt.sessionContext({
            created: session.time.created,
            branch: session.branch,
          }),
        },
        ...(() => {
          const { messages, idToIndex } = MessageV2.toModelMessages(sessionMessages, model)
          return {
            messages: [
              ...messages,
              ...(isLastStep
                ? [
                    {
                      role: "assistant" as const,
                      content: MAX_STEPS,
                    },
                  ]
                : []),
            ],
            messageIdToIndex: idToIndex,
          }
        })(),
        sessionMessages,
        assistantMessage: processor.message,
        persistPromptIndex: true,
        tools,
        model,
        cacheProbeIndex,
        cacheProbeMessageID,
      })
      if (processor.message.error) failed = true
      if (processor.message.finish && (await Session.get(sessionID)).turn?.resumes)
        await Session.mark(sessionID, (draft) => void (draft.turn && (draft.turn.resumes = 0)))
      if (result === "stop") break
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          auto: true,
        })
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    if (Session.attended(session)) {
      // The daemon is already armed from turn start. On a clean finish leave it
      // armed (re-assert is a no-op) and mark unread. An aborted turn is torn
      // down elsewhere: a user Stop goes through the /abort route (stops the
      // daemon), and a superseding prompt re-arms via its own start(). So the
      // only thing the tail owns is markUnseen on completion.
      if (!abort.aborted) Session.markUnseen(sessionID)
      void OpenProjects.open({ id: Instance.project.id, worktree: Instance.worktree })
    }
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  // Tools that carry a file path we can scope against (the edit family).
  const PATH_SCOPED_TOOLS = ["edit", "write", "multiedit"]

  // Plan mode allowlist: every registered tool stays available (so the request
  // schema is identical to a build turn and the prompt cache survives the
  // plan<->build switch), but the edit-family tools are scoped to the plan files.
  // This replaces the old plan-agent edit permission deny, which routed through
  // PermissionNext.disabled and could strip edit tools from the wire.
  function planAllowlist(toolIds: string[]): Session.AllowedTool[] {
    const planPaths = [
      path.join(".opencode", "plans", "*.md"),
      path.relative(Instance.worktree, path.join(Global.Path.data, "plans", "*.md")),
      path.join(Global.Path.data, "plans", "*.md"),
    ]
    return toolIds.map((id) => (PATH_SCOPED_TOOLS.includes(id) ? { id, paths: planPaths } : id))
  }

  // Runtime gate for the allowedTools allowlist. Returns a denial message when
  // the tool call is not allowed, or undefined when it is. allowedTools never
  // removes a tool from the request schema (that would change the prompt-cache
  // prefix); the gate runs here at execution time instead.
  //   - allowedTools undefined        -> all tools allowed (normal sessions)
  //   - id absent from the list       -> denied
  //   - id present as a bare string   -> allowed, any arguments
  //   - id present as { id, paths }   -> allowed only when args.filePath
  //                                      matches a glob in paths
  //
  // `mcp` is passed ONLY when the caller is the MCP tool loop, marking `id` as a
  // dynamic MCP tool key whose grant may come from a class sentinel rather than
  // an exact-id match: Agent.MCP_WRITE grants any MCP tool, Agent.MCP_READ
  // grants one only when `mcp.readOnly` is true. Native tools pass no `mcp`, so
  // the sentinels are inert for them (a native id never equals a sentinel).
  export function toolDenial(
    allowed: Session.AllowedTool[] | undefined,
    id: string,
    args: any,
    mcp?: { readOnly: boolean },
  ): string | undefined {
    if (!allowed) return undefined
    if (mcp) {
      if (allowed.includes(Agent.MCP_WRITE)) return undefined
      if (mcp.readOnly && allowed.includes(Agent.MCP_READ)) return undefined
    }
    const entry = allowed.find((t) => (typeof t === "string" ? t === id : t.id === id))
    if (!entry) {
      const names = allowed.map((t) => (typeof t === "string" ? t : t.id))
      return `Tool "${id}" is not available for this task. Available tools: ${names.join(", ")}`
    }
    if (typeof entry === "string") return undefined
    if (!PATH_SCOPED_TOOLS.includes(id)) return undefined
    const filePath = args?.filePath
    if (typeof filePath !== "string") return `Tool "${id}" requires a file path for this task.`
    const target = path.isAbsolute(filePath) ? path.relative(Instance.worktree, filePath) : filePath
    if (entry.paths.some((p) => Wildcard.match(target, p) || Wildcard.match(filePath, p))) return undefined
    return `Tool "${id}" is restricted to ${entry.paths.join(", ")} for this task. "${filePath}" is not allowed.`
  }

  // Per-session MCP latch, enforced at execute time so tools[] stays
  // byte-identical whether or not a tool is disabled (gating via the wire would
  // churn the cache). MCP is always on; mcp_search is always available. An
  // individual MCP server tool is denied here iff its native name is in the
  // owning server's `disabled` config — the execution counterpart to corpus()
  // hiding it from the catalog. Returns a denial message the model can read, or
  // undefined when the tool is allowed.
  async function mcpDenied(id: string): Promise<string | undefined> {
    if (await MCP.isDisabled(id)) return `The "${id}" tool is disabled by configuration and cannot be used.`
    return undefined
  }

  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
    snapshot?: SessionPin.Snapshot
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: any; delta?: string }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          const part = {
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running" as const,
              input: args,
              time: {
                start: Date.now(),
              },
            },
          }
          // A tool that streams its output (bash, per chunk) passes the new chunk
          // as `delta`, so the wire blanks state.metadata.output and the client
          // appends. Without a delta the full part ships (seed + heal).
          await Session.updatePart(val.delta !== undefined ? { part, delta: val.delta } : part)
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    const registered = await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
      input.snapshot,
    )
    // Effective allowlist: an explicit session allowlist (subagent/compaction)
    // wins; otherwise plan mode derives one that keeps every tool on the wire and
    // scopes edits to the plan files. Build agents get undefined (all allowed).
    const allowedTools =
      input.session.allowedTools ??
      (input.agent.name === "plan" ? planAllowlist(registered.map((item) => item.id)) : undefined)
    const ruleset = PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
    const denied = PermissionNext.disabled(
      registered.map((item) => item.id),
      ruleset,
    )
    for (const item of registered) {
      if (denied.has(item.id)) continue
      if (input.session.bare && BARE_EXCLUDED.has(item.id)) continue
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          const denial = toolDenial(allowedTools, item.id, args)
          if (denial) {
            return {
              title: item.id,
              metadata: {},
              output: denial,
            }
          }
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          const result = await item.execute(args, ctx)
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            result,
          )
          return result
        },
      })
    }

    if (input.session.bare) return tools

    const mcpTitles = await MCP.titles()
    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      const transformed = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        // Classify read/write only when the allowlist could grant MCP by the
        // read-only CLASS (an allowlist present, without the all-MCP sentinel).
        // The common paths — a root session (undefined) or a write grant — need
        // no classification, so they skip the lookup.
        const mcpClass =
          allowedTools && !allowedTools.includes(Agent.MCP_WRITE)
            ? { readOnly: await MCP.readOnly(key) }
            : { readOnly: false }
        const denial = (await mcpDenied(key)) ?? toolDenial(allowedTools, key, args, mcpClass)
        // The processor builds a completed tool part out of title/metadata/output,
        // so a content-only return fails ToolStateCompleted validation and aborts
        // the turn instead of showing the model why the call was refused.
        if (denial)
          return {
            title: mcpTitles[key] ?? key,
            metadata: {},
            output: denial,
            content: [{ type: "text" as const, text: denial }],
          }

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const result = await execute(args, opts)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: MessageV2.FilePart[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                id: Identifier.ascending("part"),
                sessionID: input.session.id,
                messageID: input.processor.message.id,
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        // A failed MCP tool call still returns a successful JSON-RPC envelope,
        // flagged only by isError. Without this it renders as a normal result
        // and the failure reads as an answer.
        if (result.isError) throw new Error(textParts.join("\n\n") || `${key} failed`)

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: mcpTitles[key] ?? "",
          metadata,
          output: truncated.content,
          attachments,
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    return tools
  }

  // What a turn runs when nothing picks a model or variant: the agent's, else
  // the config default model and that model's configured variant. `model`
  // fixes the model when only the variant is left to resolve.
  export async function defaults(agent?: Agent.Info, model?: { providerID: string; modelID: string }) {
    const chosen = agent ?? (await Agent.get(await Agent.defaultAgent()))
    if (!chosen) throw new Error("no resolvable default agent")
    const resolved = model ?? chosen.model ?? (await Provider.defaultModel())
    // An agent's variant applies only to a model that offers it.
    const variant = await Provider.getModel(resolved.providerID, resolved.modelID).then(
      (info) => (chosen.variant && info.variants?.[chosen.variant] ? chosen.variant : info.variant),
      () => undefined,
    )
    return { agent: chosen.name, model: { providerID: resolved.providerID, modelID: resolved.modelID }, variant }
  }

  // The model an "inherit" write runs: what the session last ran, else its
  // agent's, else the default. Only a model the config no longer offers falls
  // through to the defaults; any other failure is not a reason to move the
  // session off its model.
  async function inherited(sessionID: string, current: Session.Info["current"], agent: Agent.Info) {
    const last = current?.model ?? agent.model ?? (await MessageV2.model(sessionID))
    const live = await Provider.getModel(last.providerID, last.modelID).then(
      () => true,
      (error: unknown) => {
        if (Provider.ModelNotFoundError.isInstance(error)) return false
        throw error
      },
    )
    return live ? last : (await defaults(agent)).model
  }

  // Resolve a candidate agent NAME to a live agent, falling through to the
  // configured default (then the built-in "build" when the default itself is
  // misconfigured) whenever the name does not resolve. Agent.get returns
  // undefined — not a throw — for an unknown name, and a name can be stale: a
  // persisted message or session.current names an agent config has since
  // dropped. Every site that turns a name into an agent it will dereference goes
  // through here, so the fall-through is defined once rather than copied.
  export async function resolveAgent(name: string | undefined, snapshot: SessionPin.Snapshot): Promise<Agent.Info> {
    const resolved =
      (name ? snapshot.agents[name] : undefined) ??
      (name ? await Agent.get(name) : undefined) ??
      (await Agent.get(await Agent.defaultAgent().catch(() => "build")))
    // The default itself can be unresolvable (build disabled and every other
    // primary agent hidden or a subagent). Fail with a descriptive error rather
    // than returning undefined for callers to dereference into an opaque TypeError.
    if (!resolved) throw new Error(`no resolvable agent (requested "${name ?? "<default>"}", default unavailable)`)
    return resolved
  }

  // How a message was sent: its claim, whether the loop minted it (`join`),
  // the running turn's parameters it may adopt, parameters that win over
  // both (a plan switch's agent, a compaction's model), and whether a person
  // sent it though every part is synthetic (`prompt`, a shell command).
  type Minted = {
    claim?: Claim
    join?: boolean
    joined?: Promise<ReturnType<typeof MessageV2.inherit> | undefined>
    params?: Partial<ReturnType<typeof MessageV2.inherit>>
    prompt?: boolean
  }

  // The one writer of user messages. Everything that depends on the session
  // row (the date, the ordinal, `current`) is read and written inside the
  // write transaction, so a Stop landing while the parts were being built is
  // always seen.
  async function createUserMessage(input: Draft, minted: Minted = {}) {
    const snapshot = await SessionPin.get(input.sessionID)
    const owner = await Session.get(input.sessionID)
    // Before any write, claimed or not: a message written past a pending
    // revert would be deleted by the cleanup the next prompt runs. A claimed
    // write can still be refused after this, which leaves the revert already
    // cleaned up with nothing written.
    await SessionRevert.cleanup(owner)
    const current = owner.current
    // Resolve the agent the same way as model/variant below: the request's pick,
    // else the session's established agent, else the default. Without the
    // current fallback a send that names no agent (a restart-resume prompt, any
    // synthetic mint) would snap a non-default-agent session back to the default.
    const agentName = input.agent ?? current?.agent ?? snapshot.defaultAgent
    const agent = await resolveAgent(agentName, snapshot)
    // A prompt that joined a running turn adopts that turn's parameters — not the
    // picker values the client echoed since. Changing them is a conscious
    // idle-time act: interrupt, change, then send. An idle send reads the
    // session's persistent parameters, letting a client override (a dock pick)
    // take precedence and fall through to the agent default, then the model's own
    // configured default, when neither names one.
    const fresh = async () => {
      const model =
        input.model === Provider.INHERIT
          ? await inherited(input.sessionID, current, agent)
          : input.model === Provider.DEFAULT
            ? (await defaults(agent)).model
            : input.model
      // A variant only means something to the model that offers it, so the
      // session's carries forward only while the model is unchanged.
      const same = current?.model?.providerID === model.providerID && current?.model?.modelID === model.modelID
      const pick = input.variant
      const variant =
        pick === Provider.INHERIT
          ? ((same ? current?.variant : undefined) ?? (await defaults(agent, model)).variant)
          : pick === Provider.DEFAULT
            ? (await defaults(agent, model)).variant
            : await Provider.getModel(model.providerID, model.modelID).then((info) => {
                if (!info.variants?.[pick])
                  throw new Error(`model ${model.providerID}/${model.modelID} offers no variant "${pick}"`)
                return pick
              })
      return { agent: agent.name, model, variant }
    }
    const given = Object.fromEntries(Object.entries(minted.params ?? {}).filter((entry) => entry[1] !== undefined))
    const resolved = minted.params ? { ...(await fresh()), ...given } : ((await minted.joined) ?? (await fresh()))
    const info: MessageV2.User = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: { created: Date.now() },
      tools: input.tools,
      system: input.system,
      ...resolved,
    }
    // A synthetic mint (a resume prompt, a task/job result) carries no params
    // of its own and must only READ current: writing it would rewrite the
    // session's agent to the default whenever a non-default-agent turn is
    // resumed. A resolved model is the marker of a real turn.
    const syntheticMint = input.parts.length > 0 && input.parts.every((part) => "synthetic" in part && part.synthetic)
    using _ = defer(() => InstructionPrompt.clear(info.id))

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<MessageV2.Part[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: MessageV2.Part[] = [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath).stat()

              if (stat.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI)
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start - 1, 0)
                  if (end) {
                    limit = end - offset
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ListTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              const file = Bun.file(filepath)
              // Full read of the attached file, so stamp the real mtime + hash
              // (not a bare Date.now()) to keep a later edit from a spurious
              // re-read.
              await FileTime.restamp(input.sessionID, filepath)
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                  synthetic: true,
                  internal: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("agent", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the agent tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat())

    await Image.clamp(parts)

    // A message carrying nothing the user typed is the infrastructure talking
    // (the supervisor's resume prompt, a task result), and marking it here is
    // what keeps it out of the prompt count and out of every "last real user
    // message" lookup.
    if (parts.length > 0 && parts.every((part) => "synthetic" in part && part.synthetic)) info.synthetic = true

    // The message and its parts land together, or not at all, with every
    // session-row fact they imply: a delivery's claim (a debt paid, a report
    // recorded) runs inside the same transaction, so a result is written
    // exactly when it is paid. Every message into a subagent opens the
    // child's debt or joins the one still open in this same write, so a
    // report racing it either lands first (and this opens a new debt) or sees
    // this message and waits for its answer. A loop-minted (join-only) message
    // only joins, and never counts or moves `current`.
    const [write, attach, debts, mutate] = await Promise.all([
      Messages.writer(),
      Parts.writer(),
      Debt.claimer(),
      Sessions.mutator(),
    ])
    const asks = !minted.join
    const outcome = await Db.transaction(() => {
      const verdict = { refused: false, changed: false, debt: undefined as "opened" | "joined" | undefined }
      const row = mutate(input.sessionID, (draft) => {
        const now = Date.now()
        // After any stop it saw: an Esc or Stop stamped in the same
        // millisecond would otherwise read as a stop after the message. At
        // most a millisecond ahead of the clock, so a stop dated later (a
        // clock stepped back) still wins.
        info.time.created = Math.max(now, Math.min((draft.time.stopped ?? 0) + 1, now + 1))
        if (minted.claim && !minted.claim(info)) {
          verdict.refused = true
          return false
        }
        // Durable the moment the prompt exists, rather than recounted per turn
        // from a history that compaction shortens.
        if (asks && (minted.prompt || !info.synthetic)) {
          draft.prompts = (draft.prompts ?? 0) + 1
          info.ordinal = draft.prompts
          verdict.changed = true
        }
        // What a real send resolved to, so the next message runs as the same
        // parameters without re-deriving them. A loop-minted message
        // never moves them (a plan switch records its agent itself).
        const moves =
          asks &&
          (minted.prompt || !syntheticMint) &&
          resolved.model &&
          (draft.current?.agent !== resolved.agent ||
            draft.current?.model?.providerID !== resolved.model.providerID ||
            draft.current?.model?.modelID !== resolved.model.modelID ||
            draft.current?.variant !== resolved.variant)
        if (moves)
          draft.current = {
            agent: resolved.agent,
            model: resolved.model,
            variant: resolved.variant,
          }
        if (moves) verdict.changed = true
        verdict.debt = !draft.parentID
          ? undefined
          : minted.join
            ? debts.join(input.sessionID)
              ? "joined"
              : undefined
            : debts.owe(input.sessionID, "subagent", draft.parentID, info.time.created)
        write(info)
        for (const part of parts) attach(part)
        return true
      })
      if (!row && !verdict.refused)
        throw new Error(`session ${input.sessionID} vanished before its message was written`)
      return row ? { ...verdict, parentID: row.parentID } : undefined
    })
    if (!outcome) return undefined
    if (outcome.changed) Bus.publish(Session.Event.Updated, { info: await Session.reload(input.sessionID) })
    if (outcome.debt === "opened" && outcome.parentID) await SessionBusy.push(outcome.parentID)
    MessageV2.uncache(info.id)
    await Session.updateMessage(info)
    for (const part of parts) Session.publishPart(part)

    // Read-only, and after the commit: a refused write tells no plugin about a
    // message that does not exist, and a plugin gets copies to edit freely.
    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: structuredClone(info),
        parts: structuredClone(parts),
      },
    )

    if (info.ordinal === 1) await placeholderTitle(input.sessionID, typed(parts))

    return {
      info,
      parts,
      debt: outcome.debt,
    }
  }

  const PLAN_REMINDER_MARKER = "<!-- plan-mode-reminder -->"
  const PLAN_EXIT_MARKER = "<!-- plan-mode-exit -->"
  const SUBAGENT_MARKER = "<!-- subagent-no-delegation -->"
  // Built-ins that only exist to reach the user's setup, which a bare session
  // leaves out along with the MCP tools and instructions.
  const BARE_EXCLUDED = new Set(["skill", "mcp_search"])
  const CONCISE_MARKER = "<!-- concise-reminder -->"
  const CONCISE =
    "Keep replies concise: lead with the answer, no preamble, no recap. " +
    "This governs user-facing text only, not how much you read, investigate, or think before acting."
  const QUESTION_MARKER = "<!-- question-tool -->"
  const QUESTION =
    "Ask any question with a fixed set of answers by calling the question tool; a question written as text shows the user no picker."
  const TURNS_BETWEEN_REMINDERS = 5
  const FULL_REMINDER_EVERY_N = 5

  function hasReminder(msg: MessageV2.WithParts, marker: string) {
    return msg.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes(marker))
  }

  export function hasConciseReminder(msg: MessageV2.WithParts) {
    return hasReminder(msg, CONCISE_MARKER)
  }

  // One reverse walk tallying what the plan-reminder cadence needs:
  // turnsSinceReminder counts assistant turns back to the FIRST reminder (that is
  // "since the LAST reminder"), so it stops accruing once a reminder is seen.
  // totalReminders counts every reminder back to the exit. hadPlanExit reports
  // whether the NEWEST marker is an exit: a reminder newer than an exit hides it,
  // so the flag tracks the first marker seen, not merely the presence of an exit.
  export function planScan(messages: MessageV2.WithParts[]) {
    let turnsSinceReminder = 0
    let totalReminders = 0
    let hadPlanExit = false
    let seenReminder = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info.role === "user" && hasReminder(msg, PLAN_EXIT_MARKER)) {
        if (!seenReminder) hadPlanExit = true
        break
      }
      if (msg.info.role === "user" && hasReminder(msg, PLAN_REMINDER_MARKER)) {
        totalReminders++
        seenReminder = true
        continue
      }
      if (msg.info.role === "assistant" && !seenReminder) turnsSinceReminder++
    }
    return { turnsSinceReminder, totalReminders, hadPlanExit }
  }

  const EXIT_LINE = /^SKILL-DONE:/m

  // Turns and commits for a skill's per-turn reminder: every part after the
  // ANCHOR, the newest completed `skill` tool part for `name` (later parts of
  // its own message included). Absent (dropped by compaction's filterCompacted,
  // which keeps only the compaction request forward) -> the whole list, scope
  // "since compaction". Whether the content is reviewed is Coverage's to say.
  export function skillLedger(messages: MessageV2.WithParts[], name: string) {
    const loaded = (p: MessageV2.Part) =>
      p.type === "tool" && p.tool === "skill" && p.state.status === "completed" && p.state.input?.name === name
    const anchor = messages.findLastIndex((msg) => msg.info.role === "assistant" && msg.parts.some(loaded))
    const since =
      anchor === -1
        ? messages
        : [
            {
              ...messages[anchor],
              parts: messages[anchor].parts.slice(messages[anchor].parts.findLastIndex(loaded) + 1),
            },
            ...messages.slice(anchor + 1),
          ]
    // The opener is excluded: it is the turn this reminder rides on, not a
    // completed turn to count.
    const opener = since.at(-1)?.info.role === "user" ? 1 : 0
    const commits = since
      .flatMap((msg) => (msg.info.role === "assistant" ? msg.parts : []))
      .filter(
        (part) =>
          part.type === "tool" &&
          part.tool === "bash" &&
          part.state.status === "completed" &&
          /\bgit commit\b/.test(String(part.state.input?.command ?? "")),
      ).length
    return {
      scope: anchor === -1 ? "since compaction" : "since load",
      turns: since.filter((msg) => msg.info.role === "user").length - opener,
      commits,
    }
  }

  // The newest assistant message's own text (synthetic parts excluded, since
  // those are injected reminders, not the model's own words) carrying the
  // SKILL-DONE exit line the model writes to close out a skill run.
  export function skillExitRequested(messages: MessageV2.WithParts[]) {
    const last = messages.findLast((msg) => msg.info.role === "assistant")
    if (!last) return false
    const text = last.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")
    return EXIT_LINE.test(text)
  }

  // Judges a SKILL-DONE line by content, counting only results written up to
  // the line's own message, so one delivered after it cannot vouch for it. The
  // advice reads `current`, the state now: a review that landed after the line
  // needs only a restatement, and no review can vouch while a writer runs.
  // `reviewed` is the only field `until` scopes, so a line judged reviewed was
  // judged at the current state. Undefined when no exit was requested.
  export async function skillVerdict(messages: MessageV2.WithParts[], sessionID: string) {
    const exit = messages.findLast((msg) => msg.info.role === "assistant")
    if (!exit || !skillExitRequested(messages)) return undefined
    const judged = await Coverage.state(sessionID, exit.info.id)
    if (judged.reviewed && judged.writers === 0)
      return { accepted: true, reason: "the current content reviewed", advice: "", current: judged }
    const current = judged.reviewed ? judged : await Coverage.state(sessionID)
    const reason = judged.reviewed
      ? `${judged.writers} write-capable subagent(s) still running`
      : "no completed read-only review of the current content"
    const advice =
      current.writers > 0
        ? `Wait for the ${current.writers} write-capable subagent(s) to report, run a review round over the result, then restate SKILL-DONE.`
        : current.reviewed
          ? "A review of the current content arrived after the line: restate SKILL-DONE."
          : "Run a fresh review round, then restate SKILL-DONE."
    return { accepted: false, reason, advice, current }
  }

  // The `## Checklist` section of a skill body, by heading, for the one-time
  // post-compaction re-inject (the sparse reminder alone is not enough right
  // after the body was dropped from history).
  export function skillChecklistSection(body: string) {
    const start = body.indexOf("## Checklist")
    if (start === -1) return undefined
    const next = body.indexOf("\n## ", start + "## Checklist".length)
    return (next === -1 ? body.slice(start) : body.slice(start, next)).trim()
  }

  // The reminder rides the message that opens a turn, and ONLY there. It is due
  // when the turn-opener does not already carry the reminder, so it lands once,
  // at turn start, on a message not yet sent. A mid-turn re-fire would append to
  // a message already on the wire (the opener stays `findLast(user)` through the
  // whole tool loop), mutating a sent block and re-hashing the prefix behind the
  // rolling marker every call. Freezing the reminder to the opener keeps every
  // sent block byte-identical for the life of the turn. Synthetic-blind: a
  // result that opens an idle turn gets it too, and so does a question's answer.
  export function reminderDue(messages: MessageV2.WithParts[], marker: string) {
    const last = messages[messages.length - 1]
    if (!last || !MessageV2.isTurnOpener(messages, last)) return false
    return !hasReminder(last, marker)
  }

  function planFileInfo(planPath: string, exists: boolean) {
    return exists
      ? `A plan file already exists at ${planPath}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${planPath} using the write tool.`
  }

  function planFileInfoSubagent(planPath: string, exists: boolean) {
    return exists
      ? `A plan file already exists at ${planPath}. You can read it and make incremental edits using the edit tool if you need to.`
      : `No plan file exists yet. You should create your plan at ${planPath} using the write tool if you need to.`
  }

  function renderTemplate(template: string, vars: Record<string, string>) {
    let result = template
    for (const [key, value] of Object.entries(vars)) result = swap(result, key, value, true)
    return result
  }

  // Persist a synthetic, internal text block onto an existing message and mirror
  // it into the in-memory parts the rest of the turn reads before the next
  // reload. Every injector that rides a block on the turn-opener shares this, so
  // the persist-then-mirror contract lives in one place.
  //
  // The target is resolved here, never passed in: an injection rides the turn
  // opener (the newest user message, a block not yet sent) and nowhere else.
  // Because a non-tail target cannot be expressed, the cache-safe placement
  // holds for every injection by construction. Returns the part, or undefined
  // when there is no opener (no user message yet).
  async function appendSyntheticPart(messages: MessageV2.WithParts[], text: string) {
    const opener = MessageV2.turnOpener(messages)
    if (!opener) return
    // A block already sent has an assistant turn after it, and appending to it
    // re-hashes the cached prefix behind that turn. The opener is unsent only
    // when no assistant message follows it. Refuse the write otherwise: the
    // funnel prevents naming a bad target, and this catches the target going
    // stale under a future change, loudly, instead of billing a silent miss.
    if (messages.some((m) => m.info.role === "assistant" && m.info.id > opener.info.id)) {
      log.error("refused prompt injection onto an already-sent message", {
        openerID: opener.info.id,
        text: text.slice(0, 80),
      })
      return
    }
    const info = opener.info as MessageV2.User
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: info.id,
      sessionID: info.sessionID,
      type: "text",
      text,
      synthetic: true,
      internal: true,
    }
    await Session.updatePart(part)
    opener.parts.push(part)
    return part
  }

  async function persistReminder(messages: MessageV2.WithParts[], text: string, marker: string) {
    const wrapped = text.includes("<system-reminder>")
      ? `${marker}\n${text}`
      : `${marker}\n<system-reminder>\n${text}\n</system-reminder>`
    await appendSyntheticPart(messages, wrapped)
  }

  // Inject the progressive-disclosure MCP catalog as durable history when this
  // session's last-injected catalog no longer matches the catalog its instance
  // currently produces. The catalog text becomes a synthetic TextPart on the
  // latest user message and persists.
  //
  // Refresh model (MCP is always on; the catalog for a session is a pure function
  // of its INSTANCE — global+project servers, each server's `disabled` and tier,
  // and the connected set). Each session stores the catalog text it last injected
  // (mcpCatalogText); no version counter. Every turn:
  //   1. build the catalog for this instance and compare to mcpCatalogText.
  //      equal -> no-op (the common case).
  //   2. differ, new catalog empty (no servers / all disabled) -> store "" and
  //      append nothing.
  //   3. differ, new catalog non-empty -> append a FRESH FULL block at the tail
  //      and store it. Recency wins: the newest block supersedes any older one,
  //      which stays as inert history.
  //
  // Backfill: a pre-feature session has mcpCatalogText === undefined, treated as
  // "" -> a non-empty catalog injects on the next turn. Config changes take effect
  // on Stop->reopen (SessionPin.reset re-reads config AND resets MCP.state), which
  // rebuilds the corpus so the compare differs and re-injects.
  //
  // NOT wrapped in <system-reminder> (that would make provider/transform.ts
  // treat it as a meta message).
  async function insertMcpCatalog(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    if (input.session.bare) return
    const catalog = McpCatalog.build(await MCP.corpus())

    // Already reflects the current instance catalog (incl. both being empty).
    if ((catalog ?? "") === (input.session.mcpCatalogText ?? "")) return

    // Nothing to show (no servers / everything disabled): record "" so we do not
    // rebuild-and-compare fruitlessly, append no block.
    if (!catalog) {
      await Session.update(input.session.id, (draft) => void (draft.mcpCatalogText = ""), { touch: false })
      input.session.mcpCatalogText = ""
      return
    }

    // Record the injected catalog only when it was actually appended: the
    // stored text is the recency anchor the next turn compares against, so
    // recording without appending would suppress the injection forever.
    if (!(await appendSyntheticPart(input.messages, catalog))) return
    await Session.update(input.session.id, (draft) => void (draft.mcpCatalogText = catalog), { touch: false })
    input.session.mcpCatalogText = catalog
  }

  // Repo-scoped subagents ride here instead of in the agent tool's description,
  // which sits in tools[] ahead of every cache marker (see AgentCatalog). The
  // block is appended once per session and then carried as durable history.
  async function insertAgentCatalog(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    // A subagent cannot spawn another subagent, so the list would be dead weight
    // in its prompt, and a subagent started without include_context is meant to
    // begin from a blank conversation.
    if (!Session.attended(input.session)) return
    const scoped = await Config.projectAgents()
    if (scoped.size === 0) return
    const agents = (await Agent.list()).filter((a) => a.mode !== "primary" && scoped.has(a.name))
    const catalog = AgentCatalog.build(agents)
    if (!catalog) return

    const present = input.messages.some((msg) =>
      msg.parts.some((part) => part.type === "text" && part.text.startsWith("<project_subagents>")),
    )
    if (present) return

    await appendSyntheticPart(input.messages, catalog)
  }

  // Announce a date or branch that has moved since the model was last told. The
  // frozen session-context block sits ahead of the whole conversation, so
  // correcting it in place would re-hash every block behind it; a block at the
  // tail states the new value and leaves the cached prefix untouched. Both facts
  // ride one block, so a turn that crosses midnight on a new branch appends once.
  async function insertSessionContext(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    const date = SystemPrompt.date()
    // session.branch is fixed at creation, so a switch is only visible by asking
    // Vcs, which serves a value it keeps current from a watcher rather than
    // shelling out per turn. A read failure returns undefined, which carries no
    // information: hold the last known branch rather than announcing a move to
    // nothing, which would emit an empty block and forget the real branch.
    const live = Instance.project.vcs === "git" ? await Vcs.branch() : undefined
    const branch = live ?? input.session.contextBranch ?? input.session.branch
    // Seed both dimensions from what the frozen block already stated (the
    // creation-time values), so a value that never moved announces nothing.
    const known = {
      date: input.session.contextDate ?? SystemPrompt.date(input.session.time.created),
      branch: input.session.contextBranch ?? input.session.branch,
    }
    if (known.date === date && known.branch === branch) return

    if (!MessageV2.turnOpener(input.messages)) return
    const text = SystemPrompt.sessionContextUpdate({
      date: known.date === date ? undefined : date,
      branch: known.branch === branch ? undefined : branch,
    })
    await appendSyntheticPart(input.messages, text)
    await Session.update(
      input.session.id,
      (draft) => {
        draft.contextDate = date
        draft.contextBranch = branch
      },
      { touch: false },
    )
    input.session.contextDate = date
    input.session.contextBranch = branch
  }

  // Per-skill reminder: a computed ledger plus the skill's own `reminder.sparse`
  // text, on every turn opener while the skill is Session.Info.activeSkills.
  async function insertSkillReminders(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    const active = input.session.activeSkills ?? []
    if (active.length === 0) return

    const opener = MessageV2.turnOpener(input.messages)
    if (!opener) return

    // The compaction-minted "Continue if you have next steps" message has no
    // assistant after it (same freshness test appendSyntheticPart itself
    // uses), and its own predecessor is the finished summary — the one
    // fingerprint of "we just crossed a compaction boundary" available here.
    const prev = input.messages.at(-2)
    const justCompacted = prev?.info.role === "assistant" && (prev.info as MessageV2.Assistant).summary === true

    for (const name of active) {
      const marker = `<!-- skill-reminder:${name} -->`
      if (hasReminder(opener, marker)) continue

      const led = skillLedger(input.messages, name)
      const verdict = await skillVerdict(input.messages, input.session.id)

      if (verdict?.accepted) {
        await Session.update(
          input.session.id,
          (draft) => void (draft.activeSkills = (draft.activeSkills ?? []).filter((n) => n !== name)),
          { touch: false },
        )
        input.session.activeSkills = (input.session.activeSkills ?? []).filter((n) => n !== name)
        continue
      }

      const skill = await Skill.get(name)
      if (!skill?.reminder) continue

      if (justCompacted) {
        const section = skillChecklistSection(await currentSkillBody(skill))
        if (section) await persistReminder(input.messages, section, `<!-- skill-checklist:${name} -->`)
      }

      const refusal = verdict ? `\n\nExit refused: SKILL-DONE was written with ${verdict.reason}. ${verdict.advice}` : ""
      const coverage = verdict?.current ?? (await Coverage.state(input.session.id))
      const text =
        `${name} active. ${led.scope}: ${led.turns} turns \u00b7 ${led.commits} commits \u00b7 ` +
        `current content reviewed: ${coverage.reviewed ? "yes" : "no"} \u00b7 ` +
        `write-capable subagents running: ${coverage.writers}.\n\n${skill.reminder.sparse}${refusal}`
      await persistReminder(input.messages, text, marker)
    }
  }

  async function insertReminders(input: {
    messages: MessageV2.WithParts[]
    agent: Agent.Info
    session: Session.Info
    model: Provider.Model
  }) {
    await insertMcpCatalog(input)
    await insertAgentCatalog(input)
    await insertSessionContext(input)

    const userMessage = MessageV2.turnOpener(input.messages)
    if (!userMessage) return input.messages

    // The concision rules live in the cached system prompt, which a long turn
    // drifts from; re-stating the shape on each new turn holds it. The reminder
    // rides the typed prompt itself (a message not yet sent), so the prefix
    // behind it stays byte-identical. A subagent's output is read by its parent
    // model, not the user, so terseness tuned for a human reader would cost the
    // parent detail — hence the parentID guard.
    if (Session.attended(input.session) && reminderDue(input.messages, CONCISE_MARKER)) {
      const concise = (await Config.get()).concise?.[`${input.model.providerID}/${input.model.id}`]
      if (concise) await persistReminder(input.messages, CONCISE, CONCISE_MARKER)
    }

    // The system prompt's question rule sits far behind a long conversation,
    // and the model drifts to typing questions late in one. Restated where it
    // writes next, including on every answer, since an answer is a turn opener.
    if (
      Session.attended(input.session) &&
      reminderDue(input.messages, QUESTION_MARKER) &&
      (await ToolRegistry.ids()).includes("question")
    )
      await persistReminder(input.messages, QUESTION, QUESTION_MARKER)

    // Subagents run for their parent's benefit, not the user's — the loop's
    // exit checklist and ledger are meaningless without a human deciding
    // whether to trust "done".
    if (Session.attended(input.session)) await insertSkillReminders(input)

    // A subagent reaches for the agent tool, gets a denial back, and only then
    // does the work itself, having spent a turn learning it. The tool stays in
    // the schema either way (removing it would move the tools[] bytes the whole
    // prefix hashes), so the cheap fix is telling it up front.
    //
    // Written once for the session: the fact never changes, so the presence
    // check spans the whole conversation, not just the message being answered.
    // It rides the turn opener like every other injection, so under
    // include_context (where messages[0] holds the whole copied conversation)
    // it lands on the small new prompt at the tail, not in the cached prefix.
    if (input.session.parentID && !input.messages.some((m) => hasReminder(m, SUBAGENT_MARKER))) {
      await persistReminder(input.messages, SUBAGENT, SUBAGENT_MARKER)
    }

    const plan = Session.plan(input.session)
    const exists = await Bun.file(plan).exists()

    // Switching from plan mode to build mode
    const lastAssistant = input.messages.findLast((msg) => msg.info.role === "assistant")
    if (input.agent.name !== "plan" && lastAssistant?.info.agent === "plan") {
      const exitText = renderTemplate(BUILD_SWITCH, {
        "${PLAN_FILE_INFO_EXIT}": exists ? ` The plan file is located at ${plan} if you need to reference it.` : "",
      })
      await persistReminder(input.messages, exitText, PLAN_EXIT_MARKER)
      return input.messages
    }

    // Not in plan mode — check if this is a sub-agent whose parent is in plan mode
    if (input.agent.name !== "plan") {
      if (input.session.parentID && !hasReminder(userMessage, PLAN_REMINDER_MARKER)) {
        const parentMsgs = await Session.messages({ sessionID: input.session.parentID })
        const parentLastUser = parentMsgs.findLast(MessageV2.isHumanTyped)
        if (parentLastUser && (parentLastUser.info as MessageV2.User).agent === "plan") {
          const parentSession = await Session.get(input.session.parentID)
          const parentPlan = Session.plan(parentSession)
          const parentPlanExists = await Bun.file(parentPlan).exists()
          const subagentText = renderTemplate(PROMPT_PLAN_SUBAGENT, {
            "${PLAN_FILE_INFO_SUBAGENT}": planFileInfoSubagent(parentPlan, parentPlanExists),
          })
          await persistReminder(input.messages, subagentText, PLAN_REMINDER_MARKER)
        }
      }
      return input.messages
    }

    // In plan mode — check if we need to inject a reminder
    if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })

    // Check if this user message already has a plan reminder (e.g. from a previous loop iteration)
    if (hasReminder(userMessage, PLAN_REMINDER_MARKER)) return input.messages

    const { turnsSinceReminder, totalReminders, hadPlanExit } = planScan(input.messages)

    const isEnteringPlan = !lastAssistant || lastAssistant.info.agent !== "plan"

    // Re-entry: entering plan mode again after a previous exit, with an existing plan file
    if (isEnteringPlan && hadPlanExit && exists) {
      const reentryText = renderTemplate(PROMPT_PLAN_REENTRY, { "${PLAN_FILE_PATH}": plan })
      await persistReminder(input.messages, reentryText, PLAN_REMINDER_MARKER)
    }

    // First entry or re-entry: always inject full reminder
    if (isEnteringPlan) {
      const fullText = renderTemplate(PROMPT_PLAN, { "${PLAN_FILE_INFO}": planFileInfo(plan, exists) })
      await persistReminder(input.messages, fullText, PLAN_REMINDER_MARKER)
      return input.messages
    }

    // Continuing in plan mode — periodic injection
    if (turnsSinceReminder < TURNS_BETWEEN_REMINDERS) return input.messages

    // Determine full vs sparse: full on 1st, every Nth after
    const isFull = (totalReminders + 1) % FULL_REMINDER_EVERY_N === 1
    if (isFull) {
      const fullText = renderTemplate(PROMPT_PLAN, { "${PLAN_FILE_INFO}": planFileInfo(plan, exists) })
      await persistReminder(input.messages, fullText, PLAN_REMINDER_MARKER)
    } else {
      const sparseText = renderTemplate(PROMPT_PLAN_SPARSE, { "${PLAN_FILE_PATH}": plan })
      await persistReminder(input.messages, sparseText, PLAN_REMINDER_MARKER)
    }

    return input.messages
  }

  export const ShellInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  // A person's command, so its message is a prompt like any other (it counts,
  // titles, and moves `current`), and its execution is a turn: busy while it
  // runs, and its end pays what the session is owed.
  export async function shell(input: Omit<ShellInput, "model"> & { model: Choice; variant: string }) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }
    // Announced once, as the loop's turn is: idle for a finish, the error for a
    // failure or an Esc, nothing for a Stop or a dispose. Declared first, so it
    // runs last.
    let ended: { error?: MessageV2.Assistant["error"] } | undefined
    using _announce = defer(() => {
      SessionBusy.forget(input.sessionID)
      if (!ended || abort.reason === DISPOSED || abort.reason === STOPPED) return
      if (ended.error) return void Bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: ended.error })
      SessionBusy.finish(input.sessionID)
    })
    // Declared before the cancel, so it runs after it, as the loop's does.
    using _collect = defer(() => {
      if (abort.reason === DISPOSED || abort.reason === STOPPED) return
      void Recovery.collect(input.sessionID, { fresh: true }).catch((error) =>
        log.error("could not collect", { sessionID: input.sessionID, error }),
      )
    })
    const own = state()[input.sessionID].abort
    using _ = defer(() => cancel(input.sessionID, undefined, own))
    SessionBusy.enter(input.sessionID)
    let since: number | undefined
    return await execute(abort).then(
      (reply) => {
        ended = abort.aborted ? { error: new MessageV2.AbortedError({ message: "interrupted" }).toObject() } : {}
        return reply
      },
      async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        ended = { error: new NamedError.Unknown({ message }).toObject() }
        if (abort.reason === STOPPED) throw error
        log.error("shell failed", { sessionID: input.sessionID, error })
        if (since !== undefined)
          await Recovery.fail(input.sessionID, message, since).catch((failure) =>
            log.error("could not report a failed shell", { sessionID: input.sessionID, failure }),
          )
        throw error
      },
    )

    async function execute(abort: AbortSignal) {
      const written = (await createUserMessage(
        {
          messageID: input.messageID,
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          variant: input.variant,
          parts: [{ type: "text", text: "The following tool was executed by the user", synthetic: true }],
        },
        { prompt: true },
      ))!
      const userMsg = written.info
      const model = userMsg.model
      since = userMsg.time.created
      // The message's only part is synthetic, so the title comes from what the
      // person actually typed.
      if (userMsg.ordinal === 1) await placeholderTitle(input.sessionID, input.command)

      const msg: MessageV2.Assistant = {
        id: Identifier.ascending("message"),
        sessionID: input.sessionID,
        parentID: userMsg.id,
        mode: userMsg.agent,
        agent: userMsg.agent,
        cost: 0,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        time: {
          created: Date.now(),
        },
        role: "assistant",
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.modelID,
        providerID: model.providerID,
      }
      await Session.updateMessage(msg)
      const part: MessageV2.Part = {
        type: "tool",
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: input.sessionID,
        tool: "bash",
        callID: ulid(),
        state: {
          status: "running",
          time: {
            start: Date.now(),
          },
          input: {
            command: input.command,
          },
        },
      }
      await Session.updatePart(part)
      const shell = Shell.preferred()
      const shellName = (
        process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
      ).toLowerCase()

      const invocations: Record<string, { args: string[] }> = {
        nu: {
          args: ["-c", input.command],
        },
        fish: {
          args: ["-c", input.command],
        },
        zsh: {
          args: [
            "-c",
            "-l",
            `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
          ],
        },
        bash: {
          args: [
            "-c",
            "-l",
            `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
          ],
        },
        // Windows cmd
        cmd: {
          args: ["/c", input.command],
        },
        // Windows PowerShell
        powershell: {
          args: ["-NoProfile", "-Command", input.command],
        },
        pwsh: {
          args: ["-NoProfile", "-Command", input.command],
        },
        // Fallback: any shell that doesn't match those above
        //  - No -l, for max compatibility
        "": {
          args: ["-c", `${input.command}`],
        },
      }

      const matchingInvocation = invocations[shellName] ?? invocations[""]
      const args = matchingInvocation?.args

      const cwd = Instance.directory
      const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
      const proc = spawn(shell, args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...shellEnv.env,
          TERM: "dumb",
        },
      })

      let output = ""

      // Both streams append to one `output` and persist one shared `part`, so the
      // writes must not overlap: an un-awaited write captures the part as it is
      // when the write actually runs, and two in flight can land newest-first,
      // leaving the stale snapshot stored. Chaining keeps them ordered while
      // still returning to the stream handler immediately.
      let pending: Promise<unknown> = Promise.resolve()
      const persist = (chunk: unknown) => {
        output += String(chunk)
        if (part.state.status !== "running") return
        part.state.metadata = { output, description: "" }
        pending = pending.then(() => Session.updatePart(part)).catch(() => {})
      }

      proc.stdout?.on("data", persist)
      proc.stderr?.on("data", persist)

      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      abort.addEventListener("abort", abortHandler, { once: true })

      await new Promise<void>((resolve) => {
        proc.on("close", () => {
          exited = true
          abort.removeEventListener("abort", abortHandler)
          resolve()
        })
      })

      if (aborted) {
        output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
      }
      msg.time.completed = Date.now()
      await Session.updateMessage(msg)
      if (part.state.status === "running") {
        part.state = {
          status: "completed",
          time: {
            ...part.state.time,
            end: Date.now(),
          },
          input: part.state.input,
          title: "",
          metadata: {
            output,
            description: "",
          },
          output,
        }
        await Session.updatePart(part)
      }
      return { info: msg, parts: [part] }
    }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: Omit<CommandInput, "model" | "variant"> & { model: Choice; variant: string }) {
    log.info("command", input)
    const snapshot = await SessionPin.get(input.sessionID)
    const command = snapshot.commands[input.command] ?? (await Command.get(input.command))
    // What the session runs when the request names no agent, through the one
    // resolver, so an agent the config has since dropped falls to the default.
    const runs = (
      await resolveAgent((await Session.get(input.sessionID)).current?.agent ?? snapshot.defaultAgent, snapshot)
    ).name
    const agentName = command.agent ?? input.agent ?? runs

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = swap(withArgs, "$ARGUMENTS", input.arguments, true)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    // Substituted ahead of the shell expansion below so a !`...` block can pass
    // the id to a command; the model has no other way to learn which session it is.
    template = swap(template, "$SESSION", input.sessionID, true)

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const agent = snapshot.agents[agentName] ?? (await Agent.get(agentName))
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }
    const cmdAgent = command.agent ? (snapshot.agents[command.agent] ?? (await Agent.get(command.agent))) : undefined
    const override = command.model ? Provider.parseModel(command.model) : cmdAgent?.model
    const subagentModel: Choice =
      override ?? (input.model === Provider.DEFAULT ? (await defaults(agent)).model : input.model)

    if (subagentModel !== Provider.INHERIT) {
      try {
        await Provider.getModel(subagentModel.providerID, subagentModel.modelID)
      } catch (e) {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const { providerID, modelID, suggestions } = e.data
          const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
          })
        }
        throw e
      }
    }

    const templateParts = await resolvePromptParts(template)
    // Only a named agent dispatches as a subagent: inside a child the session's
    // own agent is a subagent, and the command runs inline as that agent.
    const named = (command.agent ?? input.agent) !== undefined
    const isSubagent = (named && agent.mode === "subagent" && command.subagent !== false) || command.subagent === true
    const parts = isSubagent
      ? [
          {
            type: "subagent" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            // Absent, the child runs on the turn's own model.
            model:
              subagentModel === Provider.INHERIT
                ? undefined
                : { providerID: subagentModel.providerID, modelID: subagentModel.modelID },
            // TODO: how can we make agent tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubagent ? (input.agent ?? runs) : agentName
    const userModel = isSubagent ? input.model : subagentModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    // The client's variant was picked for the model it sent (or, for inherit
    // and default, the model those resolve to); a command that moves to another
    // model inherits instead of validating it against that one. A pick the
    // command leaves in place stays; a lingering one is accepted.
    const held =
      !override || isSubagent
        ? undefined
        : input.model === Provider.INHERIT
          ? await inherited(input.sessionID, (await Session.get(input.sessionID)).current, agent)
          : input.model === Provider.DEFAULT
            ? (await defaults(agent)).model
            : input.model
    const moved = !!override && !!held && (override.providerID !== held.providerID || override.modelID !== held.modelID)
    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: moved && input.variant !== Provider.DEFAULT ? Provider.INHERIT : input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  // The tail carries where the conversation ended up; a title built from the
  // opening prompt alone goes stale as soon as the session moves on.
  const TITLE_CONTEXT_CHARS = 1000

  // The opening prompt names the session, the third renames it once a topic has
  // established itself. A later prompt describes a session the user already
  // recognises, so generation stops.
  // A shell command counts as a prompt, so a session opened with one takes the
  // command as its title and its next typed prompt is ordinal 2, which does
  // not generate: the third renames it.
  const TITLE_ORDINALS = [1, 3]

  // Longer than this is not a 3-7 word title but a model ignoring the prompt,
  // and truncating it produces a worse label than the one already shown.
  const TITLE_MAX_CHARS = 80

  const TITLE_TIMEOUT = 15_000

  // Cut a placeholder at a word boundary rather than mid-word, and leave the
  // ellipsis off — this is a label in a list, not prose.
  const PLACEHOLDER_MAX_CHARS = 50

  // The prompt asks for {"title": "..."} and nothing on the wire enforces it:
  // the SDK constrains output through a forced tool call on Anthropic, which
  // this deliberately tool-less call cannot take. So the parse is the whole
  // enforcement, and it is strict on purpose. Prose that is not the requested
  // object is a model that ignored the instruction, and taking its first line
  // anyway is what produced titles like a bare ``` fence: returning undefined
  // keeps the existing title and lets the next ordinal try again.
  export function parseTitle(text: string) {
    const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    const json = stripped.match(/\{[\s\S]*\}/)
    if (!json) return
    const parsed = iife(() => {
      try {
        return JSON.parse(json[0]) as { title?: unknown }
      } catch {
        return undefined
      }
    })
    if (typeof parsed?.title !== "string") return
    const title = parsed.title.trim()
    if (!title || title.length > TITLE_MAX_CHARS) return
    return title
  }

  // Only the user's own prompts. An assistant's reply is mostly code and tool
  // output, so a raw conversation tail late in a session is a keyhole onto
  // whatever was being printed when the window closed rather than onto what the
  // session is about. Subagent prompts count as text because a command
  // invocation (/fix, /review) carries the request there and contributes no
  // text part at all.
  export function titleInput(history: MessageV2.WithParts[]) {
    const text = history
      .filter(MessageV2.isHumanTyped)
      .flatMap((msg) =>
        msg.parts.flatMap((part) => {
          if (part.type === "subagent") return [part.prompt]
          if (part.type !== "text" || part.synthetic || part.ignored) return []
          return [part.text]
        }),
      )
      .join("\n")
      .trim()
    return text.length > TITLE_CONTEXT_CHARS ? text.slice(-TITLE_CONTEXT_CHARS) : text
  }

  // Shown the instant the first prompt lands, so the list reads as something
  // recognisable instead of an ISO timestamp for as long as the model takes.
  // Deliberately dumb: the first line of what was asked, which beats a rushed
  // generated title often enough to be worth showing.
  export function derivePlaceholder(text: string) {
    const line = text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith("<") && !entry.startsWith("#"))
    if (!line) return
    if (line.length <= PLACEHOLDER_MAX_CHARS) return line
    const cut = line.slice(0, PLACEHOLDER_MAX_CHARS)
    const boundary = cut.lastIndexOf(" ")
    return boundary > 0 ? cut.slice(0, boundary) : cut
  }

  function typed(parts: MessageV2.Part[]) {
    return parts
      .flatMap((part) => {
        if (part.type === "subagent") return [part.prompt]
        if (part.type !== "text" || part.synthetic || part.ignored) return []
        return [part.text]
      })
      .join("\n")
  }

  async function placeholderTitle(sessionID: string, text: string) {
    const placeholder = derivePlaceholder(text)
    if (!placeholder) return
    await Session.update(
      sessionID,
      (draft) => {
        if (!Session.isDefaultTitle(draft.title)) return
        draft.title = placeholder
        draft.titleGenerated = placeholder
      },
      { touch: false },
    )
  }

  // The generator may replace only its own text. Equality proves the title on
  // screen is what it last wrote; anything else means a rename, a fork, a
  // --title, or a subagent description owns the name. A session with no record
  // at all is owned unless its title is still the default, which is what leaves
  // every session written before this existed alone.
  export function generatorOwns(session: Session.Info) {
    if (session.titleGenerated !== undefined) return session.titleGenerated === session.title
    return Session.isDefaultTitle(session.title)
  }

  // The ordinal to generate at, or undefined to leave the title as it is.
  export function titleTrigger(session: Session.Info, history: MessageV2.WithParts[]) {
    if (!Session.attended(session)) return
    if (!generatorOwns(session)) return
    // The last titleable prompt. Skipping ordinal-less infra switches (a plan
    // mode switch) is what stops one from reading as "no title" and suppressing
    // the title on the turn after a switch.
    const latest = history.findLast(MessageV2.isOrdinalPrompt)
    if (!latest) return
    // The message's own ordinal, not a count of what this turn can see: a
    // re-entered loop (a task result arriving, the compaction route) reaches
    // here with no new prompt, and the ordinal it reads is one already
    // generated at.
    const ordinal = (latest.info as MessageV2.User).ordinal
    if (!ordinal || !TITLE_ORDINALS.includes(ordinal)) return
    if (session.titleOrdinal !== undefined && session.titleOrdinal >= ordinal) return
    return ordinal
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    const ordinal = titleTrigger(input.session, input.history)
    if (!ordinal) return
    // The same titleable prompt titleTrigger keyed on, so the title request bills
    // against the real prompt's params, not an ordinal-less infra switch.
    const latestUser = input.history.findLast(MessageV2.isOrdinalPrompt)!

    const content = titleInput(input.history)
    if (!content) return

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    // Claiming the ordinal before the request, not after it, is what stops two
    // turns racing into the same generation. The generation is worth nothing
    // late, so it is bounded rather than left to a retry that could land after
    // the user has renamed the session.
    await Session.update(input.session.id, (draft) => void (draft.titleOrdinal = ordinal), { touch: false })
    const { stream } = await LLM.stream({
      agent,
      user: latestUser.info as MessageV2.User,
      system: { env: [], globalInstructions: [], projectInstructions: [] },
      small: true,
      tools: {},
      model,
      abort: AbortSignal.timeout(TITLE_TIMEOUT),
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    })
    const text = await stream.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (!text) return
    const title = parseTitle(text)
    if (!title) return
    return Session.update(
      input.session.id,
      (draft) => {
        // Re-checked against the draft because the request took time: a rename
        // during it owns the title, and a later ordinal's result landing first
        // is the better one.
        if (!generatorOwns(draft)) return
        if (draft.titleOrdinal !== undefined && draft.titleOrdinal > ordinal) return
        draft.title = title
        draft.titleGenerated = title
      },
      { touch: false },
    )
  }
}
