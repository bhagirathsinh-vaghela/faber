import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import os from "os"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus, GlobalInterest } from "@/bus/global"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { OpenProjects } from "../../project/open"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { SessionPing } from "../../session/ping"
import { SessionRecent } from "../../session/recent"
import { errors } from "../error"
import { Web } from "../web"

const log = Log.create({ service: "server" })

// Web-SSE-only optimization: a streaming text part resends its whole growing
// text every chunk (O(n^2) on the wire). The event carries a `delta` the web
// client appends, so blank the text on the way out to this stream. Clone first
// — the same event object is fanned out to every connection and other in-process
// consumers, which need the full text.
function blankStreamedText(event: any) {
  const p = event?.payload
  if (p?.type !== "message.part.updated") return event
  if (p.properties?.delta === undefined || typeof p.properties?.part?.text !== "string") return event
  return {
    ...event,
    payload: { ...p, properties: { ...p.properties, part: { ...p.properties.part, text: "" } } },
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
        return c.json(OpenProjects.list())
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
        OpenProjects.open(entry)
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
        OpenProjects.close(project.id)
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
        log.info("global event connected", { connectionID })
        return streamSSE(c, async (stream) => {
          let heartbeat: ReturnType<typeof setInterval> | undefined
          let finish: (() => void) | undefined
          let torn = false
          const teardown = () => {
            if (torn) return
            torn = true
            if (heartbeat) clearInterval(heartbeat)
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
          const send = async (payload: unknown) => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const stall = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("sse write stalled")), 30000)
            })
            try {
              await Promise.race([stream.writeSSE({ data: JSON.stringify(payload) }), stall])
            } catch {
              teardown()
            } finally {
              if (timer) clearTimeout(timer)
            }
          }

          async function handler(event: any) {
            // Drop events this connection has scoped itself away from. No
            // connectionID, or one that never subscribed, passes everything.
            if (connectionID && !GlobalInterest.wants(connectionID, event.payload)) return
            await send(blankStreamedText(event))
          }
          GlobalBus.on("event", handler)

          // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
          heartbeat = setInterval(() => {
            void send({ payload: { type: "server.heartbeat", properties: {} } })
          }, 30000)

          await send({ payload: { type: "server.connected", properties: {} } })

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
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        GlobalInterest.set(body.connectionID, body.directory ?? undefined, body.sessions)
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
