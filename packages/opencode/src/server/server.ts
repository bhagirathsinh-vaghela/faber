import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import zlib from "zlib"
import { streamSSE } from "hono/streaming"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill/skill"
import { Dock } from "../dock/dock"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { SessionPin } from "../session/pin"
import { Global } from "../global"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { OneshotRoutes } from "./routes/oneshot"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { lazy } from "../util/lazy"
import { InstanceBootstrap } from "../project/bootstrap"
import { Storage } from "../storage/storage"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { PreferenceRoutes } from "./routes/preference"
import { GlobalRoutes } from "./routes/global"
import { BackgroundRoutes } from "./routes/background"
import { JobRoutes } from "./routes/job"
import { DictationRoutes } from "./routes/dictation"
import { TtsRoutes } from "./routes/tts"
import { MDNS } from "./mdns"
import { Web } from "./web"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  const compressible = /^(application\/json|application\/manifest\+json|text\/|application\/javascript|image\/svg\+xml)/
  // Below ~1KB the br/gzip framing overhead outweighs the savings.
  const compressFloor = 1024
  // Dynamic responses compress on the request thread, so quality trades directly
  // against TTFB. On a ~1.9MB history payload, brotli q11 costs ~700ms and blocks
  // the event loop for every client; q5 costs ~8ms for a 14.4x ratio (vs q11's
  // 16.6x), a 16KB give-up for an 88x speedup. Static assets keep q11 (precompressed
  // offline in pack-web.ts, where CPU is free).
  const dynamicBrotli = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }

  // Compresses buffered JSON/text responses per Accept-Encoding. text/event-stream
  // MUST be skipped: the SSE feed is infinite, so the arrayBuffer() below would
  // await forever and no byte ever reaches the client. It also matches the text/
  // branch of `compressible`, so it needs an explicit exclusion, not just omission
  // from the allowlist. (Content-Length is not a reliable stream signal here: hono
  // sets it when serializing, after this middleware sees c.res.)
  const compress: MiddlewareHandler = async (c, next) => {
    await next()
    const res = c.res
    if (!res.body || res.headers.get("content-encoding")) return
    const type = res.headers.get("content-type") ?? ""
    if (type.startsWith("text/event-stream")) return
    if (!compressible.test(type)) return
    const accept = c.req.header("accept-encoding") ?? ""
    const encoding = accept.includes("br") ? "br" : accept.includes("gzip") ? "gzip" : undefined
    if (!encoding) return
    const raw = Buffer.from(await res.arrayBuffer())
    if (raw.byteLength < compressFloor) {
      c.res = new Response(raw, res)
      return
    }
    const body = encoding === "br" ? zlib.brotliCompressSync(raw, dynamicBrotli) : zlib.gzipSync(raw)
    const headers = new Headers(res.headers)
    headers.set("Content-Encoding", encoding)
    headers.delete("Content-Length")
    headers.append("Vary", "Accept-Encoding")
    c.res = new Response(body, { status: res.status, headers })
  }

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  // A TUI worker calls listen() only when --port is passed, so the fallback in
  // url() names a port nothing is bound to. An unset value is the honest answer
  // for a caller that has to reach the API over the network. A wildcard bind
  // reaches _url verbatim, and no client can dial 0.0.0.0.
  export function listening() {
    if (!_url) return
    if (_url.hostname !== "0.0.0.0" && _url.hostname !== "::") return _url.origin
    return `http://127.0.0.1:${_url.port}`
  }

  const app = new Hono()
  export const App: () => Hono = lazy(
    () =>
      // TODO: Break server.ts into smaller route files to fix type inference
      app
        .onError((err, c) => {
          log.error("failed", {
            error: err,
          })
          if (err instanceof NamedError) {
            let status: ContentfulStatusCode
            if (err instanceof Storage.NotFoundError) status = 404
            else if (err instanceof Provider.ModelNotFoundError) status = 400
            else if (err.name.startsWith("Worktree")) status = 400
            else status = 500
            return c.json(err.toObject(), { status })
          }
          if (err instanceof HTTPException) return err.getResponse()
          const message = err instanceof Error && err.stack ? err.stack : err.toString()
          return c.json(new NamedError.Unknown({ message }).toObject(), {
            status: 500,
          })
        })
        .use((c, next) => {
          const password = Flag.OPENCODE_SERVER_PASSWORD
          if (!password) return next()
          const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
          return basicAuth({ username, password })(c, next)
        })
        .use(async (c, next) => {
          const skipLogging = c.req.path === "/log"
          if (!skipLogging) {
            log.info("request", {
              method: c.req.method,
              path: c.req.path,
            })
          }
          const timer = log.time("request", {
            method: c.req.method,
            path: c.req.path,
          })
          await next()
          if (!skipLogging) {
            timer.stop()
          }
        })
        .use(compress)
        .use(
          cors({
            origin(input) {
              if (!input) return

              if (input.startsWith("http://localhost:")) return input
              if (input.startsWith("http://127.0.0.1:")) return input
              if (input === "tauri://localhost" || input === "http://tauri.localhost") return input

              // *.opencode.ai (https only, adjust if needed)
              if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
                return input
              }
              if (_corsWhitelist.includes(input)) {
                return input
              }

              return
            },
          }),
        )
        .route("/global", GlobalRoutes())
        .route("/dictation", DictationRoutes())
        .route("/tts", TtsRoutes())
        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
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
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          validator("json", Auth.Info),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            return c.json(true)
          },
        )
        .delete(
          "/auth/:providerID",
          describeRoute({
            summary: "Remove auth credentials",
            description: "Remove authentication credentials",
            operationId: "auth.remove",
            responses: {
              200: {
                description: "Successfully removed authentication credentials",
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
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            await Auth.remove(providerID)
            return c.json(true)
          },
        )
        .use(async (c, next) => {
          if (c.req.path === "/log") return next()
          const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
          const directory = (() => {
            try {
              return decodeURIComponent(raw)
            } catch {
              return raw
            }
          })()
          return Instance.provide({
            directory,
            init: InstanceBootstrap,
            async fn() {
              return next()
            },
          })
        })
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "opencode",
                version: "0.0.3",
                description: "opencode api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .use(validator("query", z.object({ directory: z.string().optional() })))
        .route("/project", ProjectRoutes())
        .route("/pty", PtyRoutes())
        .route("/config", ConfigRoutes())
        .route("/experimental", ExperimentalRoutes())
        .route("/session", SessionRoutes())
        .route("/oneshot", OneshotRoutes())
        .route("/permission", PermissionRoutes())
        .route("/preference", PreferenceRoutes())
        .route("/question", QuestionRoutes())
        .route("/provider", ProviderRoutes())
        .route("/", FileRoutes())
        .route("/mcp", McpRoutes())
        .route("/background", BackgroundRoutes())
        .route("/job", JobRoutes())
        .route("/tui", TuiRoutes())
        .post(
          "/instance/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
            operationId: "instance.dispose",
            responses: {
              200: {
                description: "Instance disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.dispose()
            return c.json(true)
          },
        )
        .get(
          "/path",
          describeRoute({
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
            operationId: "path.get",
            responses: {
              200: {
                description: "Path",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          home: z.string(),
                          state: z.string(),
                          config: z.string(),
                          worktree: z.string(),
                          directory: z.string(),
                        })
                        .meta({
                          ref: "Path",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              home: Global.Path.home,
              state: Global.Path.state,
              config: Global.Path.config,
              worktree: Instance.worktree,
              directory: Instance.directory,
            })
          },
        )
        .get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
            operationId: "vcs.get",
            responses: {
              200: {
                description: "VCS info",
                content: {
                  "application/json": {
                    schema: resolver(Vcs.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            const branch = await Vcs.branch()
            return c.json({
              branch,
            })
          },
        )
        .get(
          "/command",
          describeRoute({
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
            operationId: "command.list",
            responses: {
              200: {
                description: "List of commands",
                content: {
                  "application/json": {
                    schema: resolver(Command.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await SessionPin.refresh()
            const commands = await Command.list()
            return c.json(commands)
          },
        )
        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
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
              service: z.string().meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            const logger = Log.create({ service })

            switch (level) {
              case "debug":
                logger.debug(message, extra)
                break
              case "info":
                logger.info(message, extra)
                break
              case "error":
                logger.error(message, extra)
                break
              case "warn":
                logger.warn(message, extra)
                break
            }

            return c.json(true)
          },
        )
        .get(
          "/agent",
          describeRoute({
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
            operationId: "app.agents",
            responses: {
              200: {
                description: "List of agents",
                content: {
                  "application/json": {
                    schema: resolver(Agent.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const modes = await Agent.list()
            return c.json(modes)
          },
        )
        .get(
          "/skill",
          describeRoute({
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
            operationId: "app.skills",
            responses: {
              200: {
                description: "List of skills",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const skills = await Skill.all()
            return c.json(skills)
          },
        )
        .get(
          "/skill/favorite",
          describeRoute({
            summary: "List favorite skills",
            description: "Get the names of skills the user has favorited.",
            operationId: "app.skillFavorites",
            responses: {
              200: {
                description: "Favorite skill names",
                content: {
                  "application/json": {
                    schema: resolver(z.string().array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const favorites = await Skill.favorites()
            return c.json(favorites)
          },
        )
        .put(
          "/skill/favorite",
          describeRoute({
            summary: "Set favorite skills",
            description: "Replace the list of favorited skill names.",
            operationId: "app.setSkillFavorites",
            responses: {
              200: {
                description: "Updated favorite skill names",
                content: {
                  "application/json": {
                    schema: resolver(z.string().array()),
                  },
                },
              },
            },
          }),
          validator("json", z.string().array()),
          async (c) => {
            const favorites = await Skill.setFavorites(c.req.valid("json"))
            return c.json(favorites)
          },
        )
        .get(
          "/dock/config",
          describeRoute({
            summary: "Get dock config",
            description: "Get the visible field IDs for the usage dock and footer, per surface.",
            operationId: "app.dockConfig",
            responses: {
              200: {
                description: "Dock config",
                content: {
                  "application/json": {
                    schema: resolver(Dock.Config),
                  },
                },
              },
            },
          }),
          async (c) => {
            const config = await Dock.get()
            return c.json(config)
          },
        )
        .put(
          "/dock/config",
          describeRoute({
            summary: "Set dock config",
            description: "Replace the visible field IDs for the usage dock and footer, per surface.",
            operationId: "app.setDockConfig",
            responses: {
              200: {
                description: "Updated dock config",
                content: {
                  "application/json": {
                    schema: resolver(Dock.Config),
                  },
                },
              },
            },
          }),
          validator("json", Dock.Config),
          async (c) => {
            const config = await Dock.set(c.req.valid("json"))
            return c.json(config)
          },
        )
        .get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        )
        .get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        )
        .get(
          "/event",
          describeRoute({
            summary: "Subscribe to events",
            description: "Get events",
            operationId: "event.subscribe",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(BusEvent.payloads()),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("event connected")
            return streamSSE(c, async (stream) => {
              let heartbeat: ReturnType<typeof setInterval> | undefined
              let finish: (() => void) | undefined
              let unsub: (() => void) | undefined
              let torn = false
              const teardown = () => {
                if (torn) return
                torn = true
                if (heartbeat) clearInterval(heartbeat)
                unsub?.()
                finish?.()
                stream.close().catch(() => {})
              }

              // writeSSE rejects with an AbortError when the client disconnects
              // or the server is torn down mid-write (e.g. a supervisor restart
              // kills the process while this stream is open). A write that never
              // settles instead means a half-dead client stopped draining; left
              // alone its events queue in memory. Race each write against a 30s
              // stall budget and tear down on failure or timeout. onAbort still
              // covers the clean-disconnect case.
              const send = async (data: unknown) => {
                let timer: ReturnType<typeof setTimeout> | undefined
                const stall = new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("sse write stalled")), 30000)
                })
                try {
                  await Promise.race([stream.writeSSE({ data: JSON.stringify(data) }), stall])
                } catch {
                  teardown()
                } finally {
                  if (timer) clearTimeout(timer)
                }
              }

              unsub = Bus.subscribeAll(async (event) => {
                await send(event)
                if (event.type === Bus.InstanceDisposed.type) {
                  stream.close()
                }
              })

              // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
              heartbeat = setInterval(() => {
                void send({ type: "server.heartbeat", properties: {} })
              }, 30000)

              await send({ type: "server.connected", properties: {} })

              await new Promise<void>((resolve) => {
                finish = resolve
                stream.onAbort(() => {
                  teardown()
                  log.info("event disconnected")
                })
              })
            })
          },
        )
        .all("/*", async (c) => {
          const response = Web.serve(c.req.path, c.req.header("accept-encoding"), c.req.header("if-none-match"))
          if (response) return response
          return c.text("web UI not embedded in this build", 404)
        }) as unknown as Hono,
  )

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    _corsWhitelist = opts.cors ?? []

    const args = {
      hostname: opts.hostname,
      // Reap a connection with no traffic for 90s. SSE streams heartbeat every
      // 30s (below), so a live client resets the timer well inside the window;
      // a half-dead backgrounded socket (no ACKs, no RST) that the heartbeat
      // can no longer reach gets closed instead of lingering with its buffered
      // events pinned in memory. 90s is 3x the heartbeat and under Bun's 255s cap.
      // The synchronous POST /prompt route, which writes no bytes until the turn
      // ends, disables this per-request via server.timeout(req, 0) so a long turn
      // is never reaped mid-flight — the global window stays tight for everything
      // else.
      idleTimeout: 90,
      fetch: App().fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
