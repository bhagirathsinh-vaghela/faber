import { describe, expect, test } from "bun:test"
import { DictationRecover } from "../../src/dictation/recover"

// A route-shaped pull: wait for the recovery under the id, then take what is held.
async function pull(id: string) {
  await DictationRecover.wait(id, 5000)
  return DictationRecover.peek(id)
}

describe("dictation.recover", () => {
  test("a held transcript is returned on every pull until released", async () => {
    DictationRecover.put("id-a", "hello world")

    expect(await pull("id-a")).toBe("hello world")
    expect(await pull("id-a")).toBe("hello world")
    DictationRecover.release("id-a")
    expect(await pull("id-a")).toBeUndefined()
  })

  test("an id that was never held returns undefined", async () => {
    expect(await pull("id-missing")).toBeUndefined()
  })

  test("ids do not collide", async () => {
    DictationRecover.put("id-b", "first")
    DictationRecover.put("id-c", "second")

    expect(await pull("id-c")).toBe("second")
    expect(await pull("id-b")).toBe("first")
  })

  test("a pull waits for the recovery tracked under its id", async () => {
    const work = Promise.withResolvers<void>()
    DictationRecover.track("id-d", work.promise)
    const pulled = pull("id-d")
    await Bun.sleep(5)
    DictationRecover.put("id-d", "late")
    work.resolve()

    expect(await pulled).toBe("late")
  })

  test("a failed recovery releases the pull with nothing held", async () => {
    DictationRecover.track("id-e", Promise.reject(new Error("sidecar gone")))

    expect(await pull("id-e")).toBeUndefined()
  })

  test("wait reports a recovery still running after its window", async () => {
    DictationRecover.track("id-f", new Promise(() => {}))

    expect(await DictationRecover.wait("id-f", 20)).toBe(false)
  })
})

describe("/dictation/recover/:id", () => {
  test("a pull lost in transit costs nothing: the transcript stays until DELETE", async () => {
    const { Server } = await import("../../src/server/server")
    DictationRecover.put("id-route", "kept")

    const lost = await Server.App().request("/dictation/recover/id-route")
    const retry = await Server.App().request("/dictation/recover/id-route")
    const released = await Server.App().request("/dictation/recover/id-route", { method: "DELETE" })
    const after = await Server.App().request("/dictation/recover/id-route")

    expect([lost.status, await lost.json()]).toEqual([200, { text: "kept" }])
    expect([retry.status, await retry.json()]).toEqual([200, { text: "kept" }])
    expect([released.status, await released.json()]).toEqual([200, true])
    expect(after.status).toBe(404)
  })
})
