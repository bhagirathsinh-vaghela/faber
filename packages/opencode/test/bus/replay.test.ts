import { beforeEach, describe, expect, test } from "bun:test"
import { EventReplay } from "../../src/bus/replay"

const frame = (n: number) => ({ payload: { type: "message.part.updated", properties: { n } } })

beforeEach(() => {
  EventReplay.reset()
})

describe("EventReplay", () => {
  test("ids are handed out in order from one", () => {
    expect(EventReplay.record(frame(1))).toBe(1)
    expect(EventReplay.record(frame(2))).toBe(2)
    expect(EventReplay.latest()).toBe(2)
  })

  // The whole point: a client that dropped its connection asks for what it
  // missed and gets exactly that, in order.
  test("replays only the frames after the client's last seen id", () => {
    EventReplay.record(frame(1))
    EventReplay.record(frame(2))
    EventReplay.record(frame(3))

    const missed = EventReplay.since(1, EventReplay.EPOCH)
    expect(missed?.map((f) => f.id)).toEqual([2, 3])
    expect(missed?.map((f) => f.event.payload.properties.n)).toEqual([2, 3])
  })

  test("a client that is already current gets nothing", () => {
    EventReplay.record(frame(1))
    expect(EventReplay.since(1, EventReplay.EPOCH)).toEqual([])
  })

  test("a client resuming from the very beginning gets everything", () => {
    EventReplay.record(frame(1))
    EventReplay.record(frame(2))
    expect(EventReplay.since(0, EventReplay.EPOCH)?.map((f) => f.id)).toEqual([1, 2])
  })

  // Reporting a partial answer as success would skip events silently, so an
  // unprovable request must be a miss and fall back to a full re-bootstrap.
  test("a request older than the buffer reports a miss rather than a partial answer", () => {
    for (let i = 0; i < EventReplay.LIMIT + 100; i++) EventReplay.record(frame(i))
    expect(EventReplay.since(1, EventReplay.EPOCH)).toBeUndefined()
  })

  test("a request newer than anything recorded reports a miss", () => {
    EventReplay.record(frame(1))
    expect(EventReplay.since(99, EventReplay.EPOCH)).toBeUndefined()
  })

  test("an empty buffer can still confirm a fully current client", () => {
    expect(EventReplay.since(0, EventReplay.EPOCH)).toEqual([])
  })

  test("a recent client is still served after thousands of evictions", () => {
    const total = EventReplay.LIMIT + 2000
    for (let i = 0; i < total; i++) EventReplay.record(frame(i))
    expect(EventReplay.latest()).toBe(total)
    expect(EventReplay.since(total, EventReplay.EPOCH)).toEqual([])
    expect(EventReplay.since(total - 2, EventReplay.EPOCH)?.map((f) => f.id)).toEqual([total - 1, total])
  })

  test("a negative cursor is a miss, never an index into the buffer", () => {
    EventReplay.record(frame(1))
    expect(EventReplay.since(-1, EventReplay.EPOCH)).toBeUndefined()
  })

  // Clients hold offsets into one shared log and are allocated nothing
  // server-side, so there is no per-client memory to leak and no disconnect
  // notification needed to release any.
  test("memory is bounded by traffic, not by how many clients exist", () => {
    for (let i = 0; i < EventReplay.LIMIT * 3; i++) EventReplay.record(frame(i))

    const cursors = [0, 1, 5, 100, 5000, 12_000, 20_000, 29_000, 29_999, 30_000]
    for (const cursor of cursors) EventReplay.since(cursor, EventReplay.EPOCH)

    expect(EventReplay.size()).toBeLessThanOrEqual(EventReplay.LIMIT)
  })

  test("a client that never returns costs nothing and gets an honest miss", () => {
    EventReplay.record(frame(1))
    const stranded = EventReplay.latest()

    for (let i = 0; i < EventReplay.LIMIT + 50; i++) EventReplay.record(frame(i))

    expect(EventReplay.since(stranded, EventReplay.EPOCH)).toBeUndefined()
    expect(EventReplay.size()).toBeLessThanOrEqual(EventReplay.LIMIT)
  })

  test("ids stay stable for every reader of one event", () => {
    const shared = frame(1)
    const first = EventReplay.record(shared)
    expect(EventReplay.idOf(shared)).toBe(first)
    expect(EventReplay.idOf(shared)).toBe(first)
    expect(EventReplay.latest()).toBe(first)
  })

  test("an id survives its frame being evicted from the window", () => {
    const early = frame(1)
    const id = EventReplay.record(early)
    for (let i = 0; i < EventReplay.LIMIT + 10; i++) EventReplay.record(frame(i))
    expect(EventReplay.idOf(early)).toBe(id)
  })

  test("a streaming turn costs memory in proportion to its event count", () => {
    let text = ""
    for (let i = 0; i < 2000; i++) {
      text += "x".repeat(40)
      EventReplay.record({
        payload: {
          type: "message.part.updated",
          properties: { part: { id: "p", type: "text", text }, delta: "x".repeat(40) },
        },
      })
    }
    const held = EventReplay.since(0, EventReplay.EPOCH)!
    expect(held.length).toBe(2000)
    expect(Buffer.byteLength(JSON.stringify(held))).toBeLessThan(1_000_000)
  })

  test("a cursor from another process is refused rather than mis-served", () => {
    for (let i = 0; i < 50; i++) EventReplay.record(frame(i))
    expect(EventReplay.since(10, "some-other-process")).toBeUndefined()
    expect(EventReplay.since(10, undefined)).toBeUndefined()
    expect(EventReplay.since(10, EventReplay.EPOCH)).toBeDefined()
  })

  test("a fractional cursor is a miss rather than silently floored", () => {
    for (let i = 0; i < 10; i++) EventReplay.record(frame(i))
    expect(EventReplay.since(1.5, EventReplay.EPOCH)).toBeUndefined()
    expect(EventReplay.since(Number.NaN, EventReplay.EPOCH)).toBeUndefined()
    expect(EventReplay.since(Number.POSITIVE_INFINITY, EventReplay.EPOCH)).toBeUndefined()
  })
})
