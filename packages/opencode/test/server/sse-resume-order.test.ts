import { expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { EventReplay } from "../../src/bus/replay"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const emit = (name: string) =>
  GlobalBus.emit("event", { directory: "global", payload: { type: "test.order", properties: { name } } })

// Frames published while a resume replay is being written are held back, and
// one published while those are being flushed must queue behind them too. The
// stream accepts one unread chunk, so two replayed frames make the replay wait
// on the reader and three held frames make the flush wait on it.
test("/global/event keeps publish order across the resume backlog", async () => {
  const cursor = EventReplay.latest()
  emit("replayed-1")
  emit("replayed-2")
  const response = await Server.App().request("/global/event", {
    headers: { "last-event-id": `${EventReplay.EPOCH}:${cursor}` },
  })
  emit("held-1")
  emit("held-2")
  emit("held-3")
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const names: string[] = []
  let text = ""
  while (names.length < 6) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
    const frames = text.split("\n\n")
    text = frames.pop() ?? ""
    for (const frame of frames) {
      const line = frame.split("\n").find((entry) => entry.startsWith("data: "))
      const payload = line ? JSON.parse(line.slice(6)).payload : undefined
      if (payload?.type !== "test.order") continue
      names.push(payload.properties.name)
      if (payload.properties.name === "replayed-2") await Bun.sleep(20).then(() => emit("live"))
    }
  }
  await reader.cancel()
  expect(names).toEqual(["replayed-1", "replayed-2", "held-1", "held-2", "held-3", "live"])
})
