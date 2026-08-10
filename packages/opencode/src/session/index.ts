import { Slug } from "@opencode-ai/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Identifier } from "../id/id"
import { Installation } from "../installation"

import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { SessionRecent } from "./recent"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Global } from "@/global"
import { SessionPricing } from "./pricing"

export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
  }

  // Per-instance index of every session Info, so list/children answer from
  // memory instead of a full-project glob + one locked file read per session
  // on every call. Populated by the first full scan (loaded flag), then kept
  // current at the three mutation points (createNext, update, remove); get
  // caches opportunistically on a miss. Single-process only — a separate
  // process writing session storage (the import CLI) won't invalidate this,
  // which matches the pre-existing model (no server runs during import).
  const index = Instance.state(() => ({ entries: new Map<string, Info>(), loaded: false }))

  async function load() {
    const state = index()
    if (state.loaded) return state.entries
    const project = Instance.project
    for (const item of await Storage.list(["session", project.id])) {
      const session = await Storage.read<Info>(item).catch(() => undefined)
      if (session) state.entries.set(session.id, session)
    }
    state.loaded = true
    return state.entries
  }

  function indexed(session: Info) {
    index().entries.set(session.id, session)
    return session
  }

  // An allowed tool is either a bare tool id (allowed with any arguments) or a
  // tool id scoped to file-path globs (allowed only when the call's file path
  // matches one of `paths`, denied otherwise). Path scoping applies to the
  // edit-family tools that take a `filePath` arg (edit, write, multiedit).
  // Enforced at execution time in resolveTools; never strips a tool from the
  // request schema, so the prompt-cache prefix stays stable across mode switches.
  export const AllowedTool = z.union([
    z.string(),
    z.object({
      id: z.string(),
      paths: z.string().array(),
    }),
  ])
  export type AllowedTool = z.output<typeof AllowedTool>

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      slug: z.string(),
      projectID: z.string(),
      directory: z.string(),
      parentID: Identifier.schema("session").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      // What every reader renders, whoever set it.
      title: z.string(),
      // The exact text the generator last wrote. Ownership is decided by
      // comparing it to title: equal means the generator's own text is still
      // there and may be replaced, anything else means a rename (or a fork,
      // --title, a subtask description) named this session and the generator
      // must not touch it. Absent alongside a non-default title says the same,
      // which is what protects sessions written before this existed.
      titleGenerated: z.string().optional(),
      // The prompt ordinal the last generation ran at. Together with prompts it
      // makes "generate at the 1st and 3rd prompt" a fact about the session
      // rather than about which turn happened to observe the count, so a
      // stop/resume or a re-entered loop cannot re-fire one.
      titleOrdinal: z.number().optional(),
      // Real user prompts seen, stamped on the message at creation. Counting
      // persisted history instead would shrink at every compaction and count
      // the infrastructure messages (compaction requests, task-result
      // injections) that filterCompacted leaves in place.
      prompts: z.number().optional(),
      version: z.string(),
      branch: z.string().optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
      ping: z
        .object({
          count: z.number(),
          time: z.number(),
          pending: z.boolean().optional(),
        })
        .optional(),
      cache: z
        .object({
          lastRequestAt: z.number(),
        })
        .optional(),
      // Persisted "keep the cache warm" intent. The daemon arms only when this
      // is true; attach/reconnect reconciles the daemon to it but never sets it.
      // Only an explicit act flips it: an organic turn or the arm route set it
      // true, a stop clears it. This is what makes a stop unbeatable by a
      // concurrent client's re-sync — a fetch can no longer resurrect a stopped
      // session because attach reads the intent instead of declaring it.
      keepWarm: z.boolean().optional(),
      unseen: z.boolean().optional(),
      seen: z
        .object({
          at: z.number(),
        })
        .optional(),
      // Timestamp of the last real transcript turn, for recency ordering in the
      // home overview. Stamped from message writes only, so pings (which never
      // persist a message) and session opens never advance it — unlike
      // time.updated, which pings bump.
      lastActivity: z.number().optional(),
      tokens: z
        .object({
          input: z.number(),
          cacheRead: z.number(),
          cacheWrite: z.number(),
          output: z.number(),
          reasoning: z.number(),
          // TTL breakdown of cacheWrite, which stays the combined total. Added
          // after the fact, so sessions written before this default to 0 while
          // their cacheWrite is non-zero: treat cacheWrite as authoritative and
          // these two as a detail that is only present going forward.
          cacheWrite5m: z.number().default(0),
          cacheWrite1h: z.number().default(0),
        })
        .default({
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        }),
      total: z
        .object({
          input: z.number(),
          output: z.number(),
          cacheWrite: z.number(),
        })
        .default({ input: 0, output: 0, cacheWrite: 0 }),
      cost: z.number().default(0),
      cacheMarkers: z.array(z.number()).optional(),
      systemBlockCount: z.number().optional(),
      cacheProbeIndex: z.number().optional(),
      cacheProbeMessageID: z.string().optional(),
      allowedTools: AllowedTool.array().optional(),
      // The MCP catalog block text this session last injected as durable history.
      // Each turn, insertMcpCatalog rebuilds the catalog for this session's
      // instance (servers + `disabled` + tier, all from merged config) and
      // compares: differs -> append a fresh block and store it here; identical ->
      // no-op. This single field is the whole refresh mechanism (no version
      // counter). Absent on pre-feature sessions -> treated as "" -> a non-empty
      // catalog is injected on the next turn (backfill). Reset to "" on compaction
      // so the post-summary turn re-injects (the block is dropped at the summary
      // boundary). Set via Session.update with { touch: false }.
      mcpCatalogText: z.string().optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const ShareInfo = z
    .object({
      secret: z.string(),
      url: z.string(),
    })
    .meta({
      ref: "SessionShare",
    })
  export type ShareInfo = z.output<typeof ShareInfo>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const original = await get(input.sessionID)
      if (!original) throw new Error("session not found")
      const title = getForkedTitle(original.title)
      const session = await createNext({
        directory: Instance.directory,
        title,
      })
      const msgs = await messages({ sessionID: input.sessionID })
      const idMap = new Map<string, string>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = Identifier.ascending("message")
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          await updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
  }) {
    const branch = Instance.project.vcs === "git" ? await Vcs.branch() : undefined
    const result: Info = {
      id: Identifier.descending("session", input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      branch,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      total: { input: 0, output: 0, cacheWrite: 0 },
      cost: 0,
    }
    log.info("created", result)
    await Storage.write(["session", Instance.project.id, result.id], result)
    indexed(result)
    Bus.publish(Event.Created, {
      info: result,
    })
    const cfg = await Config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
      share(result.id)
        .then((share) => {
          update(result.id, (draft) => {
            draft.share = share
          })
        })
        .catch(() => {
          // Silently ignore sharing errors during session creation
        })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode", "plans")
      : path.join(Global.Path.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const cached = index().entries.get(id)
    if (cached) return cached
    const read = await Storage.read<Info>(["session", Instance.project.id, id])
    return indexed(read as Info)
  })

  export const getShare = fn(Identifier.schema("session"), async (id) => {
    return Storage.read<ShareInfo>(["share", id])
  })

  export const share = fn(Identifier.schema("session"), async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)
    await update(
      id,
      (draft) => {
        draft.share = {
          url: share.url,
        }
      },
      { touch: false },
    )
    return share
  })

  export const unshare = fn(Identifier.schema("session"), async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)
    await update(
      id,
      (draft) => {
        draft.share = undefined
      },
      { touch: false },
    )
  })

  export async function update(id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    const project = Instance.project
    // Detect a no-op update: mid-turn callers (cache-marker refresh, ping
    // bookkeeping) frequently run an editor that changes nothing, and each one
    // otherwise re-broadcasts an identical session object to every client. Snapshot
    // before/after and skip the publish when the serialized session is unchanged.
    let changed = true
    const result = await Storage.update<Info>(["session", project.id, id], (draft) => {
      const before = JSON.stringify(draft)
      editor(draft)
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
      changed = JSON.stringify(draft) !== before
    })
    indexed(result)
    // An archived session leaves the overview; eviction is idempotent, so
    // evicting on any archived update (not just the transition) is harmless.
    if (result.time.archived) void SessionRecent.remove(id)
    // A rename (or auto-title) must reach the overview, which reads the recent
    // entry's title — session.updated only refreshes the open session's view.
    // setTitle no-ops when unchanged, so calling it on every update is cheap.
    else void SessionRecent.setTitle(id, result.title)
    if (changed)
      Bus.publish(Event.Updated, {
        info: result,
      })
    return result
  }

  export function markUnseen(id: string) {
    void SessionRecent.setUnseen(id, true)
    return update(id, (session) => (session.unseen = true), { touch: false })
  }

  export function markSeen(id: string) {
    void SessionRecent.setUnseen(id, false)
    // Opening the session is the acknowledgement: the failure is on screen.
    void SessionRecent.setError(id, false)
    return update(
      id,
      (session) => {
        session.unseen = false
        session.seen = { at: Date.now() }
      },
      { touch: false },
    )
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
      // when true (default), stop at the most recent completed compaction
      // boundary — pre-compaction messages are the model's dropped context and
      // are never serialized. Pass false to page into pre-compaction history.
      compacted: z.boolean().optional(),
      // Reconnect delta: return only messages newer than this id. Message ids
      // are monotonic, so the newest-first stream can stop the moment it reaches
      // one at or below the cursor. A resuming client passes its last-known id
      // to heal the disconnect gap without re-fetching the whole window.
      after: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const compacted = input.compacted ?? true
      const result = [] as MessageV2.WithParts[]
      const completed = new Set<string>()
      // MessageV2.stream yields newest-first; mirror MessageV2.filterCompacted
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit !== undefined && result.length >= input.limit) break
        if (input.after && msg.info.id <= input.after) break
        result.push(msg)
        if (
          compacted &&
          msg.info.role === "user" &&
          completed.has(msg.info.id) &&
          msg.parts.some((part) => part.type === "compaction")
        )
          break
        if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) completed.add(msg.info.parentID)
      }
      result.reverse()
      return result
    },
  )

  export async function* list() {
    const entries = await load()
    for (const session of [...entries.values()].sort((a, b) => (a.id > b.id ? 1 : -1))) {
      yield session
    }
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const entries = await load()
    return [...entries.values()].filter((session) => session.parentID === parentID)
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    const project = Instance.project
    try {
      const session = await get(sessionID)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      await unshare(sessionID).catch(() => {})
      for (const msg of await Storage.list(["message", sessionID])) {
        for (const part of await Storage.list(["part", msg.at(-1)!])) {
          await Storage.remove(part)
        }
        await Storage.remove(msg)
      }
      await Storage.remove(["session", project.id, sessionID])
      index().entries.delete(sessionID)
      void SessionRecent.remove(sessionID)
      Bus.publish(Event.Deleted, {
        info: session,
      })
    } catch (e) {
      log.error(e)
    }
  })

  // Last wire form broadcast per message, so a re-save that changed nothing
  // (step bookkeeping re-persists the same assistant message many times per
  // turn) skips the broadcast. FIFO-capped so it can't grow with history.
  const broadcasted = new Map<string, string>()
  const BROADCASTED_CAP = 1000

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    await Storage.write(["message", msg.sessionID, msg.id], msg)
    MessageV2.uncache(msg.id)
    // A message write is the only real-turn signal (pings never persist a
    // message). Stamp lastActivity with touch:false so it doesn't bump
    // time.updated; the guard keeps it to one write once the timestamp settles
    // (streaming chunks share a created time until completed lands). The same
    // signal feeds the recent-session LRU the overview reads.
    const at = ("completed" in msg.time ? msg.time.completed : undefined) ?? msg.time.created
    const session = await update(
      msg.sessionID,
      (draft) => {
        if (!draft.lastActivity || at > draft.lastActivity) draft.lastActivity = at
      },
      { touch: false },
    ).catch(() => undefined)
    if (session && !session.parentID)
      void SessionRecent.touch({
        sessionID: session.id,
        directory: session.directory,
        title: session.title,
        agent: "agent" in msg ? msg.agent : undefined,
        updated: session.lastActivity ?? at,
      })
    const wire = JSON.stringify(msg)
    if (broadcasted.get(msg.id) !== wire) {
      broadcasted.delete(msg.id)
      broadcasted.set(msg.id, wire)
      if (broadcasted.size > BROADCASTED_CAP) broadcasted.delete(broadcasted.keys().next().value!)
      Bus.publish(MessageV2.Event.Updated, {
        info: msg,
      })
    }
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await Storage.remove(["message", input.sessionID, input.messageID])
      MessageV2.uncache(input.messageID)
      broadcasted.delete(input.messageID)
      Bus.publish(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await Storage.remove(["part", input.messageID, input.partID])
      MessageV2.uncache(input.messageID)
      Bus.publish(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    MessageV2.Part,
    z.object({
      part: MessageV2.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ReasoningPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ToolPart,
      delta: z.string(),
    }),
  ])

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined
    await Storage.write(["part", part.messageID, part.id], part)
    MessageV2.uncache(part.messageID)
    // Publish the full accumulated part to the in-process bus so every consumer
    // (TUI, share sync) sees real text. The O(n^2)-on-the-wire cost of resending
    // the growing text is a WEB-SSE concern only, so the blanking lives at that
    // serialization boundary (routes/global.ts), where the delta rides alongside
    // for the web client to append. Consumers that ignore the delta still get
    // whole text here.
    Bus.publish(MessageV2.Event.PartUpdated, {
      part,
      delta,
    })
    return part
  })

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const cacheReadInputTokens = input.usage.cachedInputTokens ?? 0
      const cacheWriteInputTokens = (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0) as number

      // Anthropic bills cache writes by TTL: 1h at 2x base input, 5m at 1.25x.
      // The provider only exposes the flattened cacheCreationInputTokens, but its
      // usage schemas are z.looseObject and it forwards the whole raw usage body
      // as providerMetadata.anthropic.usage, so the per-TTL breakdown rides along
      // untouched. Read it from there.
      //
      // ON SDK UPGRADE: re-check this. It holds only while (a) the usage schemas
      // stay looseObject (a switch to strictObject would drop cache_creation) and
      // (b) the raw usage body is still forwarded verbatim on BOTH paths, i.e.
      // `usage: response.usage` when not streaming and `rawUsage = {...value.message.usage}`
      // for message_start / message_delta. If either changes, this silently falls
      // back to the blended write rate below, which under-bills 1h writes. Verify
      // with a request carrying a 1h cache_control marker and assert the split is
      // present. No version through 4.0.20 exposes these as typed fields, so
      // upgrading is not a fix; patching the schema would be the fallback.
      const cacheCreation = (
        input.metadata?.["anthropic"]?.["usage"] as
          | { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }
          | undefined
      )?.cache_creation
      const cacheWrite5m = cacheCreation?.ephemeral_5m_input_tokens
      const cacheWrite1h = cacheCreation?.ephemeral_1h_input_tokens

      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = excludesCachedTokens
        ? (input.usage.inputTokens ?? 0)
        : (input.usage.inputTokens ?? 0) - cacheReadInputTokens - cacheWriteInputTokens
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }

      const tokens = {
        input: safe(adjustedInputTokens),
        output: safe(input.usage.outputTokens ?? 0),
        reasoning: safe(input.usage?.reasoningTokens ?? 0),
        cache: {
          write: safe(cacheWriteInputTokens),
          read: safe(cacheReadInputTokens),
          // Absent when the provider sends no breakdown (non-Anthropic, or the
          // passthrough above stopped working). Pricing treats undefined as
          // "unknown split" and falls back to the blended write rate.
          write5m: cacheWrite5m === undefined ? undefined : safe(cacheWrite5m),
          write1h: cacheWrite1h === undefined ? undefined : safe(cacheWrite1h),
        },
      }

      // Cost is resolved by SessionPricing, which both the per-message cost and
      // the running session total call, so the two can never disagree. It needs
      // config (for the price overrides), hence the await at the call sites.
      return {
        cost: SessionPricing.cost(input.model, tokens),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
