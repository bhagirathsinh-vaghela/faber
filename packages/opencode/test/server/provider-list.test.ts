import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("an unconnected provider keeps its models, so old messages can still name theirs", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await Server.App().request(`/provider?directory=${encodeURIComponent(tmp.path)}`)
      const body = (await response.json()) as { all: { id: string; models: object }[]; connected: string[] }
      const anthropic = body.all.find((provider) => provider.id === "anthropic")
      expect(body.connected.includes("anthropic")).toBe(false)
      expect(Object.keys(anthropic?.models ?? {}).length > 0).toBe(true)
    },
  })
})
