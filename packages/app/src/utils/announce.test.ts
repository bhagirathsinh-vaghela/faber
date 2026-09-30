import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { root } from "./announce"

const session = (id: string, parentID?: string) => ({ id, parentID, title: id }) as Session

// Only a root session's finished turn is announced. The store lists roots only,
// so a subagent is judged from the server's copy, never from its absence.
describe("root — which finished turns are announced", () => {
  const listed = [session("ses_a"), session("ses_b", "ses_a")]
  const server = new Map([
    ["ses_root", session("ses_root")],
    ["ses_child", session("ses_child", "ses_root")],
  ])
  const lookup = async (id: string) => server.get(id)

  test("a listed root resolves without asking the server", async () => {
    const asked: string[] = []
    const found = await root(listed, "ses_a", async (id) => (asked.push(id), undefined))
    expect(found?.id).toBe("ses_a")
    expect(asked).toEqual([])
  })

  test("a listed subagent resolves undefined", async () => {
    expect(await root(listed, "ses_b", lookup)).toBeUndefined()
  })

  test("an unlisted root is fetched and resolves", async () => {
    expect((await root(listed, "ses_root", lookup))?.id).toBe("ses_root")
  })

  test("an unlisted subagent is fetched and resolves undefined", async () => {
    expect(await root(listed, "ses_child", lookup)).toBeUndefined()
  })

  test("a session the server no longer has resolves undefined", async () => {
    expect(await root(listed, "ses_gone", lookup)).toBeUndefined()
  })
})
