import { describe, expect, test } from "bun:test"
import { splitBlocks, completeTail } from "./markdown"
import { scanCalloutDepth } from "@opencode-ai/util/callout"

describe("splitBlocks", () => {
  // marked emits the blank line between blocks as its own `space` token, so a
  // paragraph and the gap after it are separate blocks. That is harmless (a gap
  // renders nothing); the load-bearing guarantee is that joining restores the
  // input exactly, so nothing is dropped or duplicated.
  test("two paragraphs split, joining back to the input", () => {
    const input = "a\n\nb"
    const blocks = splitBlocks(input)
    expect(blocks).toEqual(["a", "\n\n", "b"])
    expect(blocks.join("")).toBe(input)
  })

  test("a fenced code block stays one block", () => {
    const input = "intro\n\n```ts\nconst a = 1\nconst b = 2\n```\n"
    const blocks = splitBlocks(input)
    expect(blocks).toEqual(["intro", "\n\n", "```ts\nconst a = 1\nconst b = 2\n```\n"])
    expect(blocks.join("")).toBe(input)
  })

  // The whole callout — including its blank-line-separated inner paragraphs —
  // stays in ONE block, or the aside wrapper would be lost across renders.
  test("a callout region is one block, not split per paragraph", () => {
    const input = "intro\n\n:::fix\nfirst para\n\nsecond para\n:::\n\nafter\n"
    const blocks = splitBlocks(input)
    expect(blocks).toEqual(["intro", "\n\n", ":::fix\nfirst para\n\nsecond para\n:::", "\n\n", "after\n"])
    expect(blocks.join("")).toBe(input)
  })

  test("join equals input for a mixed message", () => {
    const input = "# h\n\ntext\n\n:::key\nboxed\n:::\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
    expect(splitBlocks(input).join("")).toBe(input)
  })
})

describe("completeTail", () => {
  test("an open callout gets its closer while streaming", () => {
    expect(completeTail(":::fix\nbody", false)).toBe(":::fix\nbody\n:::")
  })

  test("an already-closed callout is untouched", () => {
    expect(completeTail(":::fix\nbody\n:::\n", false)).toBe(":::fix\nbody\n:::\n")
  })

  test("a check callout keeps its question label and gets closed", () => {
    expect(completeTail(":::check[What?]\nans", false)).toBe(":::check[What?]\nans\n:::")
  })

  test("two open callouts get two closers", () => {
    expect(completeTail(":::key\nouter\n:::fix\ninner", false)).toBe(":::key\nouter\n:::fix\ninner\n:::\n:::")
  })

  test("an unclosed bold is completed (remend passthrough)", () => {
    expect(completeTail("**bold", false)).toBe("**bold**")
  })

  // A ::: inside an open code fence is literal text, so the callout handler must
  // NOT close it. remend does not complete block fences either, so the fence
  // stays open and renders as a still-filling code block (the streaming norm).
  test("a ::: inside an open code fence is left as literal code, not closed as a callout", () => {
    expect(completeTail("```\n:::fix\n", false)).toBe("```\n:::fix\n")
  })

  test("complete=true renders verbatim, no completion", () => {
    expect(completeTail(":::fix\nbody", true)).toBe(":::fix\nbody")
  })
})

describe("scanCalloutDepth", () => {
  test("a balanced callout is depth 0", () => {
    expect(scanCalloutDepth(":::fix\nbody\n:::\n")).toEqual({ depth: 0, openOffset: -1 })
  })

  test("one open callout is depth 1 at its opener offset", () => {
    expect(scanCalloutDepth("abc\n\n:::fix\nbody")).toEqual({ depth: 1, openOffset: 5 })
  })

  test("a ::: inside a code fence does not count", () => {
    expect(scanCalloutDepth("```\n:::fix\n```\n")).toEqual({ depth: 0, openOffset: -1 })
  })
})
