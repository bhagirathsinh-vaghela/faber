import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { SessionPin } from "../../src/session/pin"
import { tmpdir } from "../fixture/fixture"

describe("SessionPin", () => {
  test("new pins always see current disk; running pins never change; stop-reopen refreshes", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Version One")
      },
    })
    const provide = <R,>(fn: () => Promise<R>) => Instance.provide({ directory: tmp.path, fn })

    const running = await provide(() => SessionPin.get("ses_pin_running"))
    expect(running.instructions.project.join("\n")).toContain("# Version One")

    // Disk changes with NO reload/dispose step: a brand-new session pins the
    // new state, the running session keeps its snapshot.
    await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Version Two")
    const fresh = await provide(() => SessionPin.get("ses_pin_fresh"))
    expect(fresh.instructions.project.join("\n")).toContain("# Version Two")
    const still = await provide(() => SessionPin.get("ses_pin_running"))
    expect(still.instructions.project.join("\n")).toContain("# Version One")

    // Stop → reopen is the consent gesture: re-pin picks up current disk.
    SessionPin.drop("ses_pin_running")
    const repinned = await provide(() => SessionPin.get("ses_pin_running"))
    expect(repinned.instructions.project.join("\n")).toContain("# Version Two")
    expect(repinned).toBe(fresh)

    SessionPin.drop("ses_pin_running")
    SessionPin.drop("ses_pin_fresh")
  })

  test("identical disk shares one snapshot; entry frees when the last session drops", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Shared")
      },
    })
    const provide = <R,>(fn: () => Promise<R>) => Instance.provide({ directory: tmp.path, fn })
    const before = SessionPin.stats().entries

    const one = await provide(() => SessionPin.get("ses_share_one"))
    const two = await provide(() => SessionPin.get("ses_share_two"))
    expect(two).toBe(one)
    expect(SessionPin.stats().entries).toBe(before + 1)

    SessionPin.drop("ses_share_one")
    expect(SessionPin.stats().entries).toBe(before + 1)
    SessionPin.drop("ses_share_two")
    expect(SessionPin.stats().entries).toBe(before)
  })

  test("adopt joins the child to the parent's snapshot even after disk drifts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Parent Era")
      },
    })
    const provide = <R,>(fn: () => Promise<R>) => Instance.provide({ directory: tmp.path, fn })

    const parent = await provide(() => SessionPin.get("ses_adopt_parent"))
    await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Child Era")

    SessionPin.adopt("ses_adopt_child", "ses_adopt_parent")
    const child = await provide(() => SessionPin.get("ses_adopt_child"))
    expect(child).toBe(parent)
    expect(child.instructions.project.join("\n")).toContain("# Parent Era")

    SessionPin.drop("ses_adopt_parent")
    SessionPin.drop("ses_adopt_child")
  })
})
