import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { EventReplay } from "../../src/bus/replay"

beforeEach(() => EventReplay.reset())

describe("GlobalBus", () => {
  test("records events published while no client is connected", () => {
    expect(GlobalBus.listenerCount("event")).toBe(0)
    GlobalBus.emit("event", { payload: { type: "message.updated", properties: {} } })
    GlobalBus.emit("event", { payload: { type: "message.updated", properties: {} } })
    expect(EventReplay.latest()).toBe(2)
    expect(EventReplay.since(0, EventReplay.EPOCH)?.length).toBe(2)
  })

  test("the full EventEmitter surface survives the replay stamping", () => {
    const seen: number[] = []
    GlobalBus.once("event", () => seen.push(1))
    GlobalBus.emit("event", { payload: { type: "message.updated", properties: {} } })
    GlobalBus.emit("event", { payload: { type: "message.updated", properties: {} } })
    expect(seen).toEqual([1])
    expect(GlobalBus.listenerCount("event")).toBe(0)
  })
})
