import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Identifier } from "../id/id"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { fn } from "@/util/fn"
import { Storage } from "@/storage/storage"
import { ProviderTransform } from "@/provider/transform"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { type SystemError } from "bun"
import type { Provider } from "@/provider/provider"

export namespace MessageV2 {
  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const BackgroundTaskResult = z.object({
    taskId: z.string(),
    type: z.enum(["subagent", "shell"]),
    description: z.string(),
    status: z.enum(["completed", "failed", "cancelled"]),
    agent: z.string().optional(),
    duration: z.number(),
  })
  export type BackgroundTaskResult = z.infer<typeof BackgroundTaskResult>

  // A shell job's result, kept apart from a subagent task's. They share a
  // shape and nothing else: a task has an agent and a session it reasoned in,
  // a job has a command, an exit code and a log. The states differ too, since
  // only a job can be mid-run at delivery (a soft check-in) or killed by its
  // own watchdog.
  export const BackgroundJobResult = z.object({
    jobId: z.string(),
    command: z.string(),
    description: z.string(),
    // `ended` is a job that finished without recording an exit code, which a
    // kill before its own exit write leaves behind. Distinct from `failed`,
    // since nothing knows whether the command succeeded.
    status: z.enum(["completed", "failed", "timeout", "running", "ended"]),
    exit: z.number().optional(),
    log: z.string(),
    duration: z.number(),
  })
  export type BackgroundJobResult = z.infer<typeof BackgroundJobResult>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    // Machinery the model reads and the reader does not: a rule reminder, the
    // MCP catalog, a mid-turn nudge. Distinct from `synthetic`, which marks
    // anything the user did not type and so covers job results and the restart
    // notice too — both of which ARE for the reader. A transcript hides this;
    // the model still receives it.
    internal: z.boolean().optional(),
    backgroundTaskResult: BackgroundTaskResult.optional(),
    backgroundJobResult: BackgroundJobResult.optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    signature: z.string().optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
    promptIndex: z.number().optional(),
    synthetic: z.boolean().optional(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
    // Which real user prompt this is, counted from 1 over the session's whole
    // life. Distinct from promptIndex, which is a position in one request's
    // message array and is rewritten every turn. Absent on synthetic messages
    // and on anything written before this existed.
    ordinal: z.number().optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    finish: z.string().optional(),
    variant: z.string().optional(),
    sessionTotal: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheWrite: z.number(),
        cost: z.number(),
      })
      .optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  export type ToModelMessagesResult = {
    messages: ModelMessage[]
    /** Maps session message ID to its index in the final model messages array */
    idToIndex: Map<string, number>
  }

  export function toModelMessages(input: WithParts[], model: Provider.Model): ToModelMessagesResult {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()

    const toModelOutput = (output: unknown) => {
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mime,
              data: iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              }),
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        // The typed text is emitted last so the turn's cache anchor lands on it:
        // the Anthropic SDK lowers a message-level marker onto the message's
        // LAST block, and a reminder minted mid-turn would otherwise take that
        // slot and move the anchor on every append.
        const typed: TextPart[] = []
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored) {
            if (part.synthetic)
              userMessage.parts.push({
                type: "text",
                text: part.text,
              })
            else typed.push(part)
          }
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory")
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
        for (const part of typed) userMessage.parts.push({ type: "text", text: part.text })
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
              const attachments = part.state.time.compacted ? [] : (part.state.attachments ?? [])
              const output =
                attachments.length > 0
                  ? {
                      text: outputText,
                      attachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel
                ? {}
                : {
                    providerMetadata:
                      part.metadata ?? (part.signature ? { anthropic: { signature: part.signature } } : undefined),
                  }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    const withoutThinkingOnly = result.filter((msg) => {
      if (msg.role !== "assistant") return true
      return msg.parts.some((part) => part.type !== "reasoning" && part.type !== "step-start")
    })

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    // Filter out messages that only have step-start parts
    const filtered = withoutThinkingOnly.filter((msg) => msg.parts.some((part) => part.type !== "step-start"))

    // Build ID to model-message-index mapping in a single forward pass.
    // convertToModelMessages produces 1 block per user message and 2 blocks
    // per assistant-with-tool-results (assistant + tool), so we track a
    // running offset to get the true position in the final ModelMessage[].
    const idToIndex = new Map<string, number>()
    let modelIdx = 0
    for (const msg of filtered) {
      if (msg.id) idToIndex.set(msg.id, modelIdx)
      modelIdx++ // the message itself
      // assistant messages with tool outputs get an extra 'tool' role block
      if (
        msg.role === "assistant" &&
        msg.parts.some(
          (p) =>
            typeof p.type === "string" &&
            p.type.startsWith("tool-") &&
            "state" in p &&
            (p.state === "output-available" || p.state === "output-error"),
        )
      )
        modelIdx++
    }

    return {
      messages: convertToModelMessages(filtered, {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      }),
      idToIndex,
    }
  }

  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    const messages = [] as WithParts[]
    for (const item of list) {
      const message = await get({ sessionID, messageID: item[2] }).catch(() => undefined)
      if (message) messages.push(message)
    }
    // The id IS the ordering key: it packs the mint millisecond and a counter
    // that increments within it, so it orders a turn's messages at a resolution
    // time.created cannot. Ordering by a separate timestamp field made the two
    // able to disagree, and a client-minted id whose created is stamped on
    // arrival disagrees by the round trip.
    messages.sort((a, b) => Identifier.compare(b.info.id, a.info.id))
    for (const message of messages) yield message
  })

  // The newest user message whose selector returns a value. Synthetic turns
  // stamp what they inherit but never leave a setting blank, so the newest
  // message carrying it is the session's current pick — a turn that names none
  // inherits rather than snapping to a default. The one scan every forward-pick
  // reader shares (model, variant).
  // A SPAWNED HELPER falls through to the session that spawned it. Its own
  // history is empty on the first turn, and it is a ROOT session, so nothing in
  // it reaches the spawner: without this the helper snaps to the configured
  // defaults and runs as something the user never picked.
  //
  // The spawner is read under the directory the debt recorded, since a session
  // resolves only under its own project and a helper's is not always the
  // spawner's.
  //
  // Bounded by a seen-set, the way `SessionBusy.chain` bounds its own walk. The
  // debt is written once at creation and never re-pointed, so the graph should
  // be a forest — but nothing enforces that, and a record naming itself makes
  // this hang rather than crash: every hop awaits, so a cycle is an unbounded
  // async loop re-reading storage, not unbounded recursion.
  async function lastStamped<T>(
    sessionID: string,
    pick: (user: User) => T | undefined,
    seen: Set<string> = new Set(),
  ): Promise<T | undefined> {
    if (seen.has(sessionID)) return undefined
    seen.add(sessionID)
    for await (const item of stream(sessionID)) {
      if (item.info.role !== "user") continue
      const value = pick(item.info)
      if (value !== undefined) return value
    }
    const { Session } = await import(".")
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session?.spawn) return undefined
    const { Instance } = await import("@/project/instance")
    return Instance.provide({
      directory: session.spawn.directory,
      fn: () => lastStamped(session.spawn!.parent, pick, seen),
    }).catch(() => undefined)
  }

  export const lastModel = fn(Identifier.schema("session"), (sessionID) => lastStamped(sessionID, (user) => user.model))

  export const lastVariant = fn(Identifier.schema("session"), (sessionID) =>
    lastStamped(sessionID, (user) => user.variant),
  )

  // The per-turn parameters a synthetic message inherits from the turn it
  // continues: which agent is running, and the model/variant it runs as. Every
  // synthetic writer spreads exactly these, so a new one cannot silently omit
  // one and leave a blank the next reader falls through.
  export function inherit(source: User) {
    return { agent: source.agent, model: source.model, variant: source.variant }
  }

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    return sizedParts(messageID).then((x) => x.parts)
  })

  // Carries the stored byte total the cache budgets on, which the same reads
  // already know. Measuring it afterwards means serializing every part again.
  async function sizedParts(messageID: string) {
    const parts = [] as MessageV2.Part[]
    let size = 0
    for (const item of await Storage.list(["part", messageID])) {
      // A torn part file (e.g. a process killed mid-write) must drop only that
      // part, not throw and make the whole session unopenable. Session.list
      // already guards its per-file reads the same way.
      const read = await Storage.readSized<MessageV2.Part>(item).catch(() => undefined)
      if (!read) continue
      parts.push(read.value)
      size += read.size
    }
    parts.sort((a, b) => (a.id > b.id ? 1 : -1))
    return { parts, size }
  }

  // Completed assistant turns are immutable, so re-reading one costs a directory
  // scan plus a file read per part for bytes that cannot have changed. Scrolling
  // back re-requests the whole window each time (the client's load-more grows the
  // limit rather than paging), so the same messages are re-read on every step.
  //
  // Budgeted in BYTES, not entries: part payloads range from a few hundred bytes
  // to ~280KB, so an entry count cannot bound the footprint.
  //
  // Both bounds are sized against what a session actually costs on disk, because
  // a bound below that turns the cache into pure overhead: every pass evicts what
  // the pass before it read, and the re-read it exists to avoid happens anyway.
  // The budget covers the largest sessions measured (~72MB) rather than the median,
  // since a small session never approaches it and a large one is the only case
  // where the re-read is expensive. ENTRY_MAX admits the largest single record
  // observed (~382KB) for the same reason — a rejected record is re-read from
  // disk on every pass forever, and the biggest turns are the costliest to redo.
  const cache = new Map<string, { record: WithParts; size: number }>()
  const CACHE_MAX = 128 * 1024 * 1024
  const ENTRY_MAX = 1024 * 1024
  let cached = 0

  export function uncache(messageID: string) {
    const hit = cache.get(messageID)
    if (!hit) return
    cached -= hit.size
    cache.delete(messageID)
  }

  function remember(record: WithParts, size: number) {
    if (size > ENTRY_MAX) return
    uncache(record.info.id)
    cache.set(record.info.id, { record, size })
    cached += size
    for (const key of cache.keys()) {
      if (cached <= CACHE_MAX) break
      uncache(key)
    }
  }

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input): Promise<WithParts> => {
      const hit = cache.get(input.messageID)
      if (hit) {
        cache.delete(input.messageID)
        cache.set(input.messageID, hit)
        return hit.record
      }
      const info = await Storage.readSized<MessageV2.Info>(["message", input.sessionID, input.messageID])
      const stored = await sizedParts(input.messageID)
      const record = { info: info.value, parts: stored.parts }
      // Only a finished assistant turn is safe to keep: a streaming one is
      // rewritten part by part, and a user message can still gain summary diffs.
      if (record.info.role === "assistant" && record.info.time.completed) remember(record, info.size + stored.size)
      return record
    },
  )

  // A user message has its terminal response when a finished assistant LINKS to
  // it (parentID) with a finish reason that isn't "tool-calls"/"unknown" — both
  // of those mean more work is coming. The link is set at creation and cannot
  // change, unlike an id compare, which a backward clock step reorders.
  export function answered(msgs: MessageV2.WithParts[], messageID: string) {
    return msgs.some(
      (msg) =>
        msg.info.role === "assistant" &&
        msg.info.parentID === messageID &&
        msg.info.finish &&
        !["tool-calls", "unknown"].includes(msg.info.finish),
    )
  }

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    // The stream yields newest-first. The compaction boundary is found by the
    // parentID LINK, not by whether the summary happens to sort after its
    // request. Pass 1 collects every compaction request that a finished summary
    // answered (summary.parentID == request.id). Pass 2 walks newest-first and
    // stops at the first such answered compaction request: history older than it
    // is summarized away and dropped. The request's own summary is kept even
    // when a clock inversion sorts it AFTER the request in the stream (so it
    // would otherwise fall past the cut) — the summary is the compacted context
    // the next turn continues from. The old single-pass build-as-you-walk both
    // missed the boundary under inversion (kept all history) and, once fixed to
    // break, could drop the summary; keying on the link fixes both.
    const newestFirst = [] as MessageV2.WithParts[]
    const answeredBy = new Map<string, string>()
    for await (const msg of stream) {
      newestFirst.push(msg)
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish)
        answeredBy.set(msg.info.parentID, msg.info.id)
    }
    const result = [] as MessageV2.WithParts[]
    for (const msg of newestFirst) {
      const boundary =
        msg.info.role === "user" && answeredBy.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction")
      if (boundary) {
        result.push(msg)
        const summaryID = answeredBy.get(msg.info.id)
        if (!result.some((m) => m.info.id === summaryID)) {
          const summary = newestFirst.find((m) => m.info.id === summaryID)
          if (summary) result.push(summary)
        }
        break
      }
      result.push(msg)
    }
    result.reverse()
    return result
  }

  const isOpenAiErrorRetryable = (e: APICallError) => {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // openai sometimes returns 404 for models that are actually available
    return status === 404 || e.isRetryable
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const message = iife(() => {
          let msg = e.message
          if (msg === "") {
            if (e.responseBody) return e.responseBody
            if (e.statusCode) {
              const err = STATUS_CODES[e.statusCode]
              if (err) return err
            }
            return "Unknown error"
          }
          const transformed = ProviderTransform.error(ctx.providerID, e)
          if (transformed !== msg) {
            return transformed
          }
          if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
            return msg
          }

          try {
            const body = JSON.parse(e.responseBody)
            // try to extract common error message fields
            const errMsg = body.message || body.error || body.error?.message
            if (errMsg && typeof errMsg === "string") {
              return `${msg}: ${errMsg}`
            }
          } catch {}

          return `${msg}: ${e.responseBody}`
        }).trim()

        const metadata = e.url ? { url: e.url } : undefined
        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: ctx.providerID.startsWith("openai") ? isOpenAiErrorRetryable(e) : e.isRetryable,
            responseHeaders: e.responseHeaders,
            responseBody: e.responseBody,
            metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e })
    }
  }
}
