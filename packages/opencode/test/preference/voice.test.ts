import { afterEach, describe, expect, test } from "bun:test"
import { VoicePreference } from "../../src/preference/voice"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// The store is shared with every other test file in the run.
afterEach(() => Storage.remove(["preference", "voice"]))

describe("VoicePreference.get", () => {
  test("with nothing stored, answers no voice at a version not below the clock", async () => {
    await Storage.remove(["preference", "voice"])
    const before = Date.now()
    const got = await VoicePreference.get()
    expect(got.name).toBeNull()
    expect(got.version!).toBeGreaterThanOrEqual(before)
    expect(got.version!).toBeLessThanOrEqual(Date.now())
  })
})

describe("VoicePreference.set", () => {
  test("each set stores and returns a version above the last one and not below the clock", async () => {
    await Storage.write(["preference", "voice"], { name: null })
    const before = Date.now()

    const first = await VoicePreference.set({ name: "a" })
    expect(first.name).toBe("a")
    expect(first.version!).toBeGreaterThanOrEqual(before)
    expect(await VoicePreference.get()).toEqual(first)

    const second = await VoicePreference.set({ name: "b" })
    expect(second.name).toBe("b")
    expect(second.version!).toBeGreaterThan(first.version!)
  })

  test("a value stored before versions reads without one", async () => {
    await Storage.write(["preference", "voice"], { name: "old" })

    expect(await VoicePreference.get()).toEqual({ name: "old" })
  })

  test("a lost file does not restart the version below one a client holds", async () => {
    await Storage.write(["preference", "voice"], { name: "a", version: 5 })
    await Storage.remove(["preference", "voice"])

    expect((await VoicePreference.set({ name: "b" })).version!).toBeGreaterThan(5)
  })

  test("a version ahead of the clock still goes up by one", async () => {
    const ahead = Date.now() + 1_000_000
    await Storage.write(["preference", "voice"], { name: "a", version: ahead })

    expect(await VoicePreference.set({ name: "b" })).toEqual({ name: "b", version: ahead + 1 })
  })

  test("concurrent sets each read the other's write", async () => {
    const ahead = Date.now() + 1_000_000
    await Storage.write(["preference", "voice"], { name: null, version: ahead })

    const both = await Promise.all([VoicePreference.set({ name: "a" }), VoicePreference.set({ name: "b" })])

    expect(both).toEqual([
      { name: "a", version: ahead + 1 },
      { name: "b", version: ahead + 2 },
    ])
    expect(await VoicePreference.get()).toEqual({ name: "b", version: ahead + 2 })
  })
})

describe("PUT /preference/voice", () => {
  test("the body is the name alone: a version of any shape is ignored, never rejected", async () => {
    const response = await Server.App().request("/preference/voice", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "am_adam", version: "not a number" }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).name).toBe("am_adam")
  })

  test("answers with the stored preference and its version, never the one sent", async () => {
    const stored = Date.now() + 1_000_000
    await Storage.write(["preference", "voice"], { name: null, version: stored })

    const response = await Server.App().request("/preference/voice", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "am_adam", version: stored + 5_000 }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "am_adam", version: stored + 1 })
    expect(await VoicePreference.get()).toEqual({ name: "am_adam", version: stored + 1 })
  })
})
