import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Project.fromDirectory", () => {
  test("identity is the directory (canonicalized), git detected for vcs/worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    const { project } = await Project.fromDirectory(tmp.path)

    expect(project.id).toBe(tmp.path)
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)
  })

  test("non-git directory is its own identity and its own worktree (not global/'/')", async () => {
    await using tmp = await tmpdir()

    const { project } = await Project.fromDirectory(tmp.path)

    expect(project.id).toBe(tmp.path)
    expect(project.worktree).toBe(tmp.path)
    expect(project.vcs).toBeUndefined()
  })

  test("two non-git directories get distinct identities (no shared global bucket)", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()

    const one = await Project.fromDirectory(a.path)
    const two = await Project.fromDirectory(b.path)

    expect(one.project.id).toBe(a.path)
    expect(two.project.id).toBe(b.path)
    expect(one.project.id).not.toBe(two.project.id)
  })

  test("does not write a .git/opencode id cache", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    expect(await Bun.file(path.join(tmp.path, ".git", "opencode")).exists()).toBe(false)
  })
})

describe("Project.fromDirectory identity vs worktree", () => {
  test("subdirectory of a repo has its OWN id but INHERITS the repo-root worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "packages", "app")
    await fs.mkdir(sub, { recursive: true })

    const { project } = await Project.fromDirectory(sub)

    // identity = the exact subdirectory (isolated sessions)
    expect(project.id).toBe(await fs.realpath(sub))
    // worktree = the git root (so AGENTS.md/skills walk-up still reaches root)
    expect(project.worktree).toBe(tmp.path)
  })

  test("a git worktree checkout has its own id, worktree resolves to the shared root", async () => {
    await using tmp = await tmpdir({ git: true })

    const worktreePath = await fs.realpath(path.dirname(tmp.path)).then((d) => path.join(d, "worktree-test"))
    await $`git worktree add ${worktreePath} -b test-branch`.cwd(tmp.path).quiet()

    const { project } = await Project.fromDirectory(worktreePath)

    expect(project.id).toBe(worktreePath)
    expect(project.worktree).toBe(tmp.path)

    await $`git worktree remove ${worktreePath}`.cwd(tmp.path).quiet()
  })
})

describe("Project.discover", () => {
  test("should discover favicon.png in root", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await Bun.write(path.join(tmp.path, "favicon.png"), pngData)

    await Project.discover(project)

    const updated = await Storage.read<Project.Info>(["project", project.id])
    expect(updated.icon).toBeDefined()
    expect(updated.icon?.url).toStartWith("data:")
    expect(updated.icon?.url).toContain("base64")
    expect(updated.icon?.color).toBeUndefined()
  })

  test("should not discover non-image files", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    await Bun.write(path.join(tmp.path, "favicon.txt"), "not an image")

    await Project.discover(project)

    const updated = await Storage.read<Project.Info>(["project", project.id])
    expect(updated.icon).toBeUndefined()
  })
})
