import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Db } from "../../src/storage/db"
import { Sessions } from "../../src/storage/sessions"
import { Messages } from "../../src/storage/messages"
import { Debt } from "../../src/storage/debt"

// The recovery sweep runs on the main thread at every boot, so its cost must
// grow with the number of sessions, never with messages per session. A long,
// fully answered session is the input that exposes a per-message lookup.
const LONG = "ses_sweep_perf_long"
const WAITING = "ses_sweep_perf_waiting"
const MESSAGES = 4000
const BUDGET_MS = 300

function info(id: string) {
  return JSON.stringify({
    id,
    slug: id,
    projectID: "p",
    directory: "/tmp",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  })
}

describe("the recovery sweep", () => {
  beforeAll(async () => {
    await Promise.all([Sessions.listProject("__warm__"), Messages.reader(), Debt.ready()])
    const db = await Db.open()
    const session = db.query(
      `INSERT OR REPLACE INTO session (id, project_id, time_created, time_updated, json) VALUES (?, 'p', 1, 1, ?)`,
    )
    const message = db.query(
      `INSERT OR REPLACE INTO message (id, session_id, time_created, json, length) VALUES (?, ?, ?, ?, 0)`,
    )
    const write = (sessionID: string, id: string, created: number, body: object) =>
      message.run(id, sessionID, created, JSON.stringify({ id, sessionID, time: { created }, ...body }))
    await Db.transaction(() => {
      session.run(LONG, info(LONG))
      for (let i = 0; i < MESSAGES; i += 2) {
        const asked = `msg_sweep_long_${String(i).padStart(6, "0")}`
        write(LONG, asked, i, { role: "user", synthetic: true })
        write(LONG, `msg_sweep_long_${String(i + 1).padStart(6, "0")}`, i + 1, { role: "assistant", parentID: asked })
      }
      // Answered once, then a result arrives that no reply has seen.
      session.run(WAITING, info(WAITING))
      write(WAITING, "msg_sweep_wait_000000", 10, { role: "user", synthetic: true })
      write(WAITING, "msg_sweep_wait_000001", 11, { role: "assistant", parentID: "msg_sweep_wait_000000" })
      write(WAITING, "msg_sweep_wait_000002", 12, { role: "user", synthetic: true })
    })
  })

  afterAll(async () => {
    const db = await Db.open()
    await Db.transaction(() => {
      for (const id of [LONG, WAITING]) {
        db.run(`DELETE FROM message WHERE session_id = ?`, [id])
        db.run(`DELETE FROM session WHERE id = ?`, [id])
      }
    })
  })

  test("finds the waiting session and not the answered one, within its budget", async () => {
    // The first call loads the session schema module and prepares the
    // statement, once per process; the budget is for the sweep itself.
    await Sessions.listUnanswered()
    const started = performance.now()
    const found = (await Sessions.listUnanswered()).map((s) => s.id)
    const elapsed = performance.now() - started
    expect(found).toContain(WAITING)
    expect(found).not.toContain(LONG)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  test("a session whose stored record is torn is skipped, not fatal", async () => {
    const db = await Db.open()
    const TORN = "ses_sweep_perf_torn"
    await Db.transaction(() => {
      db.run(
        `INSERT OR REPLACE INTO session (id, project_id, time_created, time_updated, json) VALUES (?, 'p', 1, 1, ?)`,
        [TORN, `{"id":"${TORN}",`],
      )
      db.run(`INSERT OR REPLACE INTO message (id, session_id, time_created, json, length) VALUES (?, ?, 20, ?, 0)`, [
        "msg_sweep_torn_000000",
        TORN,
        JSON.stringify({
          id: "msg_sweep_torn_000000",
          sessionID: TORN,
          role: "user",
          synthetic: true,
          time: { created: 20 },
        }),
      ])
    })
    try {
      const found = (await Sessions.listUnanswered()).map((s) => s.id)
      expect(found).toContain(WAITING)
      expect(found).not.toContain(TORN)
    } finally {
      await Db.transaction(() => {
        db.run(`DELETE FROM message WHERE session_id = ?`, [TORN])
        db.run(`DELETE FROM session WHERE id = ?`, [TORN])
      })
    }
  })

  test("the sweep seeks by index and never scans a session's messages", async () => {
    const db = await Db.open()
    const plan = db
      .query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${Sessions.WAITING}`)
      .all(0)
      .map((row) => row.detail)
    expect(plan).toContain("SEARCH r USING INDEX message_session_role_idx (session_id=? AND role=?)")
    expect(plan).toContain("SEARCH m EXISTS USING INDEX message_session_role_idx (session_id=? AND role=? AND id>?)")
    expect(plan.filter((step) => step.startsWith("SCAN") && step !== "SCAN i")).toEqual([])
  })
})
