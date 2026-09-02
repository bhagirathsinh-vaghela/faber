import { test, expect, mock } from "bun:test"
import path from "path"

mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string) => pkg,
    run: async () => {
      throw new Error("BunProc.run should not be called in tests")
    },
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))
const mockPlugin = () => ({})
mock.module("opencode-copilot-auth", () => ({ default: mockPlugin }))
mock.module("opencode-anthropic-auth", () => ({ default: mockPlugin }))
mock.module("@gitlab/opencode-gitlab-auth", () => ({ default: mockPlugin }))

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"

const REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-20250514",
  content: [{ type: "text", text: "PASS" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
}

/**
 * Drives one request through the provider's fetch wrapper and returns what
 * reached the wire. The wrapper is where the routing-only header is consumed,
 * so this is the boundary a regression on either path would show at.
 */
async function wire(headers: Record<string, string>) {
  const seen: { headers: Record<string, string>; body: any }[] = []
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getModel("anthropic", "claude-sonnet-4-20250514")
      const state = await (Provider as any).list()
      state["anthropic"].options["fetch"] = async (_url: any, init: any) => {
        const sent: Record<string, string> = {}
        for (const [key, value] of Object.entries(init.headers ?? {})) sent[key.toLowerCase()] = String(value)
        seen.push({ headers: sent, body: JSON.parse(init.body) })
        return new Response(JSON.stringify(REPLY), { status: 200, headers: { "content-type": "application/json" } })
      }
      const language = await Provider.getLanguage(model)
      await language.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        headers,
      })
    },
  })
  return seen[0]
}

test("normal path: no routing header, body untouched", async () => {
  const sent = await wire({})
  expect(sent.headers[Provider.NO_THINKING_HEADER]).toBeUndefined()
  expect(sent.body.thinking).toBeUndefined()
})

test("judge path: routing header stripped, thinking disabled on the wire", async () => {
  const sent = await wire({ [Provider.NO_THINKING_HEADER]: "1" })
  expect(sent.headers[Provider.NO_THINKING_HEADER]).toBeUndefined()
  expect(sent.body.thinking).toEqual({ type: "disabled" })
})
