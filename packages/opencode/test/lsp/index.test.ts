import { expect, test } from "bun:test"
import path from "path"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const server = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

test("closing a project shuts its language servers down outside any instance", async () => {
  await using dir = await tmpdir({
    git: true,
    config: { lsp: { fake: { command: [process.execPath, server], extensions: [".fake"] } } },
    init: (root) => Bun.write(path.join(root, "a.fake"), "x"),
  })
  const project = await Instance.provide({
    directory: dir.path,
    fn: async () => {
      await LSP.touchFile(path.join(dir.path, "a.fake"))
      expect((await LSP.status()).map((entry) => entry.id)).toEqual(["fake"])
      return Instance.project.id
    },
  })

  await LSP.shutdownProject(project)

  const left = await Instance.provide({ directory: dir.path, fn: () => LSP.status() })
  expect(left).toEqual([])
})
