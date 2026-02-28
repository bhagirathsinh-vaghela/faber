const SAMPLE_SIZE = 4096

export function detectLineEnding(content: string): "CRLF" | "LF" {
  let crlf = 0
  let lf = 0
  const limit = Math.min(content.length, SAMPLE_SIZE)
  for (let i = 0; i < limit; i++) {
    if (content[i] === "\n") {
      if (i > 0 && content[i - 1] === "\r") crlf++
      else lf++
    }
  }
  return crlf > lf ? "CRLF" : "LF"
}

export function detectEncoding(bytes: Uint8Array): "utf8" | "utf16le" {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le"
  return "utf8"
}

export function applyLineEnding(content: string, ending: "CRLF" | "LF"): string {
  if (ending === "CRLF") return content.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
  return content
}

export function decodeBytes(bytes: Uint8Array, encoding: "utf8" | "utf16le"): string {
  if (encoding === "utf16le") return new TextDecoder("utf-16le").decode(bytes)
  return new TextDecoder("utf-8").decode(bytes)
}

export function encodeContent(content: string, encoding: "utf8" | "utf16le"): Uint8Array | string {
  if (encoding === "utf16le") {
    // Write the FF FE BOM back: decodeBytes strips it and detectEncoding needs it on the next read
    const buf = new ArrayBuffer((content.length + 1) * 2)
    const view = new Uint16Array(buf)
    view[0] = 0xfeff
    for (let i = 0; i < content.length; i++) view[i + 1] = content.charCodeAt(i)
    return new Uint8Array(buf)
  }
  return content
}

export async function detectFileProperties(filepath: string) {
  const file = Bun.file(filepath)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const encoding = detectEncoding(bytes)
  const text = decodeBytes(bytes, encoding)
  const ending = detectLineEnding(text)
  return { encoding, ending, text }
}
