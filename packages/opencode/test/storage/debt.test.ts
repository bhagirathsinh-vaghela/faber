import { describe, test, expect } from "bun:test"
import { Db } from "../../src/storage/db"
import { Debt } from "../../src/storage/debt"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("Debt", () => {
  test("owe on a new responder opens the debt with no asks", async () => {
    const claim = await Debt.claimer()
    const outcome = await Db.transaction(() => claim.owe("ses_d_open", "subagent", "ses_d_caller1", 100))
    expect(outcome).toBe("opened")
    expect(await Debt.get("ses_d_open")).toEqual({
      responder: "ses_d_open",
      kind: "subagent",
      caller: "ses_d_caller1",
      created: 100,
      asks: 0,
    })
  })

  test("a second owe joins the open debt and counts the ask, keeping the original caller and time", async () => {
    const claim = await Debt.claimer()
    await Db.transaction(() => claim.owe("ses_d_join", "subagent", "ses_d_caller2", 200))
    const outcome = await Db.transaction(() => claim.owe("ses_d_join", "subagent", "ses_d_other", 999))
    expect(outcome).toBe("joined")
    expect(await Debt.get("ses_d_join")).toEqual({
      responder: "ses_d_join",
      kind: "subagent",
      caller: "ses_d_caller2",
      created: 200,
      asks: 1,
    })
  })

  test("join on a missing row writes nothing and reports false", async () => {
    const claim = await Debt.claimer()
    expect(await Db.transaction(() => claim.join("ses_d_missing"))).toBe(false)
    expect(await Debt.get("ses_d_missing")).toBeUndefined()
    expect(await Debt.has("ses_d_missing")).toBe(false)
  })

  test("pay removes exactly that row, and only the first pay wins", async () => {
    await Debt.add("job_d_pay1", "job", "ses_d_payer", 300)
    await Debt.add("job_d_pay2", "job", "ses_d_payer", 301)
    const claim = await Debt.claimer()
    expect(await Db.transaction(() => claim.pay("job_d_pay1"))).toBe(true)
    expect(await Db.transaction(() => claim.pay("job_d_pay1"))).toBe(false)
    expect(await Debt.has("job_d_pay1")).toBe(false)
    expect(await Debt.owed("ses_d_payer")).toEqual([
      { responder: "job_d_pay2", kind: "job", caller: "ses_d_payer", created: 301, asks: 0 },
    ])
  })

  test("owed lists only that caller's rows, in created order", async () => {
    await Debt.add("job_d_late", "job", "ses_d_owed", 520)
    await Debt.add("ses_d_early", "subagent", "ses_d_owed", 510)
    await Debt.add("job_d_foreign", "job", "ses_d_not_owed", 515)
    expect(await Debt.owed("ses_d_owed")).toEqual([
      { responder: "ses_d_early", kind: "subagent", caller: "ses_d_owed", created: 510, asks: 0 },
      { responder: "job_d_late", kind: "job", caller: "ses_d_owed", created: 520, asks: 0 },
    ])
    expect(await Debt.owing("ses_d_owed")).toBe(true)
    expect(await Debt.owing("ses_d_nobody")).toBe(false)
  })

  test("drop removes rows where the session is the caller and where it is the responder", async () => {
    await Debt.add("job_d_drop_owed", "job", "ses_d_drop", 600)
    await Debt.add("ses_d_drop", "subagent", "ses_d_drop_parent", 601)
    await Debt.add("job_d_drop_keep", "job", "ses_d_drop_parent", 602)
    await Debt.drop("ses_d_drop")
    expect(await Debt.has("job_d_drop_owed")).toBe(false)
    expect(await Debt.has("ses_d_drop")).toBe(false)
    expect(await Debt.owed("ses_d_drop_parent")).toEqual([
      { responder: "job_d_drop_keep", kind: "job", caller: "ses_d_drop_parent", created: 602, asks: 0 },
    ])
  })

  test("a throw after owe inside one transaction rolls the row back", async () => {
    const claim = await Debt.claimer()
    await expect(
      Db.transaction(() => {
        claim.owe("ses_d_rollback", "subagent", "ses_d_caller3", 700)
        throw new Error("abort after owe")
      }),
    ).rejects.toThrow("abort after owe")
    expect(await Debt.get("ses_d_rollback")).toBeUndefined()
  })

  test("a throw after join and pay inside one transaction rolls both back", async () => {
    await Debt.add("ses_d_rb_join", "subagent", "ses_d_caller4", 800)
    await Debt.add("job_d_rb_pay", "job", "ses_d_caller4", 801)
    const claim = await Debt.claimer()
    await expect(
      Db.transaction(() => {
        claim.join("ses_d_rb_join")
        claim.pay("job_d_rb_pay")
        throw new Error("abort after pay")
      }),
    ).rejects.toThrow("abort after pay")
    expect(await Debt.owed("ses_d_caller4")).toEqual([
      { responder: "ses_d_rb_join", kind: "subagent", caller: "ses_d_caller4", created: 800, asks: 0 },
      { responder: "job_d_rb_pay", kind: "job", caller: "ses_d_caller4", created: 801, asks: 0 },
    ])
  })

  test("Session.remove drops the session's debts on both sides", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const doomed = await Session.create({})
        await Debt.add(doomed.id, "subagent", parent.id, 900)
        await Debt.add("job_d_session_owed", "job", doomed.id, 901)
        await Debt.add("job_d_session_keep", "job", parent.id, 902)

        await Session.remove(doomed.id)

        expect(await Debt.has(doomed.id)).toBe(false)
        expect(await Debt.owed(doomed.id)).toEqual([])
        expect(await Debt.owed(parent.id)).toEqual([
          { responder: "job_d_session_keep", kind: "job", caller: parent.id, created: 902, asks: 0 },
        ])
      },
    })
  })
})
