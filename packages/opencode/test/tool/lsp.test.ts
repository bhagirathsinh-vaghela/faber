import { expect, test } from "bun:test"
import path from "path"
import { LspTool } from "../../src/tool/lsp"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const server = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

test("workspaceSymbol with filePath starts that file's servers on a cold pool", async () => {
  await using dir = await tmpdir({
    git: true,
    config: { lsp: { fake: { command: [process.execPath, server], extensions: [".fake"] } } },
    init: (root) => Bun.write(path.join(root, "a.fake"), "x"),
  })
  await Instance.provide({
    directory: dir.path,
    fn: async () => {
      expect(await LSP.status()).toEqual([])
      const lsp = await LspTool.init()
      const found = await lsp.execute({ operation: "workspaceSymbol", query: "foo", filePath: "a.fake" }, ctx)
      expect((await LSP.status()).map((entry) => entry.id)).toEqual(["fake"])
      expect(found.metadata.result).toEqual([
        {
          name: "foo",
          kind: 12,
          location: {
            uri: "file:///fake.fake",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        },
      ])
      await LSP.shutdownProject(Instance.project.id)
    },
  })
})
