import { describe, expect, test } from "bun:test"
import { Plugin } from "../../src/plugin"

describe("Plugin.builtin", () => {
  test("a config without gitlab installs no builtin plugin", () => {
    expect(Plugin.builtin({})).toEqual([])
    expect(Plugin.builtin({ provider: { anthropic: {} }, enabled_providers: ["anthropic"] })).toEqual([])
  })

  test("a gitlab provider entry or enabled_providers gitlab installs the GitLab login plugin", () => {
    expect(Plugin.builtin({ provider: { gitlab: {} } })).toEqual(["@gitlab/opencode-gitlab-auth@1.3.2"])
    expect(Plugin.builtin({ enabled_providers: ["gitlab"] })).toEqual(["@gitlab/opencode-gitlab-auth@1.3.2"])
  })
})
