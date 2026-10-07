import { expect, test } from "bun:test"
import { z } from "zod"
import { Tool } from "../../src/tool/tool"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// The registry inits every tool on every step, so an object-defined tool must
// validate its arguments once per call no matter how many inits came before.
test("an object-defined tool validates once per call across repeated inits", async () => {
  const validations = { count: 0 }
  const probe = Tool.define("probe", {
    description: "probe",
    parameters: z.object({ value: z.string().refine(() => ++validations.count > 0) }),
    async execute() {
      return { title: "", output: "ok", metadata: { truncated: false } }
    },
  })

  for (let i = 0; i < 1000; i++) await probe.init()
  await (await probe.init()).execute({ value: "x" }, ctx)

  expect(validations.count).toBe(1)
})
