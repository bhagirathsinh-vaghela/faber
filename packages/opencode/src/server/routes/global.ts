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
import { SessionBusy } from "../../session/busy"
import { Event as ServerEvent } from "../event"
import { HEARTBEAT_MS } from "@opencode-ai/util/stream"
import { errors } from "../error"
import { Web } from "../web"

const log = Log.create({ service: "server" })

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

          // Busy reconcile tick (independent of the 30s keepalive above). Level-
          // triggered safety net for the open session's subtree: recent.updated
          // heals hub ROOTS, but subtask children are not in the hub, so their
          // busy state can only self-heal here. Quiescence-gated — we send only
          // while the scoped subtree has a busy session, plus ONE trailing all-
          // idle when it clears, then stay silent. So a client wakes only while
          // work is actually happening in what it's viewing; an idle connection
          // gets nothing from this timer (the keepalive still covers liveness).
          // A connection with no interest set is the overview: it reconciles via
          // recent.updated, so this tick does nothing for it.
          let busyActive = false
          busyTick = setInterval(() => {
            // Busy scope is exactly ONE open session's subtree (or none, on the
            // overview). Not the message interest set, not a directory list.
            const scope = connectionID ? GlobalInterest.busy(connectionID) : undefined
            if (!scope) return

            const busy = SessionBusy.subtreeBusy(scope.sessionID, scope.directory)
            // Quiescence gate: nothing busy in the open subtree. Send ONE trailing
            // all-idle snapshot so a client that saw busy clears it, then stay
            // silent until work resumes.
            if (!busy && !busyActive) return
            busyActive = busy
            const sessions = SessionBusy.subtreeSnapshot(scope.sessionID, scope.directory)
            // Send on the "global" channel, like recent.updated: the client's
            // `session.busy` handler lives ONLY in the `directory === "global"`
            // dispatch branch, so a frame stamped with the real directory routes
            // to the per-directory handler, which has no case for it, and is
            // dropped. Each session entry carries its own directory, so per-entry
            // store routing is unaffected. A root also gets busy via the "global"
            // recent hub, but a directly-opened subtask (not in the hub) has this
            // tick as its only channel — stamping the real directory hid its
            // indicators entirely.
            void send({
              directory: "global",
              payload: { type: ServerEvent.Busy.type, properties: { sessions } },
            })
          }, 5000)

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
          // The open session whose subtree the busy reconcile tick heals. Null on
          // the overview (no open session) — the tick then stays silent and busy
          // is served by recent.updated. Separate from `sessions` (message scope).
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
