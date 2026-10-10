import { describe, test, expect } from "bun:test"
import path from "path"
import { Parts } from "../../src/storage/parts"
import { Messages } from "../../src/storage/messages"
import { Sessions } from "../../src/storage/sessions"
import { Storage } from "../../src/storage/storage"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Session } from "../../src/session"

function text(messageID: string, id: string, body: string): MessageV2.TextPart {
  return { id, messageID, sessionID: "ses_mig", type: "text", text: body }
}

async function seed(dir: string, part: MessageV2.TextPart) {
  await Bun.write(path.join(dir, "part", part.messageID, part.id + ".json"), JSON.stringify(part))
}

function msg(id: string, sessionID: string, created: number): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude" },
  } as MessageV2.User
}

function sess(id: string, projectID: string): Session.Info {
  return {
    id,
    slug: id,
    projectID,
    directory: "/tmp",
    title: "t",
    version: "0.0.0",
    time: { created: 1, updated: 2 },
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    total: { input: 0, output: 0, cacheWrite: 0 },
    cost: 0,
  } as unknown as Session.Info
}

describe("Parts.migrate", () => {
  test("imports every legacy JSON part as a row, leaves the files, and is idempotent", async () => {
    const dir = await Storage.ready().then((x) => x.dir)
    const msg = "msg_mig_basic"
    const small = text(msg, "prt_00000000000000200000000000", "small")
    const big = text(msg, "prt_00000000000000210000000000", "x".repeat(280 * 1024))
    await seed(dir, small)
    await seed(dir, big)

    await Parts.migrate()

    // Both files became rows for THIS message, byte-sorted, content + size exact.
    // Scoped to msg so a sibling test's seeded parts (same shared storage dir,
    // one process) can't perturb the assertion via the whole-dir glob.
    const { parts, size } = await Parts.list(msg)
    expect(parts).toEqual([small, big])
    expect(size).toBe(Buffer.byteLength(JSON.stringify(small)) + Buffer.byteLength(JSON.stringify(big)))

    // The JSON files are left in place for rollback safety.
    expect(await Bun.file(path.join(dir, "part", msg, small.id + ".json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "part", msg, big.id + ".json")).exists()).toBe(true)

    // A second run is idempotent: the rows for this message are unchanged.
    await Parts.migrate()
    expect(await Parts.list(msg)).toEqual({ parts, size })
  })

  test("does not clobber a row the live binary already wrote for the same key", async () => {
    const dir = await Storage.ready().then((x) => x.dir)
    const msg = "msg_mig_noclobber"
    const id = "prt_00000000000000220000000000"
    // Live binary wrote the current version into the table.
    await Parts.put(text(msg, id, "live"))
    // A stale JSON file for the same key exists on disk.
    await seed(dir, text(msg, id, "stale"))

    await Parts.migrate()

    // The live row survives; the stale JSON is ignored (INSERT OR IGNORE on PK).
    const { parts } = await Parts.list(msg)
    expect(parts).toEqual([text(msg, id, "live")])
  })
})

describe("Messages.migrate", () => {
  test("imports legacy message JSON as rows, ordered, non-destructive, idempotent", async () => {
    const dir = await Storage.ready().then((x) => x.dir)
    const session = "ses_msgmig"
    const a = msg("msg_mig_a", session, 100)
    const b = msg("msg_mig_b", session, 200)
    for (const m of [b, a]) await Bun.write(path.join(dir, "message", session, m.id + ".json"), JSON.stringify(m))

    await Messages.migrate()

    expect(await Messages.listSession(session)).toEqual(["msg_mig_a", "msg_mig_b"])
    expect(await Messages.read("msg_mig_a")).toEqual(a)
    // Files left in place; a second run inserts nothing new.
    expect(await Bun.file(path.join(dir, "message", session, a.id + ".json")).exists()).toBe(true)
    await Messages.migrate()
    expect(await Messages.listSession(session)).toEqual(["msg_mig_a", "msg_mig_b"])
  })
})

describe("Sessions.migrate", () => {
  test("imports legacy session JSON as rows, scoped by project, non-destructive", async () => {
    const dir = await Storage.ready().then((x) => x.dir)
    // A real projectID is the worktree PATH, so the storage key splits it into
    // many nested dirs — the file lands deep, not at session/<projectID>/. The
    // path includes a HIDDEN dir (~/.config-style), which Bun.Glob skips without
    // `dot:true`; seeding one here is what guards that flag.
    const project = "/Users/someone/.config/some-repo"
    const s = sess("ses_migx", project)
    await Bun.write(path.join(dir, "session", project, s.id + ".json"), JSON.stringify(s))

    await Sessions.migrate()

    expect((await Sessions.listProject(project)).map((x) => x.id)).toEqual([s.id])
    expect(await Sessions.read(s.id)).toEqual(s)
    expect(await Bun.file(path.join(dir, "session", project, s.id + ".json")).exists()).toBe(true)
  })
})
