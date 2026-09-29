import { describe, expect, test } from "bun:test"
import { ModelPreference } from "../../src/preference/model"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("ModelPreference.get", () => {
  test("drops a key the schema no longer has and keeps the rest", async () => {
    await Storage.write(["preference", "model"], {
      user: [{ providerID: "anthropic", modelID: "claude-a", visibility: "show", favorite: true }],
      recent: [{ providerID: "anthropic", modelID: "claude-a" }],
      variant: { "anthropic/claude-a": "high" },
    })

    expect(await ModelPreference.get()).toEqual({
      user: [{ providerID: "anthropic", modelID: "claude-a", visibility: "show", favorite: true }],
      recent: [{ providerID: "anthropic", modelID: "claude-a" }],
    })
  })

  test("a stored value that no longer parses reads as empty", async () => {
    await Storage.write(["preference", "model"], { user: "not a list" })

    expect(await ModelPreference.get()).toEqual({ user: [], recent: [] })
  })
})
