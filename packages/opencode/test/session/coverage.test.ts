import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Coverage } from "../../src/session/coverage"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Debt } from "../../src/storage/debt"
import { Sessions } from "../../src/storage/sessions"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = { providerID: "anthropic", modelID: "claude-opus-5" }
const made: string[] = []

// Recovery scans the whole shared database: a session left with an unanswered
// synthetic message and no stop stamp would be woken by a later file's pass.
afterEach(async () => {
  for (const id of made.splice(0)) {
    await Sessions.update(id, (draft) => void (draft.time.stopped = Date.now() + 60_000)).catch(() => {})
    await Debt.drop(id)
  }
})

async function project(fn: (dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  await Instance.provide({ directory: dir.path, fn: () => fn(dir.path) })
}

async function root() {
  const created = await Session.create({})
  made.push(created.id)
  return created
}

async function child(parentID: string, allowedTools?: Session.AllowedTool[], owed = false) {
  const created = await Session.create({ parentID, title: "review (@build subagent)" })
  made.push(created.id)
  if (owed) await Debt.add(created.id, "subagent", parentID)
  return Session.update(created.id, (draft) => void (draft.allowedTools = allowedTools))
}

// One assistant message calling `tool` with `input`, in `status`.
async function call(sessionID: string, tool: string, input: Record<string, unknown>, status = "completed") {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: Identifier.ascending("message"),
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "tool",
    callID: Identifier.ascending("part"),
    tool,
    state:
      status === "completed"
        ? { status: "completed", input, output: "", title: "", metadata: {}, time: { start: 0, end: 0 } }
        : { status: "error", input, error: "failed", time: { start: 0, end: 0 } },
  })
  return info
}

// A user message carrying one subagent result.
async function result(sessionID: string, fields: Partial<MessageV2.BackgroundSubagentResult>) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
    synthetic: true,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text: "<background-subagent-result>",
    synthetic: true,
    backgroundSubagentResult: {
      subagentId: "ses_review",
      description: "review",
      status: "completed",
      duration: 1,
      edits: false,
      ...fields,
    },
  })
  return info
}

describe("Coverage.fingerprint", () => {
  test("moves with an edited file's content and returns when the content does", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      await call(session.id, "edit", { filePath: file })
      const before = await Coverage.fingerprint(session.id)
      await Bun.write(file, "two")
      const after = await Coverage.fingerprint(session.id)
      await Bun.write(file, "one")
      expect(after).not.toBe(before)
      expect(await Coverage.fingerprint(session.id)).toBe(before)
    })
  })

  test("a file no edit tool named, and a skill's notes file, leave it unchanged", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      await call(session.id, "write", { filePath: file })
      const before = await Coverage.fingerprint(session.id)
      await Bun.write(path.join(dir, "other.ts"), "untouched by any edit tool")
      await call(session.id, "edit", { filePath: path.join(Global.Path.state, "skill-notes", `${session.id}.md`) })
      expect(await Coverage.fingerprint(session.id)).toBe(before)
    })
  })

  test("a relative path resolves against the session's directory, and a failed edit still names its file", async () => {
    await project(async (dir) => {
      await Bun.write(path.join(dir, "rel.ts"), "one")
      const session = await root()
      const empty = await Coverage.fingerprint(session.id)
      await call(session.id, "multiedit", { filePath: "rel.ts" }, "error")
      const named = await Coverage.fingerprint(session.id)
      await Bun.write(path.join(dir, "rel.ts"), "two")
      expect(named).not.toBe(empty)
      expect(await Coverage.fingerprint(session.id)).not.toBe(named)
    })
  })

  test("apply_patch names both the updated file and its move target", async () => {
    await project(async (dir) => {
      await Bun.write(path.join(dir, "old.ts"), "one")
      const session = await root()
      await call(session.id, "apply_patch", {
        patchText: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-one\n+two\n*** End Patch",
      })
      const before = await Coverage.fingerprint(session.id)
      await Bun.write(path.join(dir, "new.ts"), "two")
      const moved = await Coverage.fingerprint(session.id)
      await Bun.write(path.join(dir, "old.ts"), "changed")
      expect(moved).not.toBe(before)
      expect(await Coverage.fingerprint(session.id)).not.toBe(moved)
    })
  })

  test("a child that can edit contributes its edits; a read-only child's are ignored", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      const reader = await child(session.id, ["read", "grep"])
      await call(reader.id, "edit", { filePath: file }, "error")
      const before = await Coverage.fingerprint(session.id)
      const writer = await child(session.id, ["read", { id: "edit", paths: [dir + "/*"] }])
      await call(writer.id, "edit", { filePath: file })
      expect(await Coverage.fingerprint(session.id)).not.toBe(before)
    })
  })
})

describe("Coverage.state", () => {
  test("only a completed read-only result asked at the current content is a review", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      await call(session.id, "edit", { filePath: file })
      const tree = await Coverage.fingerprint(session.id)
      await result(session.id, { tree, edits: true })
      await result(session.id, { tree, status: "failed" })
      await result(session.id, { tree: "stale" })
      await result(session.id, {})
      expect((await Coverage.state(session.id)).reviewed).toBe(false)
      await result(session.id, { tree })
      expect((await Coverage.state(session.id)).reviewed).toBe(true)
      await Bun.write(file, "two")
      expect((await Coverage.state(session.id)).reviewed).toBe(false)
    })
  })

  test("a result written after `until` does not count", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      const exit = await call(session.id, "edit", { filePath: file })
      await result(session.id, { tree: await Coverage.fingerprint(session.id) })
      expect((await Coverage.state(session.id, exit.id)).reviewed).toBe(false)
      expect((await Coverage.state(session.id)).reviewed).toBe(true)
    })
  })

  test("writers counts only write-capable children that still owe a result", async () => {
    await project(async () => {
      const session = await root()
      await child(session.id, ["read"], true)
      await child(session.id, ["read", "apply_patch"], true)
      await child(session.id, undefined, true)
      await child(session.id, ["edit"], false)
      expect((await Coverage.state(session.id)).writers).toBe(2)
    })
  })

  test("changed compares the content with the fingerprint taken at load", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      await call(session.id, "edit", { filePath: file })
      const loaded = await Coverage.fingerprint(session.id)
      await Session.update(session.id, (draft) => {
        draft.loaded = loaded
        draft.activeSkills = ["review-skill"]
      })
      expect(await Coverage.state(session.id)).toEqual({
        skills: ["review-skill"],
        reviewed: false,
        changed: false,
        writers: 0,
        edits: true,
      })
      await Bun.write(file, "two")
      expect((await Coverage.state(session.id)).changed).toBe(true)
    })
  })
})

describe("SessionPrompt.skillVerdict", () => {
  const exit = "LOOP-OVER:"
  const done = "LOOP-OVER: 1 rounds, last clean"

  function transcript(exit: string) {
    return [
      {
        info: { id: Identifier.ascending("message"), role: "assistant" } as MessageV2.Assistant,
        parts: [{ type: "text", text: exit }] as MessageV2.Part[],
      },
    ]
  }

  test("no exit line is no verdict", async () => {
    await project(async () => {
      const session = await root()
      expect(await SessionPrompt.skillVerdict(transcript("still going"), session.id, exit)).toBeUndefined()
    })
  })

  test("accepts reviewed content with no writer running, and names what is missing otherwise", async () => {
    await project(async (dir) => {
      const file = path.join(dir, "a.ts")
      await Bun.write(file, "one")
      const session = await root()
      await call(session.id, "edit", { filePath: file })
      const state = { skills: [], reviewed: false, changed: true, writers: 0, edits: true }
      const early = transcript(done)
      expect(await SessionPrompt.skillVerdict(early, session.id, exit)).toEqual({
        accepted: false,
        reason: "no completed read-only review of the current content",
        advice: "Run a fresh review round, then restate LOOP-OVER.",
        current: state,
      })
      await result(session.id, { tree: await Coverage.fingerprint(session.id) })
      // The review landed after the line: judged at the line it is missing, so
      // the advice is to restate rather than to review again.
      expect(await SessionPrompt.skillVerdict(early, session.id, exit)).toEqual({
        accepted: false,
        reason: "no completed read-only review of the current content",
        advice: "A review of the current content arrived after the line: restate LOOP-OVER.",
        current: { ...state, reviewed: true },
      })
      // A writer still running outranks the late review: its edits will move
      // the content the review vouched for.
      await child(session.id, ["edit"], true)
      expect(await SessionPrompt.skillVerdict(early, session.id, exit)).toEqual({
        accepted: false,
        reason: "no completed read-only review of the current content",
        advice:
          "Wait for the 1 write-capable subagent(s) to report, run a review round over the result, then restate LOOP-OVER.",
        current: { ...state, reviewed: true, writers: 1 },
      })
      const messages = transcript(done)
      expect(await SessionPrompt.skillVerdict(messages, session.id, exit)).toEqual({
        accepted: false,
        reason: "1 write-capable subagent(s) still running",
        advice:
          "Wait for the 1 write-capable subagent(s) to report, run a review round over the result, then restate LOOP-OVER.",
        current: { ...state, reviewed: true, writers: 1 },
      })
      await Debt.drop(made.at(-1)!)
      expect(await SessionPrompt.skillVerdict(messages, session.id, exit)).toEqual({
        accepted: true,
        reason: "the current content reviewed",
        advice: "",
        current: { ...state, reviewed: true },
      })
    })
  })
})
