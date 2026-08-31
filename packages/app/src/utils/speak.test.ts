import { describe, expect, test } from "bun:test"
import { sentences, toSpeech } from "./speak"

describe("toSpeech", () => {
  test("a fenced block is narrated between markers that can be skipped past", () => {
    const spoken = toSpeech("Here is the fix.\n\n```ts\nconst x = 1\n```\n\nThat is all.").join(" ")
    expect(spoken).toContain("Code block")
    expect(spoken).toContain("End code block")
    expect(spoken).toContain("Here is the fix.")
    expect(spoken).toContain("That is all.")
  })

  test("a table is read as rows rather than named and dropped", () => {
    const spoken = toSpeech("Results:\n\n| Machine | State |\n|---|---|\n| desktop | ready |\n\nDone.").join(" ")
    expect(spoken).toContain("desktop")
    expect(spoken).toContain("ready")
    expect(spoken).toContain("Done.")
  })

  test("a table is a chunk of its own, so one press skips it", () => {
    const chunks = toSpeech("Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.")
    const table = chunks.findIndex((c) => c.startsWith("Table."))
    expect(table).toBeGreaterThan(-1)
    expect(chunks[table]).toMatch(/End table\.$/)
    expect(chunks[table - 1]).toBe("Before.")
    expect(chunks[table + 1]).toBe("After.")
  })

  test("a code block is a chunk of its own, so one press skips it", () => {
    const chunks = toSpeech("Before.\n\n```ts\nconst x = 1\n```\n\nAfter.")
    const code = chunks.findIndex((c) => c.startsWith("Code block."))
    expect(code).toBeGreaterThan(-1)
    expect(chunks[code]).toMatch(/End code block\.$/)
    expect(chunks[code - 1]).toBe("Before.")
    expect(chunks[code + 1]).toBe("After.")
  })

  test("a link keeps its text and drops its target", () => {
    expect(toSpeech("See [the docs](https://example.com/x) now.").join(" ")).toBe("See the docs now.")
  })

  test("a bare url is named rather than spelled out", () => {
    expect(toSpeech("Go to https://example.com/a/b now.").join(" ")).toBe("Go to a link now.")
  })

  test("inline marks are dropped but their words survive", () => {
    expect(toSpeech("This is **bold** and `code` and _italic_.").join(" ")).toBe("This is bold and code and italic.")
  })

  test("an arrow is spoken as a word, not named as a symbol", () => {
    expect(toSpeech("The flow is client → server.").join(" ")).toBe("The flow is client to server.")
  })

  test("a checkmark survives as a word rather than being dropped", () => {
    // Dropped glyphs turn "yes/no" into "passed failed", which reverses half of it.
    expect(toSpeech("Status: ✓ passed, ✗ failed.").join(" ")).toBe("Status: yes passed, no failed.")
  })

  test("a dash between numbers reads as a range", () => {
    expect(toSpeech("A range 1–5 wide.").join(" ")).toBe("A range 1 to 5 wide.")
  })

  test("headings, bullets and quotes lose their markers", () => {
    expect(toSpeech("# Title\n\n- one\n- two\n\n> quoted").join(" ")).toContain("Title")
  })

  test("empty input yields no chunks", () => {
    expect(toSpeech("   \n\n  ")).toEqual([])
  })

  test("a decimal point is not treated as the end of a sentence", () => {
    expect(sentences("It fetched 39.5s of audio up front.")).toEqual(["It fetched 39.5s of audio up front."])
  })

  test("a dotted version number stays one sentence", () => {
    expect(sentences("Version 1.2.3 shipped.")).toEqual(["Version 1.2.3 shipped."])
  })

  test("ordinary sentences still separate", () => {
    expect(sentences("One. Two.").length).toBe(2)
  })

  test("a long but ordinary sentence is spoken whole rather than cut mid-clause", () => {
    const source =
      "I created a new Audio element per chunk, and iOS grants playback only to the element a gesture touched, so chunk one slipped through while every later element was refused."
    expect(toSpeech(source)).toEqual([source])
  })

  test("no prose word is lost between the source and what is spoken", () => {
    const source = "First sentence here. Second one follows it. A third closes the paragraph."
    expect(toSpeech(source).join(" ")).toBe(source)
  })

  test("a sentence longer than the cap splits on whitespace without cutting a word", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
    const parts = toSpeech(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join(" ")).toBe(long)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(600)
  })
})
