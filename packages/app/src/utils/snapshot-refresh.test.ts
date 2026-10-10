import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { Snapshot } from "./snapshot"

const messages = [{ id: "m1", sessionID: "s", role: "user", time: { created: 1 } }] as Message[]

describe("Snapshot.fingerprint", () => {
  test("an unchanged tail reads unchanged within one refresh period", () => {
    expect(Snapshot.fingerprint(messages, {}, 20_000)).toBe(Snapshot.fingerprint(messages, {}, 29_999))
  })

  test("an unchanged tail still changes once a refresh period passes, so an idle record is rewritten", () => {
    expect(Snapshot.fingerprint(messages, {}, 20_000)).not.toBe(Snapshot.fingerprint(messages, {}, 30_000))
  })
})
