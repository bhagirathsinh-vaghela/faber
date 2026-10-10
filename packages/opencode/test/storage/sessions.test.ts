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
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
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

  test("a stored record carrying removed fields still loads, without them", async () => {
    const s = session("ses_legacy", "proj_a")
    await Sessions.write({
      ...s,
      seen: { at: 5 },
      cacheMarkers: [0, 1],
      systemBlockCount: 3,
      tokens: { ...s.tokens, cacheWrite5m: 7, cacheWrite1h: 9 },
    } as Session.Info)
    expect(await Sessions.read(s.id)).toEqual(s)
    expect((await Sessions.listProject("proj_a")).find((x) => x.id === s.id)).toEqual(s)
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

  test("listProject skips a row the schema rejects and returns the rest", async () => {
    await Sessions.write(session("ses_ok", "proj_bad"))
    await Sessions.write({ ...session("ses_bad", "proj_bad"), title: 7 } as unknown as Session.Info)

    expect((await Sessions.listProject("proj_bad")).map((s) => s.id)).toEqual(["ses_ok"])
  })

  test("listProject skips a row whose JSON is torn and returns the rest", async () => {
    const { Db } = await import("../../src/storage/db")
    await Sessions.write(session("ses_whole", "proj_torn"))
    ;(await Db.open())
      .query(`INSERT INTO session (id, project_id, time_created, time_updated, json) VALUES (?, ?, 1, 1, ?)`)
      .run("ses_torn", "proj_torn", '{"id":"ses_tor')

    expect((await Sessions.listProject("proj_torn")).map((s) => s.id)).toEqual(["ses_whole"])
  })

  test("listArchived skips a row the schema rejects and returns the rest", async () => {
    const archived = (id: string) => {
      const base = session(id, "proj_archive")
      return { ...base, time: { ...base.time, archived: 5 } } as Session.Info
    }
    await Sessions.write(archived("ses_arch_ok"))
    await Sessions.write({ ...archived("ses_arch_bad"), title: 7 } as unknown as Session.Info)

    const ids = (await Sessions.listArchived()).map((s) => s.id).filter((id) => id.startsWith("ses_arch_"))
    expect(ids).toEqual(["ses_arch_ok"])
  })

  test("remove deletes the session", async () => {
    const s = session("ses_rm", "proj_a")
    await Sessions.write(s)
    const remove = await Sessions.removeQuery()
    remove.run(s.id)
    await expect(Sessions.read(s.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
  })

  test("concurrent updates on one session all survive (no lost update)", async () => {
    const s = session("ses_race", "proj_a")
    await Sessions.write(s)

    // Each update reads the current total and adds one. `normalize` awaits a
    // lazy import between the read and the write, so without a per-id lock the
    // calls interleave and increments are lost. Fire many at once and expect
    // every one to land.
    const count = 50
    await Promise.all(
      Array.from({ length: count }, () =>
        Sessions.update(s.id, (draft) => {
          draft.total.input += 1
        }),
      ),
    )

    expect((await Sessions.read(s.id)).total.input).toBe(count)
  })

  test("an old record missing tokens/total/cost reads back with the schema defaults", async () => {
    const old = {
      id: "ses_old",
      slug: "ses_old",
      projectID: "proj_a",
      directory: "/tmp",
      title: "old",
      version: "0.0.0",
      time: { created: 1, updated: 1 },
    } as unknown as Session.Info
    await Sessions.write(old)

    const read = await Sessions.read(old.id)
    expect(read.total).toEqual({ input: 0, output: 0, cacheWrite: 0 })
    expect(read.cost).toBe(0)
    expect(read.tokens.input).toBe(0)

    // A mutator like the finish-step usage write must not throw on the old record.
    const updated = await Sessions.update(old.id, (draft) => {
      draft.total.input += 5
    })
    expect(updated.total.input).toBe(5)
  })
})
