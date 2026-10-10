import { describe, expect, test } from "bun:test"
import { batched } from "./batched"

describe("batched", () => {
  test("a second write in the same tick keeps the first one's change", () => {
    const writes: object[] = []
    const save = batched(
      () => ({ user: [] as string[], recent: [] as string[] }),
      (doc) => writes.push(doc),
    )
    save({ user: ["shown"] })
    save({ recent: ["picked"] })
    expect(writes).toEqual([
      { user: ["shown"], recent: [] },
      { user: ["shown"], recent: ["picked"] },
    ])
  })

  test("a write in a later tick reads the store again", async () => {
    const store = { user: [] as string[], recent: [] as string[] }
    const writes: object[] = []
    const save = batched(
      () => store,
      (doc) => writes.push(doc),
    )
    save({ user: ["a"] })
    await Promise.resolve()
    store.user = ["from-server"]
    save({ recent: ["b"] })
    expect(writes[1]).toEqual({ user: ["from-server"], recent: ["b"] })
  })
})
