import { describe, expect, test } from "bun:test"
import { mergeDiffBodies } from "./global-sync"

const row = (additions: number, body?: { before: string; after: string }) => ({
  file: "a.ts",
  additions,
  deletions: 0,
  status: "modified" as const,
  ...body,
})

describe("mergeDiffBodies", () => {
  test("an unchanged summary row keeps the body already fetched", () => {
    const merged = mergeDiffBodies([row(1, { before: "x", after: "y" })], [row(1)])
    expect(merged).toEqual([row(1, { before: "x", after: "y" })])
  })

  test("a row whose file changed again drops the stale body", () => {
    const merged = mergeDiffBodies([row(1, { before: "x", after: "y" })], [row(3)])
    expect(merged).toEqual([row(3)])
  })
})
