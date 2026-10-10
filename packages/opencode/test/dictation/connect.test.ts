import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { WSContext } from "hono/ws"
import { Config } from "../../src/config/config"
import { Dictation } from "../../src/dictation"
import { DictationRate } from "../../src/dictation/rate"
import { DictationRecover } from "../../src/dictation/recover"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"

// A route-shaped pull: wait for the recovery under the id, then take what is held.
async function pull(id: string) {
  await DictationRecover.wait(id, 5000)
  return DictationRecover.peek(id)
}

Log.init({ print: false })

const GLOBAL = path.join(Global.Path.config, "opencode.json")

const state = { sidecar: undefined as ReturnType<typeof Bun.serve> | undefined }

async function sidecar(sampleRate: number) {
  state.sidecar = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/health") return Response.json({ sampleRate })
      return Response.json({ text: "held text", ms: 1 })
    },
  })
  await Bun.write(GLOBAL, JSON.stringify({ dictation: { url: state.sidecar.url.origin } }))
  Config.global.reset()
  DictationRate.set(sampleRate)
}

async function drop(id: string) {
  const announced = Promise.withResolvers<string>()
  const client = { send: announced.resolve, close: () => {} } as unknown as WSContext
  const handler = Dictation.connect(client, id)
  const rate = JSON.parse(await announced.promise).rate
  handler.onMessage(new Uint8Array(10).buffer)
  handler.onClose()
  return rate
}

afterEach(async () => {
  state.sidecar?.stop(true)
  await fs.rm(GLOBAL, { force: true })
  Config.global.reset()
  DictationRate.set(DictationRate.DEFAULT)
})

describe("dictation recovery", () => {
  test("a pull made the moment the socket drops receives the transcript still being finished", async () => {
    await sidecar(16000)

    expect(await drop("id-recover-race")).toBe(16000)
    expect(await pull("id-recover-race")).toBe("held text")
  })

  test("a drop under a non-default model rate recovers at the rate the client was told", async () => {
    await sidecar(24000)

    expect(await drop("id-recover-rate")).toBe(24000)
    expect(await pull("id-recover-rate")).toBe("held text")
  })
})
