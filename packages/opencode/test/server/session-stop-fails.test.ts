import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Debt } from "../../src/storage/debt"
import { SessionBusy } from "../../src/session/busy"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// A parent whose directory is not a valid path cannot be entered, so the
// child's Stop fails to pay its report into it.
async function blocked(dir: string) {
  const parent = await Session.create({})
  const child = await Session.create({ parentID: parent.id, title: "dig (@general subagent)" })
  await Debt.add(child.id, "subagent", parent.id)
  await Session.update(parent.id, (draft) => void (draft.directory = `\0${dir}`), { touch: false })
  const error = await Session.stop({ sessionID: child.id }).then(
    () => undefined,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  expect(error).toBe(`could not pay ${child.id} during the stop of session ${child.id}`)
  return { parent, child }
}

describe("session routes when the Stop fails", () => {
  test("DELETE still deletes the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { parent, child } = await blocked(tmp.path)
        const response = await Promise.resolve(
          Server.App().request(`/session/${child.id}?directory=${encodeURIComponent(tmp.path)}`, { method: "DELETE" }),
        ).finally(() => Session.update(parent.id, (draft) => void (draft.directory = tmp.path), { touch: false }))
        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)
        expect(await Session.get(child.id).catch(() => undefined)).toBeUndefined()
        expect(await Debt.has(child.id)).toBe(false)
        expect(await SessionBusy.debts(parent.id)).toEqual({ subagents: 0, jobs: 0 })
      },
    })
  })

  test("the archive PATCH still archives the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { parent, child } = await blocked(tmp.path)
        const archived = Date.now()
        const response = await Promise.resolve(
          Server.App().request(`/session/${child.id}?directory=${encodeURIComponent(tmp.path)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ time: { archived } }),
          }),
        ).finally(() => Session.update(parent.id, (draft) => void (draft.directory = tmp.path), { touch: false }))
        expect(response.status).toBe(200)
        expect((await Session.get(child.id)).time.archived).toBe(archived)
        await Debt.drop(child.id)
      },
    })
  })
})
