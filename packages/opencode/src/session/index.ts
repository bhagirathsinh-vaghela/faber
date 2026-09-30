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
import { Parts } from "../storage/parts"
import { Messages } from "../storage/messages"
import { Sessions } from "../storage/sessions"
import { Debt } from "../storage/debt"
import { Db } from "../storage/db"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { SessionRecent } from "./recent"
import { SessionBusy } from "./busy"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"

import { Provider } from "@/provider/provider"
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

  // A session a person reads: a root, not a subagent and not a headless agent
  // run. Keep-warm pings, titles, reminders, the recent list, and sharing are
  // for these only.
  export function attended(session: { parentID?: string; ephemeral?: boolean }) {
    return !session.parentID && !session.ephemeral
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
    for (const session of await Sessions.listProject(Instance.project.id)) {
      state.entries.set(session.id, session)
    }
    state.loaded = true
    return state.entries
  }

  // Index only a session in this instance's project. A cross-project read (a
  // Stop walking a child in another directory) must not leak a foreign row into
  // this index, which backs Session.list and children.
  function indexed(session: Info) {
    if (session.projectID === Instance.project.id) index().entries.set(session.id, session)
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
      // The peer that spawned this session, and the directory that peer resolves
      // under. Read only for parameter inheritance: a spawned helper runs as its
      // spawner, so `current` is seeded from the spawner at create time under
      // `directory`, falling through to the model and variant the spawner
      // last used.
      spawn: z
        .object({
          parent: Identifier.schema("session"),
          directory: z.string(),
          at: z.number(),
        })
        .optional(),
      // The per-turn parameters the session runs as: the persistent
      // source of truth read to stamp every message, real or synthetic. A client
      // override (a dock pick) writes it; a message with no override reads it.
      // Seeded from the spawner at create for a spawned session, else established
      // by the first send.
      current: z
        .object({
          agent: z.string().optional(),
          model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
          variant: z.string().optional(),
        })
        .optional(),
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
      // --title, a subagent description) named this session and the generator
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
      // the infrastructure messages (compaction requests, subagent-result
      // injections) that filterCompacted leaves in place.
      prompts: z.number().optional(),
      version: z.string(),
      branch: z.string().optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
        // When this session's turn was last cut by a person: Session.stop
        // (Stop, archive, delete, or a stop of an ancestor) and
        // Session.interrupt (Esc). Recovery leaves a turn that started before
        // it unresumed, and wakes only for a message written after it; a Stop
        // restamps it past the notices it paid, so none of them wakes the
        // session. Keep-warm reads `keepWarm`, not this.
        stopped: z.number().optional(),
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
      // Present while a turn is running, written by the process running it and
      // cleared when the turn ends by any path that process sees. A marker whose
      // process is gone is a turn a crash or restart cut, which recovery
      // resumes. `resumes` counts continue prompts sent since a step last
      // finished; recovery gives up at its cap.
      turn: z
        .object({
          at: z.number(),
          pid: z.number(),
          boot: z.number().optional(),
          resumes: z.number().optional(),
          // Unique per turn, so a turn unwinding clears only its own marker
          // even when the next one started in the same millisecond.
          nonce: z.string().optional(),
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
      // The date and branch the session has told the model about. The frozen
      // session-context block states them once and precedes the whole
      // conversation, so it can never be rewritten to correct them; a later
      // value is announced by a fresh block at the tail instead, and these
      // record what was last announced. Absent on pre-feature sessions ->
      // seeded from the frozen block on the next turn, announcing nothing.
      contextDate: z.string().optional(),
      contextBranch: z.string().optional(),
      // Names of loaded skills that declare a `reminder:` block and are still
      // considered active. Written by SkillTool.execute on load; cleared by
      // insertReminders once the model's SKILL-DONE-style exit line checks out
      // against Coverage.state. NOT reset on compaction: filterCompacted drops the
      // assistant message carrying the skill's tool part, so a history scan
      // alone goes blind across a compaction boundary, and this flag is what
      // lets the reminder survive it.
      activeSkills: z.string().array().optional(),
      // Content fingerprints (Coverage.fingerprint): `asked` is the parent's
      // when this child was last prompted, copied onto its result; `loaded` is
      // this session's when a reminder skill was last loaded.
      asked: z.string().optional(),
      loaded: z.string().optional(),
      // A headless agent run: no parent, no human, removed when the run ends.
      // Skips everything a subagent skips (pings, title, reminders) plus the
      // diff summary, snapshots, and the recent list.
      ephemeral: z.boolean().optional(),
      // Leave out global/project instructions, MCP tools, and skills, so the
      // run gets the agent's own prompt and built-in tools only.
      bare: z.boolean().optional(),
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
        // Set on the one update that set or cleared time.archived, so a client
        // counts the session out of or back into its list exactly once; any
        // other update to an archived session (seen, rename) carries neither.
        archived: z.boolean().optional(),
        unarchived: z.boolean().optional(),
      }),
    ),
    // The per-step token/cost refresh fires many times a turn (once per
    // step, plus once on the parent of a subagent). Broadcasting the whole ~2.5KB
    // Info each time is the session stream's dominant recurring cost, and the SSE
    // stream is uncompressed by design (compressing text/event-stream buffers and
    // breaks flush). This carries ONLY the aggregates that change on that path.
    // The values are absolute, not deltas, so a dropped event self-heals on the
    // next one (no base-state to desync, unlike a JSON Patch). Live per-step
    // token counts already reach the client on the assistant message via
    // message.updated; this covers the session-lifetime total/cost the
    // record uniquely holds.
    TotalsUpdated: BusEvent.define(
      "session.totals-updated",
      z.object({
        sessionID: z.string(),
        total: Info.shape.total,
        cost: Info.shape.cost,
      }),
    ),
    // The per-step cache-anchor refresh (dispatch time + cache markers + system
    // block count) also fires once per step, so it has the same full-record cost
    // as the token path and gets the same lean treatment. Only the TUI reads
    // these fields (cache.lastRequestAt for its countdown, cacheMarkers for its
    // debug line); the web dock reads its countdown from the ping hub instead, so
    // the web client can ignore this event entirely while the TUI applies it.
    CacheUpdated: BusEvent.define(
      "session.cache-updated",
      z.object({
        sessionID: z.string(),
        cache: Info.shape.cache,
        cacheMarkers: Info.shape.cacheMarkers,
        systemBlockCount: Info.shape.systemBlockCount,
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
    // A person stopped, archived, or deleted the session; clients play the stop
    // sound on it. A stop the server makes for itself (a headless run ending)
    // is not announced.
    Stopped: BusEvent.define(
      "session.stopped",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
        // The peer this session is being created FOR, which is owed its
        // result. Taken at creation rather than stamped afterwards, so a
        // helper cannot exist for even one turn without the link that gets its
        // answer home.
        spawnedBy: Identifier.schema("session").optional(),
        // Where that peer lives, when it is not this project. Defaults to the
        // helper's own directory, which is right for the common case of a peer
        // spawned alongside its spawner.
        spawnedFrom: z.string().optional(),
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
        spawnedBy: input?.spawnedBy,
        spawnedFrom: input?.spawnedFrom,
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
        current: original.current,
      })
      await copy(input.sessionID, session.id, input.messageID)
      return session
    },
  )

  // Copy `from`'s transcript into `to` under fresh ids, keeping each reply
  // linked to its copied request; stops before `until` when given. The one
  // copy every fork and every context hand-off uses.
  export async function copy(from: string, to: string, until?: string) {
    const ids = new Map<string, string>()
    for (const msg of await messages({ sessionID: from })) {
      if (until && msg.info.id >= until) break
      const id = Identifier.ascending("message")
      ids.set(msg.info.id, id)
      const parentID = msg.info.role === "assistant" && msg.info.parentID ? ids.get(msg.info.parentID) : undefined
      await updateMessage({ ...msg.info, sessionID: to, id, ...(parentID && { parentID }) })
      for (const part of msg.parts)
        await updatePart({ ...part, id: Identifier.ascending("part"), messageID: id, sessionID: to })
    }
  }

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
    spawnedBy?: string
    // The spawner's own directory, when it differs from the helper's. The debt
    // resolves the parent under this, so a helper working in another project
    // still reports home.
    spawnedFrom?: string
    // Established parameters to seed onto the new session (a fork carries the
    // original's, so its first no-override send continues on the same agent/
    // model/variant instead of snapping to the default). The spawn seed below
    // takes precedence when both apply.
    current?: Info["current"]
    ephemeral?: boolean
    bare?: boolean
  }) {
    const branch = Instance.project.vcs === "git" ? await Vcs.branch() : undefined
    // A spawned helper runs as its spawner, so it starts from the spawner's
    // current parameters. Resolved under the spawner's directory, since the
    // parent record lives in the spawner's project.
    const seeded =
      input.spawnedBy &&
      (await Instance.provide({
        directory: input.spawnedFrom ?? input.directory,
        fn: () => get(input.spawnedBy!).then((x) => x.current),
      }).catch(() => undefined))
    const result: Info = {
      id: Identifier.descending("session", input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      ...((seeded || input.current) && { current: seeded || input.current }),
      // The link to the spawner, kept so a later reader can trace the origin.
      // `directory` is the PARENT's, since a session resolves under its own
      // project; the helper's own directory would miss whenever the two differ.
      ...(input.spawnedBy && {
        spawn: {
          parent: input.spawnedBy,
          directory: input.spawnedFrom ?? input.directory,
          at: Date.now(),
        },
      }),
      branch,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      total: { input: 0, output: 0, cacheWrite: 0 },
      cost: 0,
      ...(input.ephemeral && { ephemeral: true }),
      ...(input.bare && { bare: true }),
    }
    log.info("created", result)
    await Sessions.write(result)
    indexed(result)
    Bus.publish(Event.Created, {
      info: result,
    })
    const cfg = await Config.get()
    if (attended(result) && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
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
    return indexed(await Sessions.read(id))
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
    // Detect a no-op update: mid-turn callers (cache-marker refresh, ping
    // bookkeeping) frequently run an editor that changes nothing, and each one
    // otherwise re-broadcasts an identical session object to every client. Snapshot
    // before/after and skip the publish when the serialized session is unchanged.
    let changed = true
    let unarchived = false
    let archived = false
    let updated = 0
    const result = await Sessions.update(id, (draft) => {
      const before = JSON.stringify(draft)
      const was = !!draft.time.archived
      updated = draft.time.updated
      editor(draft)
      unarchived = was && !draft.time.archived
      archived = !was && !!draft.time.archived
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
      changed = JSON.stringify(draft) !== before
    })
    indexed(result)
    // An archived session leaves the overview; eviction is idempotent, so
    // evicting on any archived update (not just the transition) is harmless.
    if (result.time.archived) void SessionRecent.remove(id)
    // Archiving evicted the entry and only a real turn re-adds one, so an
    // unarchive restores it at its last-activity slot rather than the front.
    else if (unarchived && !result.parentID) {
      // Busy and job flips made while it was archived had no entry to land on,
      // so the restored entry reads them from their sources. The fallback slot
      // is time.updated as read before the edit, which a touching update would
      // bump. An armed ping re-publishes its deadline onto the new entry.
      const { SessionPing } = await import("./ping")
      const counts = await SessionBusy.debts(result.id, result)
      const archivedNow = await Sessions.archivedReader()
      await SessionRecent.restore({
        sessionID: result.id,
        directory: result.directory,
        title: result.title,
        updated: result.lastActivity ?? updated,
        unseen: result.unseen === true,
        flags: () => ({ turn: SessionBusy.busy(result.id), ...counts }),
        still: () => !archivedNow(result.id),
      })
      // The counts were read before restore's awaits; a debt written since
      // re-sends the facts from their sources.
      void SessionBusy.push(result.id)
      void SessionPing.refresh(result.id)
    }
    // A rename (or auto-title) must reach the overview, which reads the recent
    // entry's title — session.updated only refreshes the open session's view.
    // setTitle no-ops when unchanged, so calling it on every update is cheap.
    else void SessionRecent.setTitle(id, result.title)
    if (changed)
      Bus.publish(Event.Updated, {
        info: result,
        ...(unarchived ? { unarchived: true } : {}),
        ...(archived ? { archived: true } : {}),
      })
    return result
  }

  // The per-step token/cost refresh. Persists the record (still the source
  // of truth) but broadcasts the lean TotalsUpdated event instead of the full
  // ~2.5KB session.updated, since this runs many times a turn on an uncompressed
  // SSE stream. Writes through the storage layer directly (no time.updated bump);
  // the sidebar sorts on time.updated but pins a busy session to the top for the
  // turn, so a totals refresh does not need to re-bump it. No no-op guard: every
  // caller here has real new numbers, and the aggregates are small enough that a
  // serialize-to-diff would cost more than it saves.
  export async function updateTotals(id: string, editor: (session: Info) => void) {
    const session = await Sessions.update(id, editor)
    indexed(session)
    Bus.publish(Event.TotalsUpdated, {
      sessionID: id,
      total: session.total,
      cost: session.cost,
    })
    return session
  }

  // Re-read a record written outside this module (inside a caller's own
  // transaction), so the per-instance index does not serve the stale copy.
  export async function reload(id: string) {
    return indexed(await Sessions.read(id))
  }

  // A write no client renders (the turn marker), so it persists and re-indexes
  // without broadcasting the record.
  export async function mark(id: string, editor: (session: Info) => void) {
    return indexed(await Sessions.update(id, editor))
  }

  // Lean cache-anchor refresh, the CacheUpdated counterpart to updateTotals.
  // This write intentionally does NOT bump time.updated.
  export async function updateCache(id: string, editor: (session: Info) => void) {
    const session = await Sessions.update(id, editor)
    indexed(session)
    Bus.publish(Event.CacheUpdated, {
      sessionID: id,
      cache: session.cache,
      cacheMarkers: session.cacheMarkers,
      systemBlockCount: session.systemBlockCount,
    })
    return session
  }

  // Record an agent switch (plan_enter/plan_exit) on the session's established
  // parameters. The switch mints a user message carrying the new agent, but a
  // later synthetic mint reads current, not that message, so without this a
  // delivered result after the switch would run under the pre-switch agent.
  // Only the agent changes; model/variant carry across the switch.
  // A session with no current yet has nothing to switch — the next real send
  // establishes it.
  export function setAgent(id: string, agent: string) {
    return update(id, (draft) => void (draft.current && (draft.current.agent = agent)), { touch: false })
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
      // Reconnect delta: return only messages newer than this id. A resuming
      // client passes its last-known id to heal the disconnect gap without
      // re-fetching the whole window.
      after: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const compacted = input.compacted ?? true
      const after = input.after
      const result = [] as MessageV2.WithParts[]
      const completed = new Set<string>()
      // MessageV2.stream yields newest-first; mirror MessageV2.filterCompacted
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit !== undefined && result.length >= input.limit) break
        if (after !== undefined && Identifier.compare(msg.info.id, after) <= 0) break
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

  // Stopping a session: the one implementation, behind the Stop button, the
  // overview's stop, archive, and delete. A stop is a person's decision and
  // ends the whole subtree: every session in it is stamped (`time.stopped`,
  // which keeps recovery from resuming its turn), disarmed, cancelled, has its
  // jobs killed, and has everything it is owed and owes paid as stopped.
  //
  // Every session in the subtree is stamped, disarmed and cancelled before any
  // is settled, so no loop still running can re-steer a child or launch while
  // the rest is paid. Settling runs deepest level first and the stopped
  // session last, so a session's responders have paid their notices into it
  // before it pays its own caller. Every notice is written without waking
  // anyone, except the stopped session's own report to its caller above the
  // subtree. A session's stamp is then moved past its newest message, so none
  // of the notices it just received reads as unanswered and wakes it on the
  // next pass.
  //
  // Disarm precedes cancel: cancel() runs on every loop exit, so it must not
  // be what disarms.
  export const stop = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      // Set by the routes a person drives (Stop, archive, delete) to publish
      // `Event.Stopped` once for the session they named, not its subtree.
      announce: z.boolean().optional(),
    }),
    async (input) => {
      const { SessionPing } = await import("./ping")
      const { SessionPin } = await import("./pin")
      const { BackgroundJob } = await import("@/background/job")
      const { Recovery } = await import("./recovery")
      // Every step runs whatever an earlier one threw, so a session whose
      // stamp failed (a busy database) still has its subtree walked and its
      // turn cancelled; the first failure is reported once everything else is
      // stopped. A session deleted meanwhile (a launch dropping the child it
      // just made) has nothing left to stop, so its missing row is no failure.
      const failures: unknown[] = []
      const attempt = <T>(step: () => Promise<T> | T, fallback: T) =>
        Promise.resolve()
          .then(step)
          .catch((error: unknown) => {
            if (!Storage.NotFoundError.isInstance(error)) failures.push(error)
            return fallback
          })
      // Read the subtree from the database (a child another process made is in
      // no per-process index yet, and a Stop must reach it), level by level,
      // with a seen set so a parentID cycle cannot loop. Each session's own
      // directory is carried so a cross-directory turn can be cancelled in the
      // instance that runs it (see `inChildDir`).
      const { InstanceBootstrap } = await import("@/project/bootstrap")
      // Run `step` in a child's own instance, for the one fact that is
      // instance-scoped: an in-flight turn's AbortController lives in
      // SessionPrompt's per-directory state, so cancelling a child whose turn
      // runs in another directory must enter that directory. A directory that
      // cannot be entered falls back to the caller's context — its id-keyed
      // cleanup still lands, and the stamp already keeps recovery from resuming
      // the turn, so an unenterable directory is not itself a Stop failure.
      // Every other step is keyed by session id or held in a module-global map,
      // so it is correct in the caller's context and needs no per-child instance.
      const inChildDir = <T>(dir: string, step: () => Promise<T> | T) =>
        attempt(
          () => Instance.provide({ directory: dir, init: InstanceBootstrap, fn: step }).catch(() => step()),
          undefined,
        )
      const seen = new Set<string>()
      const levels: Session.Info[][] = []
      for (let level = [await get(input.sessionID)]; level.length > 0; ) {
        for (const s of level) seen.add(s.id)
        levels.push(level)
        const belowIds = (
          await Promise.all(level.map((s) => attempt(() => Sessions.children(s.id), [] as string[])))
        ).flat()
        const below = await Promise.all(
          belowIds.filter((id) => !seen.has(id)).map((id) => attempt(() => get(id), undefined)),
        )
        level = below.filter((s): s is Session.Info => s !== undefined)
      }
      const read = await Messages.reader()
      const halt = async (s: Session.Info) => {
        await attempt(
          () => update(s.id, (draft) => void (draft.time.stopped = Date.now()), { touch: false }),
          undefined,
        )
        await attempt(() => SessionPing.stop(s.id), undefined)
        await attempt(() => SessionPin.drop(s.id), undefined)
        // The only step that reads instance-scoped state: the turn's abort
        // handle lives in the child's directory, so cancelling a cross-directory
        // turn must enter it.
        await inChildDir(s.directory, () => SessionPrompt.cancel(s.id, SessionPrompt.STOPPED))
      }
      const settle = async (s: Session.Info) => {
        await attempt(() => BackgroundJob.stopSession(s.id), undefined)
        // Recovery.stopped enters each debt's own caller directory itself, so it
        // runs here in the caller's context, not wrapped in the child's: a job
        // notice into a child whose directory cannot be entered fails on its own
        // while the child's report to its live parent, entered separately, lands.
        await attempt(() => Recovery.stopped(s.id, { wake: s.id === input.sessionID }), undefined)
        await attempt(
          () =>
            update(
              s.id,
              (draft) => void (draft.time.stopped = Math.max(Date.now(), read.newest(s.id)?.time.created ?? 0)),
              { touch: false },
            ),
          undefined,
        )
        await attempt(() => SessionBusy.push(s.id), undefined)
      }
      const subtree = levels.flat()
      Recovery.hold(subtree.map((s) => s.id))
      await Promise.all(subtree.map(halt))
        .then(async () => {
          for (const level of levels.toReversed()) await Promise.all(level.map(settle))
        })
        .finally(() => Recovery.release(subtree.map((s) => s.id)))
      if (input.announce) Bus.publish(Event.Stopped, { sessionID: input.sessionID })
      if (failures.length > 0) throw failures[0]
    },
  )

  // The dock's Esc: this session's turn only, so recovery does not resume it.
  // The keep-warm daemon, the pin, the jobs, the subagents, and every debt are
  // left as they were.
  export const interrupt = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => void (draft.time.stopped = Date.now()), { touch: false })
    SessionPrompt.cancel(sessionID)
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    const project = Instance.project
    try {
      const session = await get(sessionID)
      // Read children from the database, like Session.stop: a child another
      // process or project made is in no per-process index, and a delete must
      // reach it too.
      for (const child of await Sessions.children(sessionID)) {
        await remove(child)
      }
      await unshare(sessionID).catch(() => {})
      // Drop the whole session (parts, messages, the session row) in ONE
      // transaction, so a crash between the levels cannot leave orphan parts or a
      // session row with no transcript.
      const [parts, messages, session_] = await Promise.all([
        Parts.removeSessionQuery(),
        Messages.removeSessionQuery(),
        Sessions.removeQuery(),
      ])
      await Db.transaction(() => {
        parts.run(sessionID)
        messages.run(sessionID)
        session_.run(sessionID)
      })
      index().entries.delete(sessionID)
      await Debt.drop(sessionID)
      if (session.parentID) await SessionBusy.push(session.parentID)
      void SessionRecent.remove(sessionID)
      Bus.publish(Event.Deleted, {
        info: session,
      })
    } catch (e) {
      // A delete that fails must surface, not report success by swallowing. The
      // three-level row delete is one transaction, so a throw at or before it
      // leaves the session's rows wholly intact. The index/recent/event steps run
      // AFTER the commit; a throw there (a synchronous Deleted subscriber) rethrows
      // with the rows already gone, so a surfaced error does not by itself prove
      // the session survived. A partway TREE failure (a child throws) can leave
      // earlier children deleted and later ones plus the parent intact; each
      // deleted child is itself whole, so this is a recoverable partial, not a
      // source of orphan rows.
      log.error(e)
      throw e
    }
  })

  // Last wire form broadcast per message, so a re-save that changed nothing
  // (step bookkeeping re-persists the same assistant message many times per
  // turn) skips the broadcast. FIFO-capped so it can't grow with history.
  const broadcasted = new Map<string, string>()
  const BROADCASTED_CAP = 1000

  // Only the turn that ran a message may end it, so a writer holding a copy read
  // before it ended must not carry that copy's blank terminal fields to disk.
  // `finish` is what the prompt loop reads to know a turn is answered; unsetting
  // it makes a finished turn look pending, and the retry appends a second
  // assistant block to a transcript already ending in one, which Anthropic
  // rejects with a 400.
  function preserveTerminal(incoming: MessageV2.Info, stored: MessageV2.Info | undefined): MessageV2.Info {
    if (!stored || stored.role !== "assistant" || incoming.role !== "assistant") return incoming
    if (incoming.finish || incoming.error) return incoming
    if (!stored.finish && !stored.error && !stored.time.completed) return incoming
    return {
      ...incoming,
      finish: stored.finish,
      error: stored.error,
      time: { ...incoming.time, completed: stored.time.completed },
    }
  }

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    msg = await Messages.reconcile(msg.id, (stored) => preserveTerminal(msg, stored))
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
    // An archived session stays out of the overview even when a late write lands
    // on it (the final message of a turn cancelled by stop-and-archive, for one).
    if (session && attended(session) && !session.time.archived)
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

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await Parts.remove(input.messageID, input.partID)
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
    await Parts.put(part)
    publishPart(part, delta)
    return part
  })

  // The live-only half of updatePart: broadcast the accumulated part (with its
  // delta) without persisting. Level 2 streaming publishes every delta this way
  // so the UI streams in real time, then persists ONCE via updatePart at
  // block-end — a text/reasoning part that streamed over hundreds of deltas
  // costs one DB write instead of one per delta.
  export function publishPart(part: MessageV2.Part, delta?: string) {
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
  }

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
        model: Provider.INHERIT,
        variant: Provider.INHERIT,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
