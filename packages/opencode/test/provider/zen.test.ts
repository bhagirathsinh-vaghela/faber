import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"
import { Server } from "../../src/server/server"

test("without a key the opencode provider is not loaded and there is no default model", async () => {
  await using dir = await tmpdir()
  await Instance.provide({
    directory: dir.path,
    init: async () => {
      Env.remove("OPENCODE_API_KEY")
    },
    fn: async () => {
      expect(Object.keys(await Provider.list())).toEqual([])
      expect(await Provider.defaultModel().catch((error: Error) => error.message)).toBe("no providers found")
      const response = await Server.App().request(`/provider/default?directory=${encodeURIComponent(dir.path)}`)
      expect([response.status, await response.json()]).toEqual([200, null])
    },
  })
})

test("with a key the opencode provider loads its paid and free models", async () => {
  await using dir = await tmpdir()
  await Instance.provide({
    directory: dir.path,
    init: async () => {
      Env.set("OPENCODE_API_KEY", "zen-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(Object.keys(providers)).toEqual(["opencode"])
      expect([providers["opencode"].source, providers["opencode"].key]).toEqual(["env", "zen-key"])
      expect(["claude-sonnet-4-5", "big-pickle"].map((id) => id in providers["opencode"].models)).toEqual([true, true])
      expect(await Provider.defaultModel()).toEqual({ providerID: "opencode", modelID: "gemini-3-pro" })
      expect(await Provider.getSmallModel("opencode").then((model) => model?.id)).toBe("claude-haiku-4-5")
      const models = providers["opencode"].models
      expect(Provider.sort([models["big-pickle"], models["glm-4.7"]]).map((model) => model.id)).toEqual([
        "glm-4.7",
        "big-pickle",
      ])
    },
  })
})
