import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Debt } from "../../src/storage/debt"
import { Sessions } from "../../src/storage/sessions"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"
const model = { providerID: "anthropic", modelID: MODEL }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  requests: 0,
  gate: undefined as Promise<void> | undefined,
  fail: false,
}

function reply(value: string) {
  const chunks = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: MODEL,
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      // A title request carries no tools and never takes a turn's reply.
      if (!body.tools) return reply("a title")
      state.requests++
      if (state.gate) await state.gate
      // A 400 is not retried, so the turn ends on the error at once.
      if (state.fail)
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "test server" } },
          { status: 400 },
        )
      return reply("done")
    },
  })
})

const made: string[] = []

afterEach(async () => {
  state.requests = 0
  state.gate = undefined
  state.fail = false
  for (const id of made.splice(0)) {
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
    await Debt.drop(id)
  }
})

afterAll(() => {
  state.server?.stop()
})

async function until(check: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

async function withProject(fn: () => Promise<void>) {
  await using project = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

// Records the session.idle and session.error events one session publishes, in
// order, as `idle` and `error:<name>`: the two the client plays a sound for.
function listen(sessionID: string) {
  const seen: string[] = []
  const idle = Bus.subscribe(SessionStatus.Event.Idle, (event) => {
    if (event.properties.sessionID === sessionID) seen.push("idle")
  })
  const error = Bus.subscribe(Session.Event.Error, (event) => {
    if (event.properties.sessionID === sessionID) seen.push(`error:${event.properties.error?.name}`)
  })
  const stopped = Bus.subscribe(Session.Event.Stopped, (event) => {
    if (event.properties.sessionID === sessionID) seen.push("stopped")
  })
  return {
    seen,
    done() {
      idle()
      error()
      stopped()
      return seen
    },
  }
}

function route(method: string, path: string, body?: object) {
  return Server.App().request(`${path}?directory=${encodeURIComponent(Instance.directory)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// Runs one turn, lets `during` act on it while its model request is held, and
// returns the events it published. session.idle goes out after the turn's last
// cleanup, which ends after busy clears, so the list is taken once `expected`
// events arrive and a further window shows no more follow.
async function events(expected: number, during?: (sessionID: string) => Promise<void>) {
  const session = await Session.create({})
  made.push(session.id)
  const heard = listen(session.id)
  const release = Promise.withResolvers<void>()
  if (during) state.gate = release.promise
  const turn = SessionPrompt.prompt({
    variant: Provider.INHERIT,
    sessionID: session.id,
    model,
    agent: "build",
    parts: [{ type: "text", text: "go" }],
  }).catch(() => undefined)
  if (during) {
    await until(() => state.requests > 0, "the turn's model request")
    await during(session.id)
    release.resolve()
  }
  await turn
  await until(() => !SessionBusy.busy(session.id), "the turn to end")
  await until(() => heard.seen.length >= expected, `${expected} events`).catch(() => undefined)
  await Bun.sleep(300)
  return heard.done()
}

// The client plays one sound per ended turn: the done sound on session.idle,
// the error sound on session.error. A turn that finishes sends idle; one that
// fails or is interrupted with Esc sends its error and no idle, so it is never
// two sounds. A Stop ends the session rather than a turn someone waits on, and
// sends neither.
describe("turn-end events", () => {
  test("a turn that finishes publishes idle once", async () => {
    await withProject(async () => {
      expect(await events(1)).toEqual(["idle"])
    })
  }, 30_000)

  test("a turn that fails publishes its error and no idle", async () => {
    await withProject(async () => {
      state.fail = true
      expect(await events(1)).toEqual(["error:APIError"])
    })
  }, 30_000)

  test("an interrupted turn publishes its abort error and no idle", async () => {
    await withProject(async () => {
      expect(await events(1, (id) => Session.interrupt(id))).toEqual(["error:MessageAbortedError"])
    })
  }, 30_000)

  test("a stopped session publishes nothing", async () => {
    await withProject(async () => {
      expect(await events(0, (id) => Session.stop({ sessionID: id }))).toEqual([])
    })
  }, 30_000)

  test("the Stop route announces the stop once, mid-turn", async () => {
    await withProject(async () => {
      const heard = await events(1, async (id) => {
        expect((await route("POST", `/session/${id}/abort`)).status).toBe(200)
      })
      expect(heard).toEqual(["stopped"])
    })
  }, 30_000)

  test("the Stop route announces the stop of a session with no turn", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      made.push(session.id)
      const heard = listen(session.id)
      expect((await route("POST", `/session/${session.id}/abort`)).status).toBe(200)
      await Bun.sleep(300)
      expect(heard.done()).toEqual(["stopped"])
    })
  }, 30_000)

  test("archiving and deleting announce the stop once each", async () => {
    await withProject(async () => {
      const archived = await Session.create({})
      const deleted = await Session.create({})
      made.push(archived.id)
      const heard = [listen(archived.id), listen(deleted.id)]
      expect((await route("PATCH", `/session/${archived.id}`, { time: { archived: Date.now() } })).status).toBe(200)
      expect((await route("DELETE", `/session/${deleted.id}`)).status).toBe(200)
      await Bun.sleep(300)
      expect(heard.map((h) => h.done())).toEqual([["stopped"], ["stopped"]])
    })
  }, 30_000)

  test("renaming a session announces nothing", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      made.push(session.id)
      const heard = listen(session.id)
      expect((await route("PATCH", `/session/${session.id}`, { title: "renamed" })).status).toBe(200)
      await Bun.sleep(300)
      expect(heard.done()).toEqual([])
    })
  }, 30_000)

  test("stopping a session with no turn publishes nothing", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      made.push(session.id)
      const heard = listen(session.id)
      await Session.stop({ sessionID: session.id })
      await Bun.sleep(300)
      expect(heard.done()).toEqual([])
    })
  }, 30_000)
})
