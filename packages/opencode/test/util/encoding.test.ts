import { describe, expect, test } from "bun:test"
import { decodeBytes, detectEncoding, encodeContent } from "../../src/util/encoding"

describe("util.encoding", () => {
  test("utf16le round trip keeps the BOM so the next read detects utf16le", () => {
    const original = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])
    const text = decodeBytes(original, detectEncoding(original))
    expect(text).toBe("A\n")

    const written = encodeContent(text, "utf16le") as Uint8Array
    expect(Array.from(written)).toEqual([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])
    expect(detectEncoding(written)).toBe("utf16le")
    expect(decodeBytes(written, detectEncoding(written))).toBe("A\n")
  })

  test("utf8 content is returned as a string", () => {
    expect(encodeContent("A\n", "utf8")).toBe("A\n")
  })
})
