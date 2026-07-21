import { describe, expect, test } from "bun:test"
import { OpenProjects } from "../../src/project/open"

describe("OpenProjects", () => {
  test("open is idempotent by id; close removes; has reflects membership", async () => {
    const worktree = import.meta.dir // a real directory, so exists resolves true
    const entry = { id: "proj_a", worktree }
    await OpenProjects.open(entry)
    await OpenProjects.open(entry)
    expect((await OpenProjects.list()).filter((x) => x.id === "proj_a")).toEqual([{ ...entry, exists: true }])
    expect(await OpenProjects.has("proj_a")).toBe(true)

    await OpenProjects.close("proj_a")
    expect(await OpenProjects.has("proj_a")).toBe(false)
    expect((await OpenProjects.list()).filter((x) => x.id === "proj_a")).toEqual([])
  })

  test("exists is false when the worktree is missing", async () => {
    const entry = { id: "proj_missing", worktree: "/tmp/does-not-exist-" + Date.now() }
    await OpenProjects.open(entry)
    expect((await OpenProjects.list()).find((x) => x.id === "proj_missing")?.exists).toBe(false)
    await OpenProjects.close("proj_missing")
  })
})
