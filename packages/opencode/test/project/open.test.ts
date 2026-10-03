import { describe, expect, test } from "bun:test"
import { OpenProjects } from "../../src/project/open"

const missing = () => "/tmp/does-not-exist-" + Date.now()

describe("OpenProjects", () => {
  test("open is idempotent by id; close removes; has reflects membership", async () => {
    const entry = { id: import.meta.dir, worktree: import.meta.dir }
    await OpenProjects.open(entry)
    await OpenProjects.open(entry)
    expect((await OpenProjects.list()).filter((x) => x.id === entry.id)).toEqual([{ ...entry, exists: true }])
    expect(await OpenProjects.has(entry.id)).toBe(true)

    await OpenProjects.close(entry.id)
    expect(await OpenProjects.has(entry.id)).toBe(false)
    expect((await OpenProjects.list()).filter((x) => x.id === entry.id)).toEqual([])
  })

  // A subfolder project's worktree is the repo root, so only its own
  // directory says whether the project is still there.
  test("exists follows the project's own directory, not its worktree", async () => {
    const gone = { id: missing(), worktree: import.meta.dir }
    const present = { id: import.meta.dir, worktree: missing() }
    await OpenProjects.open(gone)
    await OpenProjects.open(present)
    const listed = await OpenProjects.list()
    expect(listed.find((x) => x.id === gone.id)?.exists).toBe(false)
    expect(listed.find((x) => x.id === present.id)?.exists).toBe(true)
    await OpenProjects.close(gone.id)
    await OpenProjects.close(present.id)
  })
})
