import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Debt } from "../../src/storage/debt"
import { Sessions } from "../../src/storage/sessions"
import { Messages } from "../../src/storage/messages"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { SessionBusy } from "../../src/session/busy"
import { Log } from "../../src/util/log"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { SessionPing } from "../../src/session/ping"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"
const model = { providerID: "anthropic", modelID: MODEL }

// Any model call a Stop wrongly starts lands here and is counted.
const requests: unknown[] = []
let server: ReturnType<typeof Bun.serve> | undefined
const made: string[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(await req.json())
      // A 400 is not retried, so a turn a Stop starts ends at once.
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "test server" } },
        { status: 400 },
      )
    },
  })
})

beforeEach(async () => {
  requests.length = 0
  Recovery.start()
  await Recovery.poke()
})

afterEach(async () => {
  for (const id of made.splice(0)) {
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
    await Debt.drop(id)
  }
})

afterAll(() => {
  Recovery.stop()
  server?.stop()
})

async function withProject(fn: () => Promise<void>, config: object = {}) {
  await using project = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${server!.url.origin}/v1` } } },
          ...config,
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

async function user(sessionID: string, text: string) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
  })
  await Session.updatePart({ id: Identifier.ascending("part"), messageID: info.id, sessionID, type: "text", text })
}

async function session(parentID?: string) {
  const created = await Session.create(parentID ? { parentID, title: "dig (@general subagent)" } : {})
  made.push(created.id)
  if (parentID) await Debt.add(created.id, "subagent", parentID)
  await user(created.id, "go")
  return created
}

async function parts(sessionID: string) {
  return (await Session.messages({ sessionID })).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p] : [])))
}

async function reports(sessionID: string) {
  return (await parts(sessionID)).flatMap((p) =>
    p.backgroundSubagentResult ? [[p.backgroundSubagentResult.subagentId, p.backgroundSubagentResult.status]] : [],
  )
}

async function replied(sessionID: string) {
  return (await Session.messages({ sessionID })).some((m) => m.info.role === "assistant")
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

async function settled(id: string, sessionID: string) {
  await BackgroundJob.write({
    id,
    sessionID,
    directory: Instance.directory,
    project: Instance.directory,
    command: "true",
    description: "done",
    status: "exited",
    exit: 0,
    time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
  } as unknown as BackgroundJob.Info)
  await Debt.add(id, "job", sessionID)
}

async function patch(sessionID: string, body: object) {
  return Server.App().request(`/session/${sessionID}?directory=${encodeURIComponent(Instance.directory)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function jobs(sessionID: string) {
  return (await parts(sessionID)).flatMap((p) =>
    p.backgroundJobResult ? [[p.backgroundJobResult.jobId, p.backgroundJobResult.status]] : [],
  )
}

describe("Recovery.hold", () => {
  test("a payment into a held session writes its notice without waking it, and release restores the wake", async () => {
    await withProject(async () => {
      const root = await session()
      const ids = ["job_hold_first", "job_hold_second"]
      try {
        await settled(ids[0], root.id)
        Recovery.hold([root.id])
        try {
          await Recovery.collect(root.id, { fresh: true })
        } finally {
          Recovery.release([root.id])
        }
        expect(await jobs(root.id)).toEqual([[ids[0], "completed"]])
        expect(await replied(root.id)).toBe(false)
        expect(SessionBusy.busy(root.id)).toBe(false)
        expect(requests.length).toBe(0)

        await settled(ids[1], root.id)
        await Recovery.collect(root.id, { fresh: true })
        await until(async () => (await replied(root.id)) && !SessionBusy.busy(root.id), "the released session's turn")
        expect(await jobs(root.id)).toEqual([
          [ids[0], "completed"],
          [ids[1], "completed"],
        ])
        expect(requests.length).toBe(1)
      } finally {
        for (const id of ids) {
          await Debt.remove(id)
          await BackgroundJob.remove(id)
        }
      }
    })
  }, 30_000)

  test("a payment into an archived session writes its notice without waking it, and the next message carries it", async () => {
    await withProject(async () => {
      const root = await session()
      const id = "job_archived_late"
      try {
        expect((await patch(root.id, { time: { archived: Date.now() } })).status).toBe(200)
        await settled(id, root.id)
        await Recovery.collect(root.id, { fresh: true })
        expect(await jobs(root.id)).toEqual([[id, "completed"]])
        expect(await replied(root.id)).toBe(false)
        expect(SessionBusy.busy(root.id)).toBe(false)
        expect((await Sessions.listUnanswered()).map((s) => s.id)).not.toContain(root.id)
        await Recovery.poke()
        expect(await replied(root.id)).toBe(false)
        expect(requests.length).toBe(0)

        expect((await patch(root.id, { time: { archived: null } })).status).toBe(200)
        expect((await Session.get(root.id)).time.archived).toBeUndefined()
        expect((await Sessions.listUnanswered()).map((s) => s.id)).not.toContain(root.id)
        await Recovery.poke()
        expect(await replied(root.id)).toBe(false)
        expect(requests.length).toBe(0)

        await Server.App().request(`/session/${root.id}/message?directory=${encodeURIComponent(Instance.directory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "next" }] }),
        })
        await until(async () => (await replied(root.id)) && !SessionBusy.busy(root.id), "the next message's turn")
        // The title generator also calls out; only the turn uses the session's model.
        const turns = requests.filter((r) => (r as { model: string }).model === MODEL)
        expect(turns.length).toBe(1)
        expect(JSON.stringify(turns[0])).toContain(id)
      } finally {
        await Debt.remove(id)
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("unarchiving a session mid-turn leaves its stop time alone", async () => {
    await withProject(async () => {
      const root = await session()
      const archived = Date.now()
      await Session.update(
        root.id,
        (draft) => {
          draft.time.archived = archived
          draft.turn = { at: archived, pid: process.pid, nonce: "unarchive-mid-turn" }
        },
        { touch: false },
      )
      const before = (await Session.get(root.id)).time.stopped
      expect((await patch(root.id, { time: { archived: null } })).status).toBe(200)
      const after = await Session.get(root.id)
      expect(after.time.archived).toBeUndefined()
      expect(after.time.stopped).toBe(before)
    })
  }, 30_000)

  test("overlapping holds keep a session held until the last release", async () => {
    await withProject(async () => {
      const root = await session()
      const ids = ["job_hold_overlap_first", "job_hold_overlap_second"]
      try {
        Recovery.hold([root.id])
        Recovery.hold([root.id])
        Recovery.release([root.id])
        await settled(ids[0], root.id)
        await Recovery.collect(root.id, { fresh: true })
        expect(await jobs(root.id)).toEqual([[ids[0], "completed"]])
        expect(await replied(root.id)).toBe(false)
        expect(requests.length).toBe(0)

        Recovery.release([root.id])
        await settled(ids[1], root.id)
        await Recovery.collect(root.id, { fresh: true })
        await until(async () => (await replied(root.id)) && !SessionBusy.busy(root.id), "the released session's turn")
        expect(requests.length).toBe(1)
      } finally {
        for (const id of ids) {
          await Debt.remove(id)
          await BackgroundJob.remove(id)
        }
      }
    })
  }, 30_000)
})

describe("Session.stop", () => {
  test("rejects when its own report to the live parent fails, and leaves that debt open", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const directory = Instance.directory
      await Session.update(top.id, (draft) => void (draft.directory = `\0${directory}`), { touch: false })
      try {
        const error = await Session.stop({ sessionID: middle.id }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error instanceof Error ? error.message : String(error)).toBe(
          `could not pay ${middle.id} during the stop of session ${middle.id}`,
        )
        expect(await Debt.has(middle.id)).toBe(true)
        expect(await reports(top.id)).toEqual([])
      } finally {
        await Session.update(top.id, (draft) => void (draft.directory = directory), { touch: false })
      }
    })
  }, 30_000)

  test("a job still launching (running, no process) is no failure, and its row stays for the spawn", async () => {
    await withProject(async () => {
      const top = await session()
      const id = "job_stop_launching"
      await BackgroundJob.write({
        id,
        sessionID: top.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "sleep 30",
        description: "launching",
        status: "running",
        time: { created: Date.now(), hard: Date.now() + 60_000 },
      })
      await Debt.add(id, "job", top.id)
      try {
        const error = await Session.stop({ sessionID: top.id }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeUndefined()
        expect((await BackgroundJob.get(id))?.status).toBe("running")
        expect((await Debt.owed(top.id)).map((d) => d.responder)).toEqual([id])
        expect(requests.length).toBe(0)
      } finally {
        await Debt.remove(id)
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("pays every debt in the subtree, deepest first, without waking any session", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const bottom = await session(middle.id)
      const proc = Bun.spawn({ cmd: ["sleep", "30"], detached: true, stdio: ["ignore", "ignore", "ignore"] })
      const live = (await BackgroundProcess.inspect(proc.pid))!
      const id = "job_stop_subtree"
      await BackgroundJob.write({
        id,
        sessionID: bottom.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "sleep 30",
        description: "wait",
        status: "running",
        process: { pid: live.pid, start: live.start, pgid: live.pgid },
        time: { created: Date.now(), hard: Date.now() + 60_000 },
      })
      await Debt.add(id, "job", bottom.id)
      try {
        await Session.stop({ sessionID: top.id })
        await Recovery.poke()

        expect((await BackgroundJob.get(id))?.ended).toBe("stop")
        expect(
          (await parts(bottom.id)).flatMap((p) =>
            p.backgroundJobResult ? [[p.backgroundJobResult.jobId, p.backgroundJobResult.status]] : [],
          ),
        ).toEqual([[id, "stopped"]])
        expect(await reports(middle.id)).toEqual([[bottom.id, "cancelled"]])
        expect(await reports(top.id)).toEqual([[middle.id, "cancelled"]])
        const ids = [top.id, middle.id, bottom.id]
        expect(await Promise.all(ids.map((sessionID) => Debt.owed(sessionID)))).toEqual([[], [], []])
        expect(await Debt.has(middle.id)).toBe(false)
        expect(await Debt.has(bottom.id)).toBe(false)

        // Every notice sits at or before its session's stamp, so none reads as
        // unanswered and the pass wakes none of them.
        expect(
          (await Sessions.listUnanswered()).map((s) => s.id).filter((sessionID) => ids.includes(sessionID)),
        ).toEqual([])
        const read = await Messages.reader()
        const stamped = await Promise.all(ids.map((sessionID) => Session.get(sessionID)))
        expect(stamped.map((s) => (s.time.stopped ?? 0) >= read.newest(s.id)!.time.created)).toEqual([true, true, true])
        // Deepest first: message ids ascend, so the job notice precedes the
        // report into the middle, which precedes the report into the top.
        const notice = (await parts(bottom.id)).find((p) => p.backgroundJobResult)!.messageID
        const inner = (await parts(middle.id)).find((p) => p.backgroundSubagentResult)!.messageID
        const outer = (await parts(top.id)).find((p) => p.backgroundSubagentResult)!.messageID
        expect([notice < inner, inner < outer]).toEqual([true, true])
        expect(ids.map((sessionID) => SessionBusy.busy(sessionID))).toEqual([false, false, false])
        expect(requests.length).toBe(0)
      } finally {
        proc.kill()
        await Debt.remove(id)
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("reports the stopped session to a live parent above the subtree and wakes only that parent", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const bottom = await session(middle.id)
      await Session.stop({ sessionID: middle.id })

      expect(await reports(top.id)).toEqual([[middle.id, "cancelled"]])
      expect(await reports(middle.id)).toEqual([[bottom.id, "cancelled"]])
      await until(async () => (await replied(top.id)) && !SessionBusy.busy(top.id), "the parent's woken turn")
      expect(await Promise.all([top.id, middle.id, bottom.id].map(replied))).toEqual([true, false, false])
      expect(await Debt.owed(top.id)).toEqual([])
    })
  }, 30_000)

  test("a Stop that pays a job notice leaves the session disarmed", async () => {
    await withProject(
      async () => {
        const root = await session()
        const id = "job_stop_disarmed"
        try {
          await settled(id, root.id)
          await Session.stop({ sessionID: root.id })
          expect(await jobs(root.id)).toEqual([[id, "completed"]])
          // start() arms after an unawaited config read; give it the chance.
          await Bun.sleep(200)
          expect((await Session.get(root.id)).keepWarm).not.toBe(true)
          expect(requests.length).toBe(0)
        } finally {
          SessionPing.stop(root.id)
          await Debt.remove(id)
          await BackgroundJob.remove(id)
        }
      },
      { ping: { enabled: true } },
    )
  }, 30_000)

  test("a result that sorts before a reply that never saw it still counts as unanswered", async () => {
    await withProject(async () => {
      const root = await session()
      const [asked] = (await Session.messages({ sessionID: root.id })).map((m) => m.info.id)
      const late = Identifier.ascending("message")
      await Session.updateMessage({
        id: late,
        sessionID: root.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
        synthetic: true,
      } as MessageV2.User)
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: late,
        sessionID: root.id,
        type: "text",
        text: "late",
      })
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: root.id,
        parentID: asked,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        modelID: MODEL,
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as MessageV2.Assistant)
      expect((await Messages.reader()).waiting(root.id)).toBe(true)
      expect((await Messages.reader()).pending(root.id)?.id).toBe(late)
      expect((await Sessions.listUnanswered()).map((s) => s.id)).toContain(root.id)

      // An Esc after it leaves it behind; the next result is the one waiting.
      const stopped = Date.now()
      await Session.update(root.id, (draft) => void (draft.time.stopped = stopped), { touch: false })
      await Bun.sleep(5)
      expect((await Messages.reader()).pending(root.id, stopped)).toBeUndefined()
      expect((await Messages.reader()).waiting(root.id, stopped)).toBe(false)
      const next = Identifier.ascending("message")
      await Session.updateMessage({
        id: next,
        sessionID: root.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
        synthetic: true,
      } as MessageV2.User)
      expect((await Messages.reader()).pending(root.id, stopped)?.id).toBe(next)
    })
  }, 30_000)

  test("a check-in into a session a Stop holds is dropped, and one after the release wakes it", async () => {
    await withProject(async () => {
      const root = await session()
      const id = "job_checkin_held"
      await BackgroundJob.write({
        id,
        sessionID: root.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "sleep 30",
        description: "wait",
        status: "running",
        time: { created: Date.now(), hard: Date.now() + 60_000 },
      } as unknown as BackgroundJob.Info)
      Recovery.hold([root.id])
      try {
        expect(await Recovery.notify(root.id, [{ text: "still going", synthetic: true }], id)).toBe(false)
        await Bun.sleep(200)
        expect((await parts(root.id)).map((p) => p.text)).not.toContain("still going")
        expect(await replied(root.id)).toBe(false)
        expect(requests.length).toBe(0)
      } finally {
        Recovery.release([root.id])
      }
      try {
        expect(await Recovery.notify(root.id, [{ text: "still going", synthetic: true }], id)).toBe(true)
        expect((await parts(root.id)).map((p) => p.text)).toContain("still going")
        await until(() => requests.some((r) => (r as { model: string }).model === MODEL), "the check-in's turn")
      } finally {
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("a result after an Esc is woken even when an older unanswered one sits before the stop", async () => {
    await withProject(async () => {
      const root = await session()
      const [asked] = (await Session.messages({ sessionID: root.id })).map((m) => m.info.id)
      const now = Date.now()
      const result = async (created: number) => {
        const id = Identifier.ascending("message")
        await Session.updateMessage({
          id,
          sessionID: root.id,
          role: "user",
          time: { created },
          agent: "build",
          model,
          synthetic: true,
        } as MessageV2.User)
        await Session.updatePart({ id: Identifier.ascending("part"), messageID: id, sessionID: root.id, type: "text", text: "result" })
        return id
      }
      await result(now - 40_000)
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: root.id,
        parentID: asked,
        role: "assistant",
        time: { created: now - 35_000, completed: now - 35_000 },
        modelID: MODEL,
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as MessageV2.Assistant)
      await Session.update(root.id, (draft) => void (draft.time.stopped = now - 30_000), { touch: false })
      await result(now - 20_000)

      await Recovery.poke()
      await until(() => requests.some((r) => (r as { model: string }).model === MODEL), "the result's woken turn")
    })
  }, 30_000)

  test("an interrupted child reads as interrupted when an older unanswered message sits before its stop", async () => {
    await withProject(async () => {
      const parent = await session()
      const child = await session(parent.id)
      const [asked] = (await Session.messages({ sessionID: child.id })).map((m) => m.info.id)
      const now = Date.now()
      const older = Identifier.ascending("message")
      await Session.updateMessage({
        id: older,
        sessionID: child.id,
        role: "user",
        time: { created: now - 40_000 },
        agent: "build",
        model,
        synthetic: true,
      } as MessageV2.User)
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: child.id,
        parentID: asked,
        role: "assistant",
        time: { created: now - 35_000, completed: now - 35_000 },
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
        modelID: MODEL,
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as MessageV2.Assistant)
      await Session.update(child.id, (draft) => void (draft.time.stopped = now - 30_000), { touch: false })

      expect((await Recovery.debts(parent.id)).map((d) => [d.responder, d.state])).toEqual([[child.id, "interrupted"]])
    })
  }, 30_000)

  test("a child stopped with a message unanswered is not reported done with its previous reply", async () => {
    await withProject(async () => {
      const parent = await session()
      const child = await session(parent.id)
      const [asked] = (await Session.messages({ sessionID: child.id })).map((m) => m.info.id)
      const now = Date.now()
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: child.id,
        parentID: asked,
        role: "assistant",
        time: { created: now - 50_000, completed: now - 50_000 },
        modelID: MODEL,
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as MessageV2.Assistant)
      const followup = Identifier.ascending("message")
      await Session.updateMessage({
        id: followup,
        sessionID: child.id,
        role: "user",
        time: { created: now - 40_000 },
        agent: "build",
        model,
        synthetic: true,
      } as MessageV2.User)
      await Session.update(child.id, (draft) => void (draft.time.stopped = now - 30_000), { touch: false })

      await Recovery.collect(parent.id, { fresh: true })

      expect(await reports(parent.id)).toEqual([])
      expect(await Debt.has(child.id)).toBe(true)
      expect((await Recovery.debts(parent.id)).map((d) => [d.responder, d.state])).toEqual([[child.id, "interrupted"]])
    })
  }, 30_000)

  test("a stop drops a message unanswered when it landed, and only that", async () => {
    await withProject(async () => {
      const root = await session()
      const [asked] = (await Session.messages({ sessionID: root.id })).map((m) => m.info.id)
      const now = Date.now()
      const write = async (created: number) => {
        const id = Identifier.ascending("message")
        await Session.updateMessage({
          id,
          sessionID: root.id,
          role: "user",
          time: { created },
          agent: "build",
          model,
          synthetic: true,
        } as MessageV2.User)
        return id
      }
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: root.id,
        parentID: asked,
        role: "assistant",
        time: { created: now - 50_000, completed: now - 50_000 },
        modelID: MODEL,
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as MessageV2.Assistant)
      const reader = await Messages.reader()
      // A reply nothing is waiting on was neither aborted nor cut.
      expect(reader.interrupted(root.id)).toBe(false)

      await write(now - 40_000)
      const stopped = now - 30_000
      // Never stopped: an unanswered message is waiting, not dropped.
      expect(reader.interrupted(root.id)).toBe(false)
      expect(reader.waiting(root.id)).toBe(true)
      // Stopped after it landed: the stop dropped it.
      expect(reader.interrupted(root.id, stopped)).toBe(true)
      expect(reader.waiting(root.id, stopped)).toBe(false)

      // A message written after the stop is waiting again, and the session
      // is no longer read as cut.
      await write(now - 20_000)
      expect(reader.interrupted(root.id, stopped)).toBe(false)
      expect(reader.waiting(root.id, stopped)).toBe(true)
    })
  }, 30_000)

  test("a check-in into an archived session is dropped", async () => {
    await withProject(async () => {
      const root = await session()
      const id = "job_checkin_archived"
      await BackgroundJob.write({
        id,
        sessionID: root.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "sleep 30",
        description: "wait",
        status: "running",
        time: { created: Date.now(), hard: Date.now() + 60_000 },
      } as unknown as BackgroundJob.Info)
      try {
        await Session.update(root.id, (draft) => void (draft.time.archived = Date.now()), { touch: false })
        expect(await Recovery.notify(root.id, [{ text: "still going", synthetic: true }], id)).toBe(false)
        expect((await parts(root.id)).map((p) => p.text)).not.toContain("still going")
        expect(requests.length).toBe(0)
      } finally {
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("stopping a child that already reported pays its own child without reporting to the parent again", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const bottom = await session(middle.id)
      await Debt.remove(middle.id)
      await Session.stop({ sessionID: middle.id })

      expect(await reports(middle.id)).toEqual([[bottom.id, "cancelled"]])
      expect(await Debt.has(bottom.id)).toBe(false)
      expect(await Debt.has(middle.id)).toBe(false)
      expect(await reports(top.id)).toEqual([])
      expect(await replied(top.id)).toBe(false)
      expect(requests.length).toBe(0)
    })
  }, 30_000)

  test("stopping a child that already reported pays its job without reporting it to the parent again", async () => {
    await withProject(async () => {
      const top = await session()
      const child = await session(top.id)
      const id = "job_after_report"
      try {
        await Debt.remove(child.id)
        await settled(id, child.id)
        await Session.stop({ sessionID: child.id })

        expect(await jobs(child.id)).toEqual([[id, "completed"]])
        expect(await Debt.has(child.id)).toBe(false)
        expect(await reports(top.id)).toEqual([])
        expect(await replied(top.id)).toBe(false)
        expect(requests.length).toBe(0)
      } finally {
        await Debt.remove(id)
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("a child deleted mid-walk is no failure, and the rest is still paid", async () => {
    await withProject(async () => {
      const top = await session()
      const gone = await session(top.id)
      const kept = await session(top.id)
      const removing: Promise<void>[] = []
      const off = Bus.subscribe(Session.Event.Updated, (event) => {
        if (event.properties.info.id !== gone.id || !event.properties.info.time.stopped || removing.length > 0) return
        removing.push(Session.remove(gone.id))
      })
      try {
        await Session.stop({ sessionID: top.id })
        await Promise.all(removing)
      } finally {
        off()
      }

      expect(removing.length).toBe(1)
      expect(await reports(top.id)).toEqual([[kept.id, "cancelled"]])
      expect(await Debt.owed(top.id)).toEqual([])
      expect(requests.length).toBe(0)
    })
  }, 30_000)

  test("pays a debt this process had given up on after repeated failures", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const directory = Instance.directory
      // A caller whose directory is not a valid path cannot be entered, so
      // every payment into it throws and strikes the debt.
      const blocked = `\0${directory}`
      await Session.update(top.id, (draft) => void (draft.directory = blocked), { touch: false })
      for (const _ of [1, 2, 3]) await Recovery.collect(middle.id, { fresh: true })
      await Session.update(top.id, (draft) => void (draft.directory = directory), { touch: false })
      expect((await Recovery.debts(top.id)).find((d) => d.responder === middle.id)?.stuck).toBe(true)

      await Session.stop({ sessionID: middle.id })

      expect(await reports(top.id)).toEqual([[middle.id, "cancelled"]])
      expect(await Debt.has(middle.id)).toBe(false)
    })
  }, 30_000)

  test("every session in the subtree is stamped before any is paid", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const bottom = await session(middle.id)
      const ids = [top.id, middle.id, bottom.id]
      const order: string[] = []
      const stamps = Bus.subscribe(Session.Event.Updated, (event) => {
        const info = event.properties.info
        if (ids.includes(info.id) && info.time.stopped && !order.includes(`stamp ${info.id}`))
          order.push(`stamp ${info.id}`)
      })
      const notices = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
        const part = event.properties.part
        if (part.type === "text" && part.backgroundSubagentResult)
          order.push(`paid ${part.backgroundSubagentResult.subagentId}`)
      })
      try {
        await Session.stop({ sessionID: top.id })
      } finally {
        stamps()
        notices()
      }

      expect(order.slice(3)).toEqual([`paid ${bottom.id}`, `paid ${middle.id}`])
      expect(order.slice(0, 3).toSorted()).toEqual(ids.map((id) => `stamp ${id}`).toSorted())
    })
  }, 30_000)
  test("reports a job payment that failed, after still paying its own report to the parent", async () => {
    await withProject(async () => {
      const top = await session()
      const middle = await session(top.id)
      const directory = Instance.directory
      const id = "job_stop_unpayable"
      await settled(id, middle.id)
      // A caller whose directory is not a valid path cannot be entered, so
      // the job notice into it throws.
      await Session.update(middle.id, (draft) => void (draft.directory = `\0${directory}`), { touch: false })
      try {
        const error = await Session.stop({ sessionID: middle.id }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error instanceof Error ? error.message : String(error)).toBe(
          `could not pay ${id} during the stop of session ${middle.id}`,
        )
        expect(await reports(top.id)).toEqual([[middle.id, "cancelled"]])
        expect(await Debt.has(middle.id)).toBe(false)
        expect((await Debt.owed(middle.id)).map((d) => d.responder)).toEqual([id])
      } finally {
        await Session.update(middle.id, (draft) => void (draft.directory = directory), { touch: false })
        await Debt.remove(id)
        await BackgroundJob.remove(id)
      }
    })
  }, 30_000)

  test("cancels a child whose turn runs in another directory, in that directory's instance", async () => {
    await withProject(async () => {
      const top = await session()
      // A child in a second project, with its own in-flight turn registered in
      // that directory's SessionBusy bucket. SessionBusy.busy scans every
      // directory, so a cancel run in the wrong directory removes nothing and
      // the child reads busy still: only a cancel entering the child's own
      // directory clears it.
      await using other = await tmpdir({
        git: true,
        init: async (dir) =>
          Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"] }),
          ),
      })
      const child = await Instance.provide({
        directory: other.path,
        fn: async () => {
          const created = await Session.create({ parentID: top.id, title: "dig (@general subagent)" })
          made.push(created.id)
          await Debt.add(created.id, "subagent", top.id)
          SessionBusy.enter(created.id)
          return created
        },
      })
      expect(SessionBusy.busy(child.id)).toBe(true)

      await Session.stop({ sessionID: top.id })

      expect(SessionBusy.busy(child.id)).toBe(false)
      expect((await Session.get(child.id)).time.stopped).toBeGreaterThan(0)
      expect(await reports(top.id)).toEqual([[child.id, "cancelled"]])
    })
  }, 30_000)
})
