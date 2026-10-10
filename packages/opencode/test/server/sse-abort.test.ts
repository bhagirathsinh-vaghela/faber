import { expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// A client that drops the stream before the handler settles must still
// release its GlobalBus listener.
test("/global/event releases its listener when the client cancels at once", async () => {
  const before = GlobalBus.listenerCount("event")
  const response = await Server.App().request("/global/event")
  await response.body?.cancel()
  await Bun.sleep(200)
  expect(GlobalBus.listenerCount("event")).toBe(before)
})
