import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Liveness } from "../../src/project/liveness"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { tmpdir } from "../fixture/fixture"

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Liveness refcount", () => {
  test("a directory is alive while any session is busy or armed", () => {
    const dir = "/liveness/refcount"

    Liveness.setBusy(dir, "ses_a", true)
    expect(Liveness.alive(dir)).toBe(true)

    Liveness.setBusy(dir, "ses_a", false)
    expect(Liveness.alive(dir)).toBe(false)

    Liveness.setArmed(dir, "ses_a", true)
    expect(Liveness.alive(dir)).toBe(true)

    Liveness.setArmed(dir, "ses_a", false)
    expect(Liveness.alive(dir)).toBe(false)
  })

  test("stays alive until both the busy and armed users of the same session leave", () => {
    const dir = "/liveness/both-axes"

    Liveness.setBusy(dir, "ses_a", true)
    Liveness.setArmed(dir, "ses_a", true)
    Liveness.setBusy(dir, "ses_a", false)
    expect(Liveness.alive(dir)).toBe(true)

    Liveness.setArmed(dir, "ses_a", false)
    expect(Liveness.alive(dir)).toBe(false)
  })

  test("stays alive until every session leaves", () => {
    const dir = "/liveness/two-sessions"

    Liveness.setBusy(dir, "ses_a", true)
    Liveness.setBusy(dir, "ses_b", true)
    Liveness.setBusy(dir, "ses_a", false)
    expect(Liveness.alive(dir)).toBe(true)

    Liveness.setBusy(dir, "ses_b", false)
    expect(Liveness.alive(dir)).toBe(false)
  })

  test("a busy child keeps its directory alive while the parent is idle", () => {
    const dir = "/liveness/child"

    // Child and parent share one directory; the child is never armed (subtasks
    // don't ping), so it only ever holds the busy axis.
    Liveness.setBusy(dir, "ses_child", true)
    expect(Liveness.alive(dir)).toBe(true)

    Liveness.setBusy(dir, "ses_child", false)
    expect(Liveness.alive(dir)).toBe(false)
  })
})

describe("Liveness auto-dispose", () => {
  test("disposes the instance after its last live session goes idle", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        SessionPing.start(session.id)
        await settle(50)
        expect(Liveness.alive(tmp.path)).toBe(true)

        // Disarming is the last live user leaving; the grace timer then disposes.
        SessionPing.stop(session.id)
        expect(Liveness.alive(tmp.path)).toBe(false)

        await settle(3200)
        expect(Liveness.alive(tmp.path)).toBe(false)
      },
    })
  })

  test("a re-arm within the grace window cancels the pending dispose", async () => {
    const dir = "/liveness/grace-cancel"

    Liveness.setArmed(dir, "ses_a", true)
    Liveness.setArmed(dir, "ses_a", false)
    Liveness.setArmed(dir, "ses_a", true)
    await settle(3200)
    expect(Liveness.alive(dir)).toBe(true)

    Liveness.setArmed(dir, "ses_a", false)
  })
})
