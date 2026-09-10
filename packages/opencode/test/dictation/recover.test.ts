import { describe, expect, test } from "bun:test"
import { DictationRecover } from "../../src/dictation/recover"

describe("dictation.recover", () => {
  test("a held transcript is returned once, then gone", () => {
    DictationRecover.put("id-a", "hello world")

    expect(DictationRecover.get("id-a")).toBe("hello world")
    expect(DictationRecover.get("id-a")).toBeUndefined()
  })

  test("an id that was never held returns undefined", () => {
    expect(DictationRecover.get("id-missing")).toBeUndefined()
  })

  test("ids do not collide", () => {
    DictationRecover.put("id-b", "first")
    DictationRecover.put("id-c", "second")

    expect(DictationRecover.get("id-c")).toBe("second")
    expect(DictationRecover.get("id-b")).toBe("first")
  })
})
