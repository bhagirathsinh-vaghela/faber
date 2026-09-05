import { describe, test, expect } from "bun:test"
import { Parts } from "../../src/storage/parts"
import { Storage } from "../../src/storage/storage"
import type { MessageV2 } from "../../src/session/message-v2"

function text(messageID: string, id: string, body: string, sessionID = "ses_test"): MessageV2.TextPart {
  return { id, messageID, sessionID, type: "text", text: body }
}

describe("Parts", () => {
  test("put then list round-trips the part and its byte size", async () => {
    const msg = "msg_roundtrip"
    const part = text(msg, "prt_00000000000000010000000000", "hello")
    await Parts.put(part)

    const { parts, size } = await Parts.list(msg)
    expect(parts).toEqual([part])
    expect(size).toBe(Buffer.byteLength(JSON.stringify(part)))
  })

  test("a second put on the same key replaces the row (last-writer-wins), not appends", async () => {
    const msg = "msg_upsert"
    const id = "prt_00000000000000020000000000"
    await Parts.put(text(msg, id, "first"))
    await Parts.put(text(msg, id, "second"))

    const { parts } = await Parts.list(msg)
    expect(parts).toEqual([text(msg, id, "second")])
  })

  test("list returns parts ordered by id ascending regardless of insertion order", async () => {
    const msg = "msg_order"
    const a = text(msg, "prt_00000000000000030000000000", "a")
    const b = text(msg, "prt_00000000000000040000000000", "b")
    const c = text(msg, "prt_00000000000000050000000000", "c")
    // Insert out of id order.
    await Parts.put(c)
    await Parts.put(a)
    await Parts.put(b)

    const { parts } = await Parts.list(msg)
    expect(parts.map((p) => p.id)).toEqual([a.id, b.id, c.id])
  })

  test("list of a message with no parts is empty with zero size", async () => {
    const { parts, size } = await Parts.list("msg_empty")
    expect(parts).toEqual([])
    expect(size).toBe(0)
  })

  test("one returns the exact part, and throws NotFoundError when absent", async () => {
    const msg = "msg_one"
    const part = text(msg, "prt_00000000000000060000000000", "only")
    await Parts.put(part)

    expect(await Parts.one(msg, part.id)).toEqual(part)
    await expect(Parts.one(msg, "prt_00000000000000990000000000")).rejects.toBeInstanceOf(Storage.NotFoundError)
  })

  test("remove deletes one part and leaves its siblings", async () => {
    const msg = "msg_remove"
    const keep = text(msg, "prt_00000000000000070000000000", "keep")
    const drop = text(msg, "prt_00000000000000080000000000", "drop")
    await Parts.put(keep)
    await Parts.put(drop)

    await Parts.remove(msg, drop.id)

    const { parts } = await Parts.list(msg)
    expect(parts).toEqual([keep])
  })

  test("remove of an absent part is a no-op", async () => {
    const msg = "msg_remove_absent"
    const part = text(msg, "prt_00000000000000090000000000", "here")
    await Parts.put(part)

    await Parts.remove(msg, "prt_0000000000000009aaaaaaaaaa")

    const { parts } = await Parts.list(msg)
    expect(parts).toEqual([part])
  })

  test("removeMessage deletes every part under the message", async () => {
    const msg = "msg_remove_all"
    await Parts.put(text(msg, "prt_0000000000000010000000000a", "one"))
    await Parts.put(text(msg, "prt_0000000000000011000000000b", "two"))

    await Parts.removeMessage(msg)

    const { parts, size } = await Parts.list(msg)
    expect(parts).toEqual([])
    expect(size).toBe(0)
  })

  test("removeSession deletes every part of the session across all its messages", async () => {
    const session = "ses_removeall"
    const msgA = "msg_rs_a"
    const msgB = "msg_rs_b"
    const other = "ses_keep"
    const otherMsg = "msg_rs_keep"
    const keep = text(otherMsg, "prt_0000000000000015000000000a", "keep", other)
    await Parts.put(text(msgA, "prt_0000000000000012000000000a", "a1", session))
    await Parts.put(text(msgB, "prt_0000000000000013000000000b", "b1", session))
    await Parts.put(keep)

    await Parts.removeSession(session)

    expect(await Parts.list(msgA)).toEqual({ parts: [], size: 0 })
    expect(await Parts.list(msgB)).toEqual({ parts: [], size: 0 })
    // A different session's parts are untouched.
    expect((await Parts.list(otherMsg)).parts).toEqual([keep])
  })
})

describe("Db.sweepOrphans", () => {
  test("reaps parts with no message and messages with no session, keeps owned rows", async () => {
    const { Messages } = await import("../../src/storage/messages")
    const { Sessions } = await import("../../src/storage/sessions")
    const { Db } = await import("../../src/storage/db")

    // A fully-owned chain that must survive.
    const session = "ses_sweep_keep"
    const ownedMsg = "msg_sweep_keep"
    await Sessions.write({
      id: session,
      projectID: "prj_sweep",
      directory: "/tmp",
      title: "t",
      version: "0",
      time: { created: 1, updated: 1 },
    } as unknown as Parameters<typeof Sessions.write>[0])
    await Messages.put({
      id: ownedMsg,
      sessionID: session,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    } as MessageV2.User)
    const ownedPart = text(ownedMsg, "prt_0000000000000016000000000a", "keep", session)
    await Parts.put(ownedPart)

    // Orphans: a part whose message never existed, a message whose session is gone.
    const orphanPart = text("msg_sweep_ghost", "prt_0000000000000017000000000b", "orphan", "ses_sweep_ghost")
    await Parts.put(orphanPart)
    await Messages.put({
      id: "msg_sweep_orphan",
      sessionID: "ses_sweep_ghost",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    } as MessageV2.User)

    await Db.sweepOrphans()

    expect(await Parts.one("msg_sweep_ghost", orphanPart.id).catch(() => undefined)).toBeUndefined()
    expect(await Messages.read("msg_sweep_orphan").catch(() => undefined)).toBeUndefined()
    // The owned chain is untouched.
    expect(await Parts.one(ownedMsg, ownedPart.id)).toEqual(ownedPart)
    expect((await Messages.read(ownedMsg)).id).toBe(ownedMsg)
  })
})
