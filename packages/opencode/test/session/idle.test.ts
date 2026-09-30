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

// Runs one turn, lets `during` act on it while its model request is held, and
// returns how many session.idle events the session published. The event goes
// out after the turn's last cleanup, which ends after busy clears, so the count
// is taken once `expected` arrive and a further window shows no more follow.
async function idles(expected: number, during?: (sessionID: string) => Promise<void>) {
  const session = await Session.create({})
  made.push(session.id)
  const seen: string[] = []
  const unsub = Bus.subscribe(SessionStatus.Event.Idle, (event) => {
    if (event.properties.sessionID === session.id) seen.push(event.properties.sessionID)
  })
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
  await until(() => seen.length >= expected, `${expected} idle events`).catch(() => undefined)
  await Bun.sleep(300)
  unsub()
  return seen.length
}

// session.idle means "a turn ended and the user may want to know": the client
// chimes on it. A Stop ends the session, not a turn someone waits on.
describe("session.idle", () => {
  test("a turn that finishes publishes it once", async () => {
    await withProject(async () => {
      expect(await idles(1)).toBe(1)
    })
  }, 30_000)

  test("a turn that ends on an error publishes it once", async () => {
    await withProject(async () => {
      state.fail = true
      expect(await idles(1)).toBe(1)
    })
  }, 30_000)

  test("an interrupted turn publishes it once", async () => {
    await withProject(async () => {
      expect(await idles(1, (id) => Session.interrupt(id))).toBe(1)
    })
  }, 30_000)

  test("a stopped session publishes none", async () => {
    await withProject(async () => {
      expect(await idles(0, (id) => Session.stop({ sessionID: id }))).toBe(0)
    })
  }, 30_000)

  test("stopping a session with no turn publishes none", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      made.push(session.id)
      const seen: string[] = []
      const unsub = Bus.subscribe(SessionStatus.Event.Idle, (event) => {
        if (event.properties.sessionID === session.id) seen.push(event.properties.sessionID)
      })
      await Session.stop({ sessionID: session.id })
      await Bun.sleep(300)
      unsub()
      expect(seen).toEqual([])
    })
  }, 30_000)
})
