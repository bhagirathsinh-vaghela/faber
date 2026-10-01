import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { announced, audible } from "./announce"

const session = (id: string, parentID?: string) => ({ id, parentID, title: id }) as Session

// A finished turn is announced for a root, or for the session this client has
// open. The store lists roots only, so a subagent is judged from the server's
// copy, never from its absence.
describe("announced — which finished turns are announced", () => {
  const listed = [session("ses_a"), session("ses_b", "ses_a")]
  const server = new Map([
    ["ses_root", session("ses_root")],
    ["ses_child", session("ses_child", "ses_root")],
  ])
  const lookup = async (id: string) => server.get(id)

  test("a listed root resolves without asking the server", async () => {
    const asked: string[] = []
    const found = await announced(listed, "ses_a", false, async (id) => (asked.push(id), undefined))
    expect(found?.id).toBe("ses_a")
    expect(asked).toEqual([])
  })

  test("a listed subagent resolves undefined", async () => {
    expect(await announced(listed, "ses_b", false, lookup)).toBeUndefined()
  })

  test("an unlisted root is fetched and resolves", async () => {
    expect((await announced(listed, "ses_root", false, lookup))?.id).toBe("ses_root")
  })

  test("an unlisted subagent is fetched and resolves undefined", async () => {
    expect(await announced(listed, "ses_child", false, lookup)).toBeUndefined()
  })

  test("a subagent this client has open resolves", async () => {
    expect((await announced(listed, "ses_child", true, lookup))?.id).toBe("ses_child")
  })

  test("a session the server no longer has resolves undefined, even when open", async () => {
    expect(await announced(listed, "ses_gone", true, lookup)).toBeUndefined()
  })
})

// Silent only for the session on screen in a tab the person is in; a hidden or
// unfocused tab, or any other session, still sounds.
describe("audible — when a session's sound plays", () => {
  const page = (visibilityState: DocumentVisibilityState, focused: boolean) => ({
    visibilityState,
    hasFocus: () => focused,
  })

  test.each([
    ["open, visible and focused", true, page("visible", true), false],
    ["open, visible but unfocused", true, page("visible", false), true],
    ["open in a hidden tab", true, page("hidden", false), true],
    ["another session, focused", false, page("visible", true), true],
  ] as const)("%s", (_, open, state, expected) => {
    expect(audible(open, state)).toBe(expected)
  })
})
