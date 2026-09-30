import { expect, test } from "bun:test"
import type { VoicePreference } from "@opencode-ai/sdk/v2/client"
import { newer, picker, seedVoice, serial, spokenVoice, voiceApplier, voiceStore } from "./voice"

test("a reading is voiced in the saved voice, else the config default", () => {
  expect(spokenVoice("am_adam", "af_config")).toBe("am_adam")
  expect(spokenVoice("", "af_config")).toBe("af_config")
  expect(spokenVoice("", undefined)).toBe("")
})

test("saves run one at a time in the order asked, and a failed one does not hold up the next", async () => {
  const run = serial()
  const log: string[] = []
  const slow = Promise.withResolvers<void>()
  const first = run(async () => {
    log.push("first start")
    await slow.promise
    log.push("first end")
    throw new Error("first failed")
  })
  const second = run(async () => {
    log.push("second start")
    return "second"
  })
  await Bun.sleep(1)
  expect(log).toEqual(["first start"])
  slow.resolve()
  await expect(first).rejects.toThrow("first failed")
  expect(await second).toBe("second")
  expect(log).toEqual(["first start", "first end", "second start"])
})

test("the picker shows the latest pick until that pick's save settles, either way", async () => {
  const saves = new Map<string, PromiseWithResolvers<void>>()
  const choice = picker((id) => {
    const save = Promise.withResolvers<void>()
    saves.set(id, save)
    return save.promise
  })
  const first = choice.pick("am_adam")
  const second = choice.pick("bf_emma")
  expect(choice.pending()).toBe("bf_emma")
  saves.get("am_adam")!.resolve()
  await first
  expect(choice.pending()).toBe("bf_emma")
  saves.get("bf_emma")!.reject(new Error("offline"))
  await second
  expect(choice.pending()).toBeUndefined()
})

test("a directory store starts on the saved voice, in its own object", () => {
  const global = { name: "bf_emma", version: 3 }
  const seeded = seedVoice(global)
  expect(seeded).toEqual({ name: "bf_emma", version: 3 })
  expect(seeded).not.toBe(global)
  expect(seedVoice({ name: null })).toEqual({ name: null })
})

test("the voice the layout mounted with is not a change", () => {
  let revoiced = 0
  const apply = voiceApplier("bf_emma", () => revoiced++)
  apply("bf_emma")
  expect(revoiced).toBe(0)
})

test("the same voice twice re-voices once; each different one re-voices", () => {
  let revoiced = 0
  const apply = voiceApplier("", () => revoiced++)
  apply("am_adam")
  apply("am_adam")
  expect(revoiced).toBe(1)
  apply("")
  expect(revoiced).toBe(2)
  apply("am_adam")
  expect(revoiced).toBe(3)
})

test("a newer or equal version applies; an older one does not", () => {
  expect(newer({ name: "a", version: 2 }, { name: "b", version: 3 })).toBe(true)
  expect(newer({ name: "a", version: 2 }, { name: "b", version: 1 })).toBe(false)
  expect(newer({ name: "a", version: 2 }, { name: "a", version: 2 })).toBe(true)
})

test("a value without a version counts as version 0", () => {
  expect(newer({ name: null }, { name: "x" })).toBe(true)
  expect(newer({ name: "a", version: 1 }, { name: "old" })).toBe(false)
})

test("the store takes a newer or equal voice and ignores an older one", () => {
  const store = { value: { name: "o", version: 1 } as VoicePreference, writes: 0 }
  const set = voiceStore(
    () => store.value,
    (preference) => {
      store.value = preference
      store.writes++
    },
  )
  set({ name: "a", version: 2 })
  set({ name: "o", version: 1 })
  expect(store.value).toEqual({ name: "a", version: 2 })
  set({ name: "a", version: 2 })
  expect(store.value).toEqual({ name: "a", version: 2 })
  expect(store.writes).toBe(2)
})
