import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { SessionPin } from "../../src/session/pin"
import { tmpdir } from "../fixture/fixture"

describe("SessionPin", () => {
  test("pinned session keeps instructions across instance dispose; new session sees fresh state", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Version One")
      },
    })

    const before = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPin.get("ses_pin_old"),
    })
    expect(before.instructions.project.join("\n")).toContain("# Version One")

    await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Version Two")
    await Instance.provide({
      directory: tmp.path,
      fn: () => Instance.dispose(),
    })

    // Old session: pin survives dispose, still generation one.
    const pinned = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPin.get("ses_pin_old"),
    })
    expect(pinned.instructions.project.join("\n")).toContain("# Version One")

    // New session: pins the rebuilt generation.
    const fresh = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPin.get("ses_pin_new"),
    })
    expect(fresh.instructions.project.join("\n")).toContain("# Version Two")

    // Drop + re-pin: old session now re-pins against current state.
    SessionPin.drop("ses_pin_old")
    const repinned = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPin.get("ses_pin_old"),
    })
    expect(repinned.instructions.project.join("\n")).toContain("# Version Two")
  })

  test("adopt shares the parent's snapshot with the child", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Parent Era")
      },
    })

    const parent = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPin.get("ses_adopt_parent"),
    })

    await Bun.write(path.join(tmp.path, "AGENTS.md"), "# Child Era")
    await Instance.provide({
      directory: tmp.path,
      fn: () => Instance.dispose(),
    })

    SessionPin.adopt("ses_adopt_child", "ses_adopt_parent")
    const child = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPin.get("ses_adopt_child"),
    })
    expect(child).toBe(parent)
    expect(child.instructions.project.join("\n")).toContain("# Parent Era")
  })
})
