import { describe, test, expect } from "bun:test"
import { Sessions } from "../../src/storage/sessions"
import { Storage } from "../../src/storage/storage"
import type { Session } from "../../src/session"

function session(id: string, projectID: string, created = 1000): Session.Info {
  return {
    id,
    slug: id,
    projectID,
    directory: "/tmp",
    title: "test",
    version: "0.0.0",
    time: { created, updated: created },
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    total: { input: 0, output: 0, cacheWrite: 0 },
    cost: 0,
  } as unknown as Session.Info
}

describe("Sessions", () => {
  test("write then read round-trips the session", async () => {
    const s = session("ses_w1", "proj_a")
    await Sessions.write(s)
    expect(await Sessions.read(s.id)).toEqual(s)
  })

  test("read throws NotFoundError when absent", async () => {
    await expect(Sessions.read("ses_absent")).rejects.toBeInstanceOf(Storage.NotFoundError)
  })

  test("update reads-modifies-writes and returns the new record", async () => {
    const s = session("ses_u1", "proj_a")
    await Sessions.write(s)

    const updated = await Sessions.update(s.id, (draft) => {
      draft.title = "renamed"
    })
    expect(updated.title).toBe("renamed")
    expect((await Sessions.read(s.id)).title).toBe("renamed")
  })

  test("update throws NotFoundError on an absent session (matches Storage.update)", async () => {
    await expect(Sessions.update("ses_missing", () => {})).rejects.toBeInstanceOf(Storage.NotFoundError)
  })

  test("listProject returns only that project's sessions", async () => {
    await Sessions.write(session("ses_p1", "proj_x"))
    await Sessions.write(session("ses_p2", "proj_x"))
    await Sessions.write(session("ses_p3", "proj_y"))

    const ids = (await Sessions.listProject("proj_x")).map((s) => s.id).sort()
    expect(ids).toEqual(["ses_p1", "ses_p2"])
  })

  test("remove deletes the session", async () => {
    const s = session("ses_rm", "proj_a")
    await Sessions.write(s)
    await Sessions.remove(s.id)
    await expect(Sessions.read(s.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
})
