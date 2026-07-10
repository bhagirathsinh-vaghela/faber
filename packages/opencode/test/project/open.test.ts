import { describe, expect, test } from "bun:test"
import { OpenProjects } from "../../src/project/open"

describe("OpenProjects", () => {
  test("open is idempotent by id; close removes; has reflects membership", () => {
    const entry = { id: "proj_a", worktree: "/tmp/a" }
    OpenProjects.open(entry)
    OpenProjects.open(entry)
    expect(OpenProjects.list().filter((x) => x.id === "proj_a")).toEqual([entry])
    expect(OpenProjects.has("proj_a")).toBe(true)

    OpenProjects.close("proj_a")
    expect(OpenProjects.has("proj_a")).toBe(false)
    expect(OpenProjects.list().filter((x) => x.id === "proj_a")).toEqual([])
  })
})
