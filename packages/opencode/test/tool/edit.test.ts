import { describe, expect, test } from "bun:test"
import path from "path"
import ts from "typescript"
import { replace } from "../../src/tool/edit"

describe("edit replace", () => {
  test("writes new text holding replacement patterns verbatim", () => {
    expect(replace("pid=X\n", "X", "$$ $& $` $'")).toBe("pid=$$ $& $` $'\n")
    expect(replace("a X b X", "X", "$$", true)).toBe("a $$ b $$")
  })
})

// A string replacement reads `$$`, `$&`, `` $` `` and `$'` as patterns, so
// inserting text through one rewrites it; `swap` (util/text.ts) is the one way
// in. A literal or a replacer function is the only safe second argument.
test("no source file inserts computed text through a string replacement", async () => {
  const src = path.join(import.meta.dir, "../../src")
  const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: src }))
  const safe = (node: ts.Expression) =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  const hits = await Promise.all(
    files.map(async (file) => {
      const source = ts.createSourceFile(
        file,
        await Bun.file(path.join(src, file)).text(),
        ts.ScriptTarget.Latest,
        true,
      )
      const found: string[] = []
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["replace", "replaceAll"].includes(node.expression.name.text) &&
          node.arguments.length === 2 &&
          !safe(node.arguments[1])
        )
          found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText()}`)
        ts.forEachChild(node, visit)
      }
      visit(source)
      return found
    }),
  )
  expect(hits.flat()).toEqual([])
})
