import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, structuredPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"
import { applyLineEnding, detectFileProperties, encodeContent } from "../util/encoding"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z
    .object({
      content: z.string().describe("The content to write to the file"),
      filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    })
    .strict(),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)

    const file = Bun.file(filepath)
    const exists = await file.exists()
    let contentOld = ""
    let encoding: "utf8" | "utf16le" = "utf8"
    let ending: "CRLF" | "LF" = "LF"
    if (exists) {
      const props = await detectFileProperties(filepath)
      contentOld = props.text
      encoding = props.encoding
      ending = props.ending
      await FileTime.assert(ctx.sessionID, filepath)
    }

    // In a CRLF file the write re-applies CRLF, so compare LF text: CRLF vs LF is not a change there
    const lf = (text: string) => (ending === "CRLF" ? text.replaceAll("\r\n", "\n") : text)
    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, lf(contentOld), lf(params.content)))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    const dir = path.dirname(filepath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    await Bun.write(filepath, encodeContent(applyLineEnding(params.content, ending), encoding))
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: exists ? "change" : "add",
    })
    FileTime.read(ctx.sessionID, filepath)

    let output = exists
      ? `The file ${filepath} has been updated successfully.`
      : `File created successfully at: ${filepath}`

    if (exists) {
      const patch = structuredPatch(filepath, filepath, lf(contentOld), lf(params.content))
      const hunks = patch.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
      }))
      if (hunks.length > 0) {
        output +=
          "\n\n" +
          hunks
            .map((h) => {
              const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
              return `${header}\n${h.lines.join("\n")}`
            })
            .join("\n")
      }
    }
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length === 0) continue
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === normalizedFilepath) {
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
