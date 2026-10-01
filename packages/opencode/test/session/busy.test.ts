import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRecent } from "../../src/session/recent"
import { Recovery } from "../../src/session/recovery"
import { Instance } from "../../src/project/instance"
import { GlobalBus, GlobalInterest } from "../../src/bus/global"
import { Debt } from "../../src/storage/debt"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundSpawn } from "../../src/background/spawn"
import { BackgroundProcess } from "../../src/background/process"
import { Server } from "../../src/server/server"
import { BusyHeal } from "../../src/server/routes/global"
import { HEARTBEAT_MS } from "@opencode-ai/util/stream"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

Log.init({ print: false })

type Entry = { directory: string; turn: boolean; subagents: number; jobs: number }

const made: string[] = []
afterEach(async () => {
  const ids = made.splice(0)
  for (const id of ids) await Debt.drop(id)
  // A message into a root touches its hub row and arms the hub's lazy emit;
  // removing the row emits at once, so no recent.updated from this test lands
  // inside a later test's window.
  for (const id of ids) await SessionRecent.remove(id)
})

// Every session.busy entry emitted for `sessionID` while `fn` runs, in order.
async function pushes(sessionID: string, fn: () => Promise<unknown>) {
  const seen: Omit<Entry, "directory">[] = []
  const listen = (event: { payload: { type: string; properties: { sessions?: Record<string, Entry> } } }) => {
    const entry = event.payload.type === "session.busy" ? event.payload.properties.sessions?.[sessionID] : undefined
    if (entry) seen.push({ turn: entry.turn, subagents: entry.subagents, jobs: entry.jobs })
  }
  GlobalBus.on("event", listen)
  await fn()
  GlobalBus.off("event", listen)
  return seen
}

function tell(sessionID: string) {
  return SessionPrompt.prompt({
    model: Provider.DEFAULT,
    variant: Provider.DEFAULT,
    sessionID,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "go" }],
  })
}

// A job record naming no process: never reaped by a stop, never settled.
async function job(sessionID: string) {
  const id = BackgroundJob.id()
  await BackgroundJob.write({
    id,
    sessionID,
    directory: "/tmp",
    project: "/tmp",
    command: "true",
    description: "held job",
    status: "running",
    time: { created: Date.now(), hard: Date.now() + 600_000 },
  })
  await Debt.add(id, "job", sessionID)
  return id
}

// A job with a live process, which is what a Stop has something to kill.
async function live(sessionID: string) {
  const id = BackgroundJob.id()
  const proc = Bun.spawn({ cmd: ["sleep", "30"], detached: true, stdio: ["ignore", "ignore", "ignore"] })
  const identity = (await BackgroundProcess.inspect(proc.pid))!
  await BackgroundJob.write({
    id,
    sessionID,
    directory: "/tmp",
    project: "/tmp",
    command: "sleep 30",
    description: "live job",
    status: "running",
    time: { created: Date.now(), hard: Date.now() + 600_000 },
    process: { pid: identity.pid, start: identity.start, pgid: identity.pgid },
  })
  await Debt.add(id, "job", sessionID)
  return id
}

type Frame = { type: string; properties: { sessions?: Record<string, Entry>; complete?: boolean } }

// A /global/event connection with its frames collected as they arrive, and
// `ticks(n)` resolving once the connection's heal tick has completed n more
// times.
async function connect(connectionID: string, directory: string, scope: string | undefined) {
  GlobalInterest.set(connectionID, directory, [], scope)
  const response = await Server.App().request(`/global/event?connectionID=${connectionID}`)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  const waiters: { at: number; resolve: () => void }[] = []
  let count = 0
  const off = BusyHeal.onTick((id) => {
    if (id !== connectionID) return
    count++
    for (const waiter of waiters.filter((waiter) => waiter.at <= count)) waiter.resolve()
  })
  const reading = (async () => {
    let buffer = ""
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines.filter((line) => line.startsWith("data: ")))
        frames.push((JSON.parse(line.slice(6)) as { payload: Frame }).payload)
    }
  })().catch(() => undefined)
  return {
    frames,
    ticks(n: number) {
      const { promise, resolve } = Promise.withResolvers<void>()
      waiters.push({ at: count + n, resolve })
      // A frame written before the tick completed is read one macrotask later.
      return promise.then(() => new Promise<void>((done) => setImmediate(done)))
    },
    async close() {
      off()
      await reader.cancel().catch(() => {})
      await reading
      GlobalInterest.clear(connectionID)
    },
  }
}

// The heal tick's frames for `id`; the heartbeat's complete frames are the
// census tests' subject.
const busyFrames = (frames: Frame[], id: string) =>
  frames.filter(
    (frame) => frame.type === "session.busy" && !frame.properties.complete && frame.properties.sessions?.[id],
  )

const censuses = (frames: Frame[]) =>
  frames.filter((frame) => frame.type === "session.busy" && frame.properties.complete)

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  return check()
}

beforeAll(() => BusyHeal.set(50))
afterAll(() => BusyHeal.set(5000))

describe("SessionBusy pushes", () => {
  test("a job launch pushes jobs: 1 and its inline payment pushes jobs: 0", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const seen = await pushes(root.id, () =>
          BackgroundSpawn.run({
            command: "true",
            description: "quick",
            sessionID: root.id,
            directory: tmp.path,
            project: tmp.path,
            shell: "/bin/sh",
            env: {},
          }),
        )
        expect(seen).toEqual([
          { turn: false, subagents: 0, jobs: 1 },
          { turn: false, subagents: 0, jobs: 0 },
        ])
      },
    })
  }, 20_000)

  test("a subagent's first message pushes subagents: 1 on the parent and its report pushes 0", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        made.push(parent.id, child.id)
        expect(await pushes(parent.id, () => tell(child.id))).toEqual([{ turn: false, subagents: 1, jobs: 0 }])
        expect(
          await pushes(parent.id, () =>
            Recovery.deliver(parent.id, [{ text: "done", synthetic: true }], child.id, { wake: false }),
          ),
        ).toEqual([{ turn: false, subagents: 0, jobs: 0 }])
      },
    })
  }, 20_000)

  test("an interrupted child keeps its parent at subagents: 1", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        made.push(parent.id, child.id)
        await tell(child.id)
        await Session.interrupt(child.id)
        expect(await SessionBusy.debts(parent.id)).toEqual({ subagents: 1, jobs: 0 })
      },
    })
  }, 20_000)

  test("Stop pays the parent's debts, so its pushes read 0 and a later message does not bring them back", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const id = await live(root.id)
        expect(await SessionBusy.debts(root.id)).toEqual({ subagents: 0, jobs: 1 })
        const stopped = await pushes(root.id, () => Session.stop({ sessionID: root.id }))
        expect(stopped.at(-1)).toEqual({ turn: false, subagents: 0, jobs: 0 })
        expect(await Debt.owed(root.id)).toEqual([])
        expect(await pushes(root.id, () => tell(root.id))).toEqual([])
        expect(await SessionBusy.debts(root.id)).toEqual({ subagents: 0, jobs: 0 })
        await BackgroundJob.remove(id)
      },
    })
  }, 20_000)

  test("a grandchild's turn lights the root only through the child's debt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        const grandchild = await Session.create({ parentID: child.id })
        made.push(root.id, child.id, grandchild.id)
        const idle = { directory: tmp.path, turn: false, subagents: 0, jobs: 0 }

        expect(await pushes(root.id, async () => SessionBusy.enter(grandchild.id))).toEqual([])
        expect(await SessionBusy.snapshot([root.id])).toEqual({ [root.id]: idle })
        SessionBusy.exit(grandchild.id)

        await tell(child.id)
        SessionBusy.enter(grandchild.id)
        expect(await SessionBusy.snapshot([root.id])).toEqual({ [root.id]: { ...idle, subagents: 1 } })
        SessionBusy.exit(grandchild.id)
      },
    })
  }, 20_000)
})

describe("recent hub and /live", () => {
  test("seeding reads each entry's debt counts from the debt table", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        made.push(root.id, child.id)
        await SessionRecent.touch({ sessionID: root.id, directory: tmp.path, title: "t", updated: Date.now() })
        const id = await job(root.id)
        await Debt.add(child.id, "subagent", root.id)
        await SessionRecent.seed()
        const entry = (await SessionRecent.list()).find((row) => row.sessionID === root.id)
        expect({ turn: entry?.turn, subagents: entry?.subagents, jobs: entry?.jobs }).toEqual({
          turn: false,
          subagents: 1,
          jobs: 1,
        })
        await BackgroundJob.remove(id)
        await SessionRecent.remove(root.id)
      },
    })
  }, 20_000)

  test("GET /session/:id/live counts open debts, and none once a Stop has paid them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const state = async () =>
          (await Server.App().request(`/session/${root.id}/live?directory=${encodeURIComponent(tmp.path)}`)).json()
        const id = await live(root.id)
        expect(await state()).toEqual({ live: true, turn: false, pinging: false, subagents: 0, jobs: 1 })
        await Session.stop({ sessionID: root.id })
        expect(await Debt.owed(root.id)).toEqual([])
        expect(await state()).toEqual({ live: false, turn: false, pinging: false, subagents: 0, jobs: 0 })
        await BackgroundJob.remove(id)
      },
    })
  }, 20_000)

  test("a debt whose job record is gone counts 0 in /live and busy, and /debts omits it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const query = `?directory=${encodeURIComponent(tmp.path)}`
        const id = await job(root.id)
        await BackgroundJob.remove(id)

        expect(await (await Server.App().request(`/session/${root.id}/live${query}`)).json()).toEqual({
          live: false,
          turn: false,
          pinging: false,
          subagents: 0,
          jobs: 0,
        })
        expect(await SessionBusy.snapshot([root.id])).toEqual({
          [root.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 0 },
        })
        expect(await (await Server.App().request(`/session/${root.id}/debts${query}`)).json()).toEqual([])
        expect((await Debt.owed(root.id)).map((debt) => debt.responder)).toEqual([id])
      },
    })
  }, 20_000)
})

describe("the /global/event heal tick", () => {
  test("a connection that missed a debt push receives the counts from the next tick", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        made.push(root.id, child.id)
        const id = await job(root.id)
        await SessionBusy.push(root.id)
        const connection = await connect("conn_missed", tmp.path, root.id)
        await connection.ticks(1)
        await connection.close()
        expect(busyFrames(connection.frames, root.id)[0]?.properties.sessions).toEqual({
          [root.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 1 },
        })
        await BackgroundJob.remove(id)
      },
    })
  }, 20_000)

  test("a scoped frame stamps every entry with the connection's directory, not the record's", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        made.push(root.id, child.id)
        await tell(child.id)
        await SessionBusy.push(root.id)
        const connection = await connect("conn_directory", "/scope/directory", root.id)
        await connection.ticks(1)
        await connection.close()
        expect(busyFrames(connection.frames, root.id)[0]?.properties.sessions).toEqual({
          [root.id]: { directory: "/scope/directory", turn: false, subagents: 1, jobs: 0 },
          [child.id]: { directory: "/scope/directory", turn: false, subagents: 0, jobs: 0 },
        })
      },
    })
  }, 20_000)

  test("a scoped frame covers only the children that owe the session or are mid-turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const owing = await Session.create({ parentID: root.id })
        const turning = await Session.create({ parentID: root.id })
        const done = await Session.create({ parentID: root.id })
        made.push(root.id, owing.id, turning.id, done.id)
        await tell(owing.id)
        await tell(done.id)
        await Recovery.deliver(root.id, [{ text: "done", synthetic: true }], done.id, { wake: false })
        SessionBusy.enter(turning.id)
        await SessionBusy.push(root.id)
        const connection = await connect("conn_children", tmp.path, root.id)
        await connection.ticks(1)
        SessionBusy.exit(turning.id)
        await connection.close()
        expect(busyFrames(connection.frames, root.id)[0]?.properties.sessions).toEqual({
          [root.id]: { directory: tmp.path, turn: false, subagents: 1, jobs: 0 },
          [owing.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 0 },
          [turning.id]: { directory: tmp.path, turn: true, subagents: 0, jobs: 0 },
        })
      },
    })
  }, 20_000)

  test("a child that goes idle between ticks gets one trailing zero entry, then drops out", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        made.push(root.id, child.id)
        await job(root.id)
        SessionBusy.enter(child.id)
        const connection = await connect("conn_trailing", tmp.path, root.id)
        await connection.ticks(1)
        SessionBusy.exit(child.id)
        const first = connection.frames.length
        await connection.ticks(1)
        const second = connection.frames.length
        await connection.ticks(1)
        const third = connection.frames.length
        await connection.close()
        const heal = (from: number, to: number) =>
          busyFrames(connection.frames.slice(from, to), root.id).map((frame) => frame.properties.sessions)
        expect(heal(0, first)).toEqual([
          {
            [root.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 1 },
            [child.id]: { directory: tmp.path, turn: true, subagents: 0, jobs: 0 },
          },
        ])
        expect(heal(first, second)).toEqual([
          {
            [root.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 1 },
            [child.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 0 },
          },
        ])
        expect(heal(second, third)).toEqual([
          { [root.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 1 } },
        ])
      },
    })
  }, 20_000)

  test("a root waiting only on a job keeps getting heal frames, then one trailing zero frame once it is paid", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const id = await job(root.id)
        const connection = await connect("conn_job", tmp.path, root.id)
        await connection.ticks(2)
        await Recovery.deliver(root.id, [{ text: "job done", synthetic: true }], id, { wake: false })
        await connection.ticks(4)
        await connection.close()
        const heals = busyFrames(connection.frames, root.id).map((frame) => frame.properties.sessions?.[root.id]?.jobs)
        // A frame per tick while owed, the payment's push, one trailing tick
        // frame, then silence.
        expect(heals.slice(-2)).toEqual([0, 0])
        expect(heals.length).toBeGreaterThanOrEqual(4)
        expect([...new Set(heals.slice(0, -2))]).toEqual([1])
        await BackgroundJob.remove(id)
      },
    })
  }, 20_000)

  test("an idle scope receives no busy frames", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const connection = await connect("conn_idle", tmp.path, root.id)
        await connection.ticks(3)
        await connection.close()
        expect(busyFrames(connection.frames, root.id)).toEqual([])
      },
    })
  }, 20_000)

  test("the overview gets a per-root session.busy frame each tick while the root is active, then one zero frame", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        await SessionRecent.touch({ sessionID: root.id, directory: tmp.path, title: "t", updated: Date.now() })
        const id = await job(root.id)
        await SessionBusy.push(root.id)
        const connection = await connect("conn_overview", tmp.path, undefined)
        await connection.ticks(2)
        const owed = connection.frames.length
        await Recovery.deliver(root.id, [{ text: "job done", synthetic: true }], id, { wake: false })
        await connection.ticks(4)
        await connection.close()

        const frames = busyFrames(connection.frames, root.id)
        expect([...new Set(frames.map((frame) => Object.keys(frame.properties.sessions ?? {}).join()))]).toEqual([
          root.id,
        ])
        const heals = frames.map((frame) => frame.properties.sessions?.[root.id]?.jobs)
        expect(heals.slice(-2)).toEqual([0, 0])
        expect(heals.length).toBeGreaterThanOrEqual(4)
        expect([...new Set(heals.slice(0, -2))]).toEqual([1])
        expect(connection.frames.slice(0, owed).filter((frame) => frame.type === "recent.updated")).toEqual([])
        await BackgroundJob.remove(id)
        await SessionRecent.remove(root.id)
      },
    })
  }, 20_000)

  test("an overview root that goes active again after its zero frame gets heal frames and a fresh zero frame", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        await SessionRecent.touch({ sessionID: root.id, directory: tmp.path, title: "t", updated: Date.now() })
        const connection = await connect("conn_again", tmp.path, undefined)
        const cycle = async () => {
          const id = await job(root.id)
          await SessionBusy.push(root.id)
          await connection.ticks(2)
          await Recovery.deliver(root.id, [{ text: "job done", synthetic: true }], id, { wake: false })
          await connection.ticks(3)
          await BackgroundJob.remove(id)
          return busyFrames(connection.frames.splice(0), root.id).map(
            (frame) => frame.properties.sessions?.[root.id]?.jobs,
          )
        }
        const first = await cycle()
        const second = await cycle()
        await connection.close()
        for (const heals of [first, second]) {
          expect(heals.slice(-2)).toEqual([0, 0])
          expect(heals.length).toBeGreaterThanOrEqual(4)
          expect([...new Set(heals.slice(0, -2))]).toEqual([1])
        }
        await SessionRecent.remove(root.id)
      },
    })
  }, 20_000)

  test("the overview corrects a hub row the live sources no longer back, with one zero frame", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        await SessionRecent.touch({ sessionID: root.id, directory: tmp.path, title: "t", updated: Date.now() })
        await SessionRecent.setBusy(root.id, { turn: false, subagents: 0, jobs: 1 })
        const connection = await connect("conn_stale", tmp.path, undefined)
        await connection.ticks(3)
        await connection.close()
        expect(busyFrames(connection.frames, root.id).map((frame) => frame.properties.sessions)).toEqual([
          { [root.id]: { directory: tmp.path, turn: false, subagents: 0, jobs: 0 } },
        ])
        const entry = (await SessionRecent.list()).find((row) => row.sessionID === root.id)
        expect({ turn: entry?.turn, subagents: entry?.subagents, jobs: entry?.jobs }).toEqual({
          turn: false,
          subagents: 0,
          jobs: 0,
        })
        await SessionRecent.remove(root.id)
      },
    })
  }, 20_000)
})

describe("the complete busy frame", () => {
  beforeAll(() => BusyHeal.recount(50))
  afterAll(() => BusyHeal.recount(HEARTBEAT_MS))

  test("SessionBusy.live lists a session mid-turn and a session owed a debt, and no idle one", async () => {
    await using project = await tmpdir({ git: true })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const turning = await Session.create({})
        const owed = await Session.create({})
        const idle = await Session.create({})
        made.push(turning.id, owed.id, idle.id)
        const id = await job(owed.id)
        SessionBusy.enter(turning.id)
        const live = await SessionBusy.live()
        SessionBusy.exit(turning.id)
        expect(live[turning.id]).toEqual({ directory: project.path, turn: true, subagents: 0, jobs: 0 })
        expect(live[owed.id]).toEqual({ directory: project.path, turn: false, subagents: 0, jobs: 1 })
        expect(live[idle.id]).toBeUndefined()
        await BackgroundJob.remove(id)
      },
    })
  }, 20_000)

  test("a claimed prompt reads as the session's turn until every claim is released", async () => {
    await using project = await tmpdir({ git: true })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        made.push(session.id)
        const first = SessionBusy.claim(session.id)
        const second = SessionBusy.claim(session.id)
        const both = (await SessionBusy.snapshot([session.id]))[session.id]
        first()
        first()
        const one = (await SessionBusy.snapshot([session.id]))[session.id]
        const listed = await SessionBusy.live()
        second()
        const none = (await SessionBusy.snapshot([session.id]))[session.id]
        expect([both.turn, one.turn, none.turn]).toEqual([true, true, false])
        expect(listed[session.id]).toEqual({ directory: project.path, turn: true, subagents: 0, jobs: 0 })
      },
    })
  }, 20_000)

  test("a client that missed the idle push learns it from the next complete frame", async () => {
    await using project = await tmpdir({ git: true })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const root = await Session.create({})
        made.push(root.id)
        const id = await job(root.id)
        const connection = await connect("conn_census", project.path, root.id)
        const listed = await until(() =>
          censuses(connection.frames).some((frame) => frame.properties.sessions?.[root.id]),
        )
        // Removing the row without a push is a missed idle push, by construction.
        await Debt.remove(id)
        const seen = censuses(connection.frames).length
        const cleared = await until(() =>
          censuses(connection.frames)
            .slice(seen)
            .some((frame) => !frame.properties.sessions?.[root.id]),
        )
        await connection.close()
        expect(listed).toBe(true)
        expect(censuses(connection.frames)[0].properties.sessions?.[root.id]).toEqual({
          directory: project.path,
          turn: false,
          subagents: 0,
          jobs: 1,
        })
        expect(cleared).toBe(true)
        await BackgroundJob.remove(id)
      },
    })
  }, 20_000)
})

describe("BusyHeal period", () => {
  test("OPENCODE_BUSY_TICK_MS sets the period only when it parses to a positive number", async () => {
    const prior = process.env.OPENCODE_BUSY_TICK_MS
    const periods: Record<string, number> = {}
    for (const raw of ["75", "0", "-5", "abc", "", "Infinity"]) {
      process.env.OPENCODE_BUSY_TICK_MS = raw
      const fresh = (await import(
        `../../src/server/routes/global.ts?tick=${encodeURIComponent(raw)}`
      )) as typeof import("../../src/server/routes/global")
      periods[raw] = fresh.BusyHeal.interval()
    }
    if (prior === undefined) delete process.env.OPENCODE_BUSY_TICK_MS
    if (prior !== undefined) process.env.OPENCODE_BUSY_TICK_MS = prior
    expect(periods).toEqual({ "75": 75, "0": 5000, "-5": 5000, abc: 5000, "": 5000, Infinity: 5000 })
  })
})
