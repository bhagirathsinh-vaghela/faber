import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import os from "os"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { OpenProjects } from "../../project/open"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { SessionPing } from "../../session/ping"
import { SessionPin } from "../../session/pin"
import { SessionPrompt } from "../../session/prompt"
import { SessionRecent } from "../../session/recent"
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
          "Remove a project from the shared sidebar set (broadcast to all clients). If any of its sessions are still live (busy or ping-armed) and force is not set, returns them without closing so the client can confirm. With force, each live session is stopped first, then the server instance is disposed.",
        operationId: "global.projects.close",
        responses: {
          200: {
            description: "Close result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    closed: z.boolean(),
                    live: z.array(z.object({ sessionID: z.string(), directory: z.string() })),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ directory: z.string(), force: z.boolean().optional() })),
      async (c) => {
        const body = c.req.valid("json")
        const { project } = await Project.fromDirectory(body.directory)

        // Live = busy OR a scheduled ping (pingAt set). This matches the
        // overview's "needs attention" definition: pingAt is cleared server-side
        // when the cache window lapses, so an armed-but-cold daemon (idle session
        // whose cache died) is NOT live. unseen is deliberately excluded — close
        // is non-destructive (the session becomes a recent session, keeping its
        // unseen flag), so unread output is not a reason to block a close.
        const recent = await SessionRecent.list()
        const candidates = recent
          .filter((x) => x.busy || x.pingAt !== undefined)
          .map((x) => ({ sessionID: x.sessionID, directory: x.directory }))
        // Match by project id, not path containment: a session's stored
        // directory can differ from the resolved worktree (symlinks like
        // /tmp -> /private/tmp, or a sandbox under the worktree), which a raw
        // path compare would miss. fromDirectory is per-directory cached.
        const owns = async (directory: string) =>
          Project.fromDirectory(directory)
            .then((x) => x.project.id === project.id)
            .catch(() => false)
        const seen = new Map<string, { sessionID: string; directory: string }>()
        for (const entry of candidates) {
          if (seen.has(entry.sessionID)) continue
          if (await owns(entry.directory)) seen.set(entry.sessionID, entry)
        }
        const unique = [...seen.values()]

        if (unique.length && !body.force) return c.json({ closed: false, live: unique })

        // Disarm the ping and drop the pin for every live session (both are
        // context-free module state, so stop them unconditionally — the daemon
        // must die even if its instance was already evicted).
        for (const entry of unique) {
          SessionPing.stop(entry.sessionID)
          SessionPin.drop(entry.sessionID)
        }
        // Identity is the directory, so the worktree must NOT be disposed here:
        // subfolder projects share the repo root as worktree, and disposing it
        // would tear down a different live project's instance mid-turn. Dispose
        // only directories keyed to this project: the client's raw path, the
        // canonical id (symlinks like /tmp -> /private/tmp key separately), and
        // each live session's directory. disposeDirectory only disposes an
        // already-cached instance — it never creates (and never bootstraps) one,
        // which would re-add the project to the open set. Abort any in-flight
        // turn in the instance context (cancel reads per-instance state) just
        // before that instance disposes.
        const byDir = new Map<string, string[]>()
        for (const entry of unique) byDir.set(entry.directory, [...(byDir.get(entry.directory) ?? []), entry.sessionID])
        const directories = new Set([body.directory, project.id, ...byDir.keys()])
        for (const directory of directories)
          await Instance.disposeDirectory(directory, () => {
            for (const sessionID of byDir.get(directory) ?? []) SessionPrompt.cancel(sessionID)
          })
        // Close AFTER disposing so nothing re-adds it.
        OpenProjects.close(project.id)
        return c.json({ closed: true, live: unique })
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
      async (c) => {
        log.info("global event connected")
        return streamSSE(c, async (stream) => {
          stream.writeSSE({
            data: JSON.stringify({
              payload: {
                type: "server.connected",
                properties: {},
              },
            }),
          })
          async function handler(event: any) {
            await stream.writeSSE({
              data: JSON.stringify(event),
            })
          }
          GlobalBus.on("event", handler)

          // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
          const heartbeat = setInterval(() => {
            stream.writeSSE({
              data: JSON.stringify({
                payload: {
                  type: "server.heartbeat",
                  properties: {},
                },
              }),
            })
          }, 30000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              GlobalBus.off("event", handler)
              resolve()
              log.info("global event disconnected")
            })
          })
        })
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
