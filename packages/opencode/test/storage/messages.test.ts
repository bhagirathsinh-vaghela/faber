import { describe, test, expect } from "bun:test"
import { Messages } from "../../src/storage/messages"
import { Storage } from "../../src/storage/storage"
import type { MessageV2 } from "../../src/session/message-v2"

function user(id: string, sessionID: string, created: number, ordinal?: number): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude" },
    ordinal,
  } as MessageV2.User
}

describe("Messages", () => {
  test("put then readSized round-trips the message and its byte size", async () => {
    const m = user("msg_m1", "ses_m", 1000)
    await Messages.put(m)

    const read = await Messages.readSized(m.id)
    expect(read.value).toEqual(m)
    expect(read.size).toBe(Buffer.byteLength(JSON.stringify(m)))
  })

  test("read throws NotFoundError when absent", async () => {
    await expect(Messages.read("msg_absent")).rejects.toBeInstanceOf(Storage.NotFoundError)
  })

  test("reconcile passes undefined on first write, then the stored record", async () => {
    const seen: (MessageV2.Info | undefined)[] = []
    const m = user("msg_rec", "ses_m", 2000)

    await Messages.reconcile(m.id, (stored) => {
      seen.push(stored)
      return m
    })
    await Messages.reconcile(m.id, (stored) => {
      seen.push(stored)
      return { ...m, ordinal: 5 } as MessageV2.User
    })

    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toEqual(m)
    expect((await Messages.read(m.id)) as MessageV2.User).toEqual({ ...m, ordinal: 5 } as MessageV2.User)
  })

  test("listSession returns a session's message ids ordered by time then id", async () => {
    const session = "ses_order"
    await Messages.put(user("msg_c", session, 300))
    await Messages.put(user("msg_a", session, 100))
    await Messages.put(user("msg_b", session, 200))
    // A different session must not leak in.
    await Messages.put(user("msg_other", "ses_elsewhere", 150))

    expect(await Messages.listSession(session)).toEqual(["msg_a", "msg_b", "msg_c"])
  })

  test("remove deletes one message; removeSession deletes all of a session's", async () => {
    const session = "ses_del"
    await Messages.put(user("msg_d1", session, 10))
    await Messages.put(user("msg_d2", session, 20))
    const keep = user("msg_keep", "ses_other_del", 30)
    await Messages.put(keep)

    await Messages.remove("msg_d1")
    expect(await Messages.listSession(session)).toEqual(["msg_d2"])

    await Messages.removeSession(session)
    expect(await Messages.listSession(session)).toEqual([])
    // Another session is untouched.
    expect(await Messages.listSession("ses_other_del")).toEqual([keep.id])
  })
})
