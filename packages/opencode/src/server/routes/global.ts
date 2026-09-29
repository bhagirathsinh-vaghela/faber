import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import os from "os"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus, GlobalInterest } from "@/bus/global"
import { EventReplay, blankStreamedText } from "@/bus/replay"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { OpenProjects } from "../../project/open"
import { LSP } from "../../lsp"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { SessionPing } from "../../session/ping"
import { SessionRecent } from "../../session/recent"
import { Session } from "../../session"
import { Sessions } from "../../storage/sessions"
import { SessionBusy } from "../../session/busy"
import { Debt } from "../../storage/debt"
import { Event as ServerEvent } from "../event"
import { HEARTBEAT_MS } from "@opencode-ai/util/stream"
import { errors } from "../error"
import { Web } from "../web"

const log = Log.create({ service: "server" })

// The /global/event busy heal tick's period, and a hook called after each
// heal a connection completes, so a test can count ticks instead of sleeping.
export namespace BusyHeal {
  const tick = Number(process.env.OPENCODE_BUSY_TICK_MS)
  let period = Number.isFinite(tick) && tick > 0 ? tick : 5000
  const listeners = new Set<(connectionID: string | undefined) => void>()

  export function interval() {
    return period
  }

  // Applies to connections opened after the call.
  export function set(ms: number) {
    period = ms
  }

  export function onTick(listener: (connectionID: string | undefined) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  export function ticked(connectionID: string | undefined) {
    for (const listener of listeners) listener(connectionID)
  }
}

const host = os.hostname()


export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string(), host: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION, host })
      },
    )
    .get(
      "/ping/armed",
      describeRoute({
        summary: "Get armed ping daemons",
        description:
          "Every armed cache-ping daemon across all directories on this instance, enriched with the countdown inputs so the home overview can render active sessions without bootstrapping each directory.",
        operationId: "global.pingArmed",
        responses: {
          200: {
            description: "Armed sessions",
            content: {
              "application/json": {
                schema: resolver(z.array(SessionPing.Armed)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        return c.json(await SessionPing.listArmed())
      },
    )
    .get(
      "/recent",
      describeRoute({
        summary: "Get recent sessions",
        description:
          "The recent-session LRU: root sessions touched by a real turn, ordered by last activity. Server-owned and in-memory, so every web client renders the same overview without scanning the session store.",
        operationId: "global.recent",
        responses: {
          200: {
            description: "Recent sessions",
            content: {
              "application/json": {
                schema: resolver(z.array(SessionRecent.Entry)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        return c.json(await SessionRecent.list())
      },
    )
    .get(
      "/archived",
      describeRoute({
        summary: "Get archived sessions",
        description:
          "Archived root sessions across every project, most recently archived first. Not scoped by directory: each record carries its own.",
        operationId: "global.archived",
        responses: {
          200: {
            description: "Archived sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Sessions.listArchived())
      },
    )
    .get(
      "/projects/open",
      describeRoute({
        summary: "Get open projects",
        description:
          "The server-owned set of projects shown in every client's sidebar. All clients connected to this server render the same set.",
        operationId: "global.projects.open",
        responses: {
          200: {
            description: "Open projects",
            content: {
              "application/json": {
                schema: resolver(z.array(OpenProjects.Entry)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await OpenProjects.list())
      },
    )
    .post(
      "/projects/open",
      describeRoute({
        summary: "Open a project",
        description:
          "Add a project (resolved from a directory to its git root) to the shared sidebar set. Idempotent; broadcast to all clients over SSE.",
        operationId: "global.projects.openAdd",
        responses: {
          200: {
            description: "Opened project",
            content: {
              "application/json": {
                schema: resolver(OpenProjects.Entry),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ directory: z.string() })),
      async (c) => {
        const { project } = await Project.fromDirectory(c.req.valid("json").directory)
        const entry = { id: project.id, worktree: project.worktree }
        await OpenProjects.open(entry)
        return c.json(entry)
      },
    )
    .post(
      "/projects/close",
      describeRoute({
        summary: "Close a project",
        description:
          "Remove a project from the shared sidebar set (broadcast to all clients). A pure view unlink: it disposes nothing and never touches live sessions. A session's instance is torn down only when its own live count reaches zero (Liveness auto-dispose), so a busy or ping-armed session keeps running after its project is closed.",
        operationId: "global.projects.close",
        responses: {
          200: {
            description: "Closed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ directory: z.string() })),
      async (c) => {
        const { project } = await Project.fromDirectory(c.req.valid("json").directory)
        await OpenProjects.close(project.id)
        await LSP.shutdownProject(project.id)
        return c.json(true)
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      // Monotonic frame id. A client stores the newest one it
                      // processed and sends it back as Last-Event-ID to resume.
                      id: z.number().optional(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      validator("query", z.object({ connectionID: z.string().optional() })),
      async (c) => {
        // The client passes a stable connectionID so it can later scope this
        // stream to the sessions its screen needs (POST /global/subscribe).
        // Absent/unregistered = fail-open (receives everything).
        const connectionID = c.req.valid("query").connectionID
        // SSE resume. A reconnecting client sends back the id of the last frame
        // it processed; anything published since is handed over before live
        // traffic resumes, so a disconnect stops being a hole in the transcript.
        // Parsed strictly: a blank or malformed header must be a miss, not a
        // cursor of zero, which would replay the whole buffer to anyone who
        // sends one.
        const cursorHeader = c.req.header("last-event-id") ?? c.req.query("lastEventID") ?? ""
        const [epoch, offset] = cursorHeader.split(":")
        const parsed = Number(offset)
        const resumeFrom = offset !== undefined && offset !== "" && Number.isSafeInteger(parsed) ? parsed : undefined
        log.info("global event connected", { connectionID, resumeFrom })
        return streamSSE(c, async (stream) => {
          let heartbeat: ReturnType<typeof setInterval> | undefined
          let busyTick: ReturnType<typeof setInterval> | undefined
          let finish: (() => void) | undefined
          let torn = false
          const teardown = () => {
            if (torn) return
            torn = true
            if (heartbeat) clearInterval(heartbeat)
            if (busyTick) clearInterval(busyTick)
            GlobalBus.off("event", handler)
            if (connectionID) GlobalInterest.clear(connectionID)
            finish?.()
            stream.close().catch(() => {})
          }

          // A write that never settles means the client stopped draining (a
          // backgrounded tab whose receive buffer filled). Left unbounded, its
          // events queue in server memory until the OS finally drops the socket.
          // Race every write against a 30s stall budget: on timeout or rejection,
          // tear down so the buffered events are released. onAbort covers the
          // clean-disconnect case; this covers the half-dead-socket case.
          // Last-Event-ID tracking does not survive the reconnect loop this app
          // drives itself, so the id must ride in the JSON envelope as well.
          const send = async (frame: { directory?: string; payload: unknown }, id?: number) => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const stall = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("sse write stalled")), 30000)
            })
            try {
              await Promise.race([
                stream.writeSSE({
                  data: JSON.stringify(id === undefined ? frame : { ...frame, id }),
                  ...(id === undefined ? {} : { id: `${EventReplay.EPOCH}:${id}` }),
                }),
                stall,
              ])
            } catch {
              teardown()
            } finally {
              if (timer) clearTimeout(timer)
            }
          }

          // Live events are queued while the resume replay is still writing, so
          // the client sees one ordered sequence. Deltas are additive, so a live
          // frame overtaking an older replayed one appends to text that has not
          // arrived yet.
          let replaying = true
          const backlog: Array<() => Promise<void>> = []

          async function handler(event: any) {
            const id = EventReplay.idOf(event)
            // Drop events this connection has scoped itself away from. No
            // connectionID, or one that never subscribed, passes everything.
            if (connectionID && !GlobalInterest.wants(connectionID, event.payload)) return
            const write = () => send(blankStreamedText(event), id)
            if (replaying) {
              backlog.push(write)
              return
            }
            await write()
          }
          GlobalBus.on("event", handler)

          heartbeat = setInterval(() => {
            void send({ payload: { type: "server.heartbeat", properties: {} } })
          }, HEARTBEAT_MS)

          // Busy heal tick (independent of the 30s keepalive above). Every busy
          // change is pushed as it happens; this re-sends the current facts so
          // a client that missed a push heals within one tick, not only on
          // reconnect. Quiescence-gated: it sends while anything in its scope
          // is active (a turn, or open subagent or job debts), then once more
          // when that clears, then stays silent.
          //   - An open session (a busy scope): one session.busy frame for it
          //     and only the children with an open debt or a live turn, plus
          //     one trailing zero entry for a child that just went idle. Every
          //     entry carries the scope's directory, the store the session
          //     page reads.
          //   - The overview (no busy scope): one session.busy frame per root
          //     the hub holds as active, recomputed from the live sources and
          //     written back to the hub, and one zero frame per root when it
          //     goes idle.
          // Sent on the "global" channel: the client's handler lives only in
          // its global dispatch branch, and each entry carries its own
          // directory for store routing.
          let busyActive = false
          // Overview roots last sent active, and those already sent their one
          // zero frame, so a hub entry the live sources no longer back costs
          // one zero frame, not one per tick.
          const roots = new Set<string>()
          const sentIdle = new Set<string>()
          // Scoped children sent active last tick: each rides the next frame
          // once with its idle facts, so a missed idle push still zeroes it.
          let owed = new Set<string>()
          let ticking = false
          busyTick = setInterval(() => {
            if (ticking) return
            ticking = true
            void heal()
              .catch((error) => log.error("busy heal tick failed", { connectionID, error }))
              .finally(() => {
                ticking = false
                BusyHeal.ticked(connectionID)
              })
          }, BusyHeal.interval())
          async function heal() {
            const scope = connectionID ? GlobalInterest.busy(connectionID) : undefined
            if (!scope) {
              const candidates = new Set([...roots, ...(await SessionRecent.active())])
              const sessions = await SessionBusy.snapshot([...candidates])
              for (const id of roots) if (!sessions[id]) roots.delete(id)
              for (const id of sentIdle) if (!candidates.has(id)) sentIdle.delete(id)
              for (const [id, entry] of Object.entries(sessions)) {
                await SessionRecent.setBusy(id, { turn: entry.turn, subagents: entry.subagents, jobs: entry.jobs })
                const active = SessionBusy.active(entry)
                if (!active && sentIdle.has(id)) continue
                const [into, out] = active ? [roots, sentIdle] : [sentIdle, roots]
                into.add(id)
                out.delete(id)
                await send({
                  directory: "global",
                  payload: { type: ServerEvent.Busy.type, properties: { sessions: { [id]: entry } } },
                })
              }
              return
            }
            const children = await Sessions.children(scope.sessionID)
            // A child is live while it has a turn, owes its caller, or is
            // itself owed something (its own jobs or subagents).
            const owing = await Promise.all(
              children.map(async (id) => SessionBusy.busy(id) || (await Debt.has(id)) || (await Debt.owing(id))),
            )
            const live = children.filter((_, index) => owing[index])
            const snapshot = await SessionBusy.snapshot([
              scope.sessionID,
              ...new Set([...live, ...children.filter((id) => owed.has(id))]),
            ])
            owed = new Set(live)
            const sessions = Object.fromEntries(
              Object.entries(snapshot).map(([id, entry]) => [id, { ...entry, directory: scope.directory }]),
            )
            const active = Object.values(sessions).some(SessionBusy.active)
            if (!active && !busyActive) return
            busyActive = active
            await send({ directory: "global", payload: { type: ServerEvent.Busy.type, properties: { sessions } } })
          }

          // Replayed frames are already stored in delta form, so they ship as
          // recorded. Live events arriving during this loop are held by the
          // queue in `handler` rather than interleaved: a delta applied out of
          // order appends to the wrong text and corrupts the transcript.
          const missed = resumeFrom === undefined ? undefined : EventReplay.since(resumeFrom, epoch)
          if (missed) {
            for (const frame of missed) {
              if (connectionID && !GlobalInterest.wants(connectionID, frame.event.payload)) continue
              await send(frame.event, frame.id)
            }
          }
          replaying = false
          for (const pending of backlog.splice(0)) await pending()

          // `resumed` reports whether the gap was fully covered. False obliges
          // the client to re-bootstrap, since anything it missed is unrecoverable
          // from the stream alone.
          await send({
            payload: {
              type: "server.connected",
              properties: { resumed: !!missed, cursor: `${EventReplay.EPOCH}:${EventReplay.latest()}` },
            },
          })

          await new Promise<void>((resolve) => {
            finish = resolve
            stream.onAbort(() => {
              teardown()
              log.info("global event disconnected")
            })
          })
        })
      },
    )
    .post(
      "/subscribe",
      describeRoute({
        summary: "Scope an event connection",
        description:
          "Declare which sessions a /global/event connection cares about, so the server drops the streaming firehose of other sessions for it. Idempotent: each call replaces the connection's interest set. A connection that never subscribes receives every event (fail-open).",
        operationId: "global.subscribe",
        responses: {
          200: {
            description: "Subscription updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          connectionID: z.string(),
          directory: z.string().nullish(),
          sessions: z.array(z.string()),
          // The open session whose busy facts, with those of its children that
          // have an open debt or a live turn (plus one trailing zero for a child
          // that just went idle), the heal tick re-sends. Null on the overview (no open session): the tick
          // then sends one frame per active root. Separate from `sessions`
          // (message scope).
          busySession: z.string().nullish(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        GlobalInterest.set(body.connectionID, body.directory ?? undefined, body.sessions, body.busySession ?? undefined)
        return c.json(true)
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        await LSP.shutdownAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
    .post(
      "/web/reload",
      describeRoute({
        summary: "Reload web assets",
        description:
          "Re-read the packed web bundle from disk into memory so a rebuilt UI goes live without restarting the server.",
        operationId: "global.web.reload",
        responses: {
          200: {
            description: "Web assets reloaded",
            content: {
              "application/json": {
                schema: resolver(z.object({ assets: z.number() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const assets = await Web.reload()
        return c.json({ assets })
      },
    ),
)
