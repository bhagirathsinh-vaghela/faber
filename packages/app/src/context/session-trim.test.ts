import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { trimSessions } from "./session-trim"

const DAY = 24 * 60 * 60 * 1000

const session = (id: string, age: number, parentID?: string): Session =>
  ({
    id,
    parentID,
    projectID: "p",
    directory: "/d",
    title: id,
    version: "0",
    time: { created: Date.now() - age, updated: Date.now() - age },
  }) as Session

const roots = ["ses_a", "ses_b", "ses_c", "ses_d"].map((id) => session(id, 2 * DAY))

const ids = (list: Session[]) => list.map((s) => s.id)

describe("trimSessions", () => {
  test("drops roots past the limit that are neither recent nor held", () => {
    expect(ids(trimSessions(roots, { limit: 2, permission: {}, message: {} }))).toEqual(["ses_a", "ses_b"])
  })

  test("keeps an old root past the limit whose transcript is held", () => {
    const trimmed = trimSessions(roots, { limit: 2, permission: {}, message: { ses_d: [] } })
    expect(ids(trimmed)).toEqual(["ses_a", "ses_b", "ses_d"])
  })

  test("keeps an old child whose parent was trimmed when its transcript is held", () => {
    const child = session("ses_e", 2 * DAY, "ses_d")
    const trimmed = trimSessions([...roots, child], { limit: 2, permission: {}, message: { ses_e: [] } })
    expect(ids(trimmed)).toEqual(["ses_a", "ses_b", "ses_e"])
  })

  test("a held root that is also recent appears once", () => {
    const fresh = session("ses_f", 0)
    const trimmed = trimSessions([...roots, fresh], { limit: 2, permission: {}, message: { ses_f: [] } })
    expect(ids(trimmed)).toEqual(["ses_a", "ses_b", "ses_f"])
  })
})
