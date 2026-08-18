import { describe, expect, test } from "bun:test"
import path from "path"

// Three copies of this generator drifted apart in production: one reset its
// counter on any clock change and one only on a forward step, so the same
// millisecond could mint an id that already existed. A copy is undetectable by
// typecheck or by any test of behaviour, since each copy passes its own.
describe("id single source", () => {
  const root = path.join(import.meta.dir, "..", "..", "..", "..")

  const sources = async () => {
    const proc = Bun.spawn(
      ["git", "grep", "-l", "-E", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "--", "packages"],
      { cwd: root, stdout: "pipe" },
    )
    const out = await new Response(proc.stdout).text()
    return out
      .split("\n")
      .filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"))
      .filter((line) => !line.includes("/test/") && !line.includes("/dist/"))
  }

  test("only one module implements base62 id generation", async () => {
    expect(await sources()).toStrictEqual(["packages/util/src/identifier.ts"])
  })

  test("every package resolves Identifier to the shared module", async () => {
    const shared = await import("@opencode-ai/util/identifier")
    const server = await import("../../src/id/id")
    expect(server.Identifier).toBe(shared.Identifier)
  })
})
