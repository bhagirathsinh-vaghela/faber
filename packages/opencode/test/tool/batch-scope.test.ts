import { expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { BatchTool } from "../../src/tool/batch"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("a batched write in plan mode answers to the plan-file scope", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "batch in plan mode" })
      const batch = await BatchTool.init()
      const reply = await batch.execute(
        { tool_calls: [{ tool: "write", parameters: { filePath: "src/x.ts", content: "escaped" } }] },
        {
          sessionID: session.id,
          messageID: Identifier.ascending("message"),
          agent: "plan",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )
      expect(reply.output).toBe("Executed 0/1 tools successfully. 1 failed.")
      expect(await Bun.file(path.join(tmp.path, "src", "x.ts")).exists()).toBe(false)
    },
  })
})
