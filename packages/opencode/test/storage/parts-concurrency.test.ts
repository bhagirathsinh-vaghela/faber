import { describe, test, expect } from "bun:test"
import { Parts } from "../../src/storage/parts"
import type { MessageV2 } from "../../src/session/message-v2"

function text(messageID: string, seq: number, body: string): MessageV2.TextPart {
  // Fixed-width sequence in the id time field so ascending id == ascending seq.
  const id = "prt_" + seq.toString(16).padStart(16, "0") + "00000000000000"
  return { id, messageID, sessionID: "ses_conc", type: "text", text: body }
}

describe("Parts concurrency", () => {
  test("interleaved writers and readers on distinct messages never surface SQLITE_BUSY", async () => {
    const writers = 8
    const perWriter = 40

    const work = Array.from({ length: writers }, (_, w) => {
      const msg = "msg_conc_" + w
      return (async () => {
        for (let seq = 0; seq < perWriter; seq++) {
          await Parts.put(text(msg, seq, `w${w}-${seq}`))
          // A concurrent read of another writer's message while this one writes.
          await Parts.list("msg_conc_" + ((w + 1) % writers))
        }
      })()
    })

    // No loop rejects (busy_timeout absorbs contention; WAL lets readers run
    // against the writer without a lock fight).
    await Promise.all(work)

    // Every writer's parts are all present and in ascending id order.
    for (let w = 0; w < writers; w++) {
      const { parts } = await Parts.list("msg_conc_" + w)
      expect(parts.length).toBe(perWriter)
      expect(parts.map((p) => (p as MessageV2.TextPart).text)).toEqual(
        Array.from({ length: perWriter }, (_, seq) => `w${w}-${seq}`),
      )
    }
  })
})
