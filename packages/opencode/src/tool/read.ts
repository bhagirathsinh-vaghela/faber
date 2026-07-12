import z from "zod"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { assertExternalDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const MAX_PDF_PAGES = 20

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z
    .object({
      filePath: z.string().describe("The path to the file to read"),
      offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
      limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(),
      pages: z
        .string()
        .optional()
        .describe('Page range for PDF files (e.g., "1-5", "3", "10-"). Maximum 20 pages per request.'),
    })
    .strict(),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage) {
      const mime = file.type
      const msg = "Image read successfully"
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    if (isPdf) {
      const result = await readPdf(filepath, params.pages, ctx, instructions)
      return { title, ...result }
    }

    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0

    // Dedup: if this exact range was already read and the file hasn't changed
    // since, return a stub instead of re-sending the content. A different range
    // must fall through to a real read — the stored entry only covers the range
    // it captured. An undefined offset marks an Edit/Write stamp, not a Read, so
    // it can never stub a Read against post-edit content the model never saw.
    const stat = await file.stat()
    const lastRead = FileTime.get(ctx.sessionID, filepath)
    if (
      lastRead &&
      lastRead.offset !== undefined &&
      lastRead.offset === offset &&
      lastRead.limit === params.limit &&
      stat.mtime.getTime() <= lastRead.mtime
    ) {
      FileTime.read(ctx.sessionID, filepath, stat.mtime.getTime(), lastRead.hash, offset, params.limit)
      return {
        title,
        output: `<file_unchanged>${filepath}</file_unchanged>`,
        metadata: {
          preview: "(file unchanged since last read)",
          truncated: false,
          // Persisted on the tool part so FileTime can be rebuilt from session
          // history after a server restart (in-memory read map is process-local).
          mtime: stat.mtime.getTime(),
          hash: lastRead.hash,
          offset,
          limit: params.limit,
        },
      }
    }

    const lines = await file.text().then((text) => text.split("\n"))

    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false
    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i]
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(line)
      bytes += size
    }

    const content = raw.map((line, index) => {
      const num = (index + offset + 1).toString()
      return `${num.padStart(6, " ")}\t${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = lines.length
    const lastReadLine = offset + raw.length
    const hasMoreLines = totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    // Record a content hash alongside the mtime so a later edit/write can tell
    // an mtime bump with unchanged bytes from a real modification and skip the
    // spurious re-read. Hash the raw file bytes (same as FileTime.assert) so the
    // two sides compare identically, regardless of read truncation.
    const contentHash = await FileTime.hash(filepath)
    FileTime.read(ctx.sessionID, filepath, stat.mtime.getTime(), contentHash, offset, params.limit)

    if (instructions.length > 0) {
      output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
    }

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        // Persisted so FileTime can be rebuilt from session history after a
        // server restart (the in-memory read map is process-local). The hash
        // lets the restored entry keep its content fallback across a restart;
        // offset/limit let the restored entry keep its read range so dedup stays
        // range-aware across the seed().
        mtime: stat.mtime.getTime(),
        hash: contentHash,
        offset,
        limit: params.limit,
        ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
      },
    }
  },
})

function parsePageRange(pages: string): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (!trimmed) return null
  if (trimmed.endsWith("-")) {
    const first = parseInt(trimmed.slice(0, -1), 10)
    if (isNaN(first) || first < 1) return null
    return { firstPage: first, lastPage: Infinity }
  }
  const dash = trimmed.indexOf("-")
  if (dash === -1) {
    const page = parseInt(trimmed, 10)
    if (isNaN(page) || page < 1) return null
    return { firstPage: page, lastPage: page }
  }
  const first = parseInt(trimmed.slice(0, dash), 10)
  const last = parseInt(trimmed.slice(dash + 1), 10)
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) return null
  return { firstPage: first, lastPage: last }
}

async function hasPdftoppm(): Promise<boolean> {
  return Bun.which("pdftoppm") !== null
}

async function readPdf(
  filepath: string,
  pages: string | undefined,
  ctx: Tool.Context,
  instructions: Awaited<ReturnType<typeof InstructionPrompt.resolve>>,
) {
  const file = Bun.file(filepath)

  if (!pages) {
    const msg = "PDF read successfully"
    return {
      output: msg,
      metadata: {
        preview: msg,
        truncated: false,
        ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
      },
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: "application/pdf",
          url: `data:application/pdf;base64,${Buffer.from(await file.bytes()).toString("base64")}`,
        },
      ],
    }
  }

  const range = parsePageRange(pages)
  if (!range) throw new Error(`Invalid page range: "${pages}". Use formats like "3", "1-5", or "10-".`)

  if (range.lastPage !== Infinity && range.lastPage - range.firstPage + 1 > MAX_PDF_PAGES)
    throw new Error(`Page range exceeds maximum of ${MAX_PDF_PAGES} pages per request.`)

  if (!(await hasPdftoppm()))
    throw new Error(
      "pdftoppm is required for PDF page extraction but was not found. Install poppler-utils (e.g., `brew install poppler` or `apt-get install poppler-utils`).",
    )

  const tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-pdf-"))
  try {
    const prefix = path.join(tmpdir, "page")
    const args = ["-jpeg", "-r", "150", "-f", String(range.firstPage)]
    if (range.lastPage !== Infinity) args.push("-l", String(range.lastPage))
    args.push(filepath, prefix)

    const proc = Bun.spawn(["pdftoppm", ...args], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`pdftoppm failed: ${stderr}`)
    }

    const files = fs
      .readdirSync(tmpdir)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
    if (files.length === 0) throw new Error(`No pages extracted for range "${pages}". The PDF may have fewer pages.`)

    if (files.length > MAX_PDF_PAGES)
      throw new Error(
        `Page range "${pages}" would extract ${files.length} pages, exceeding maximum of ${MAX_PDF_PAGES}.`,
      )

    const attachments = await Promise.all(
      files.map(async (f) => {
        const bytes = await Bun.file(path.join(tmpdir, f)).bytes()
        return {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: "image/jpeg",
          url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
        }
      }),
    )

    const msg = `PDF pages ${pages} read successfully (${attachments.length} page${attachments.length === 1 ? "" : "s"})`
    return {
      output: msg,
      metadata: {
        preview: msg,
        truncated: false,
        ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
      },
      attachments,
    }
  } finally {
    fs.promises.rm(tmpdir, { recursive: true }).catch(() => {})
  }
}

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
