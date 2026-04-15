import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectory } from "./external-directory"
import { applyLineEnding, detectFileProperties, encodeContent } from "../util/encoding"

const MAX_DIAGNOSTICS_PER_FILE = 20

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function normalizeSmartQuotes(text: string): string {
  return text.replaceAll("\u2018", "'").replaceAll("\u2019", "'").replaceAll("\u201C", '"').replaceAll("\u201D", '"')
}

function findActualString(content: string, oldString: string): string | null {
  if (content.includes(oldString)) return oldString
  const normalized = normalizeSmartQuotes(oldString)
  const pos = normalizeSmartQuotes(content).indexOf(normalized)
  if (pos !== -1) return content.substring(pos, pos + oldString.length)
  return null
}

export const EditTool = Tool.define("edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to modify"),
    oldString: z.string().describe("The text to replace"),
    newString: z.string().describe("The text to replace it with (must be different from oldString)"),
    replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
  }).strict(),
  async execute(params, ctx) {
    if (!params.filePath) {
      throw new Error("filePath is required")
    }

    if (params.oldString === params.newString) {
      throw new Error("oldString and newString must be different")
    }

    const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filePath)

    let diff = ""
    let contentOld = ""
    let contentNew = ""
    await FileTime.withLock(filePath, async () => {
      if (params.oldString === "") {
        const existed = await Bun.file(filePath).exists()
        let encoding: "utf8" | "utf16le" = "utf8"
        let ending: "CRLF" | "LF" = "LF"
        if (existed) {
          const props = await detectFileProperties(filePath)
          encoding = props.encoding
          ending = props.ending
        }
        contentNew = params.newString
        diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
        await ctx.ask({
          permission: "edit",
          patterns: [path.relative(Instance.worktree, filePath)],
          always: ["*"],
          metadata: {
            filepath: filePath,
            diff,
          },
        })
        await Bun.write(filePath, encodeContent(applyLineEnding(params.newString, ending), encoding))
        await Bus.publish(File.Event.Edited, {
          file: filePath,
        })
        await Bus.publish(FileWatcher.Event.Updated, {
          file: filePath,
          event: existed ? "change" : "add",
        })
        FileTime.read(ctx.sessionID, filePath)
        return
      }

      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => {})
      if (!stats) throw new Error(`File ${filePath} not found`)
      if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
      await FileTime.assert(ctx.sessionID, filePath)
      const props = await detectFileProperties(filePath)
      contentOld = props.text
      // In a CRLF file, match on LF text: the read tool never shows \r, so a multi-line oldString
      // arrives with \n only. The write below re-applies CRLF. LF files keep any stray CRLF lines as-is.
      const crlf = props.ending === "CRLF"
      contentNew = crlf
        ? replace(
            normalizeLineEndings(contentOld),
            normalizeLineEndings(params.oldString),
            normalizeLineEndings(params.newString),
            params.replaceAll,
          )
        : replace(contentOld, params.oldString, params.newString, params.replaceAll)

      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filePath)],
        always: ["*"],
        metadata: {
          filepath: filePath,
          diff,
        },
      })

      await file.write(encodeContent(applyLineEnding(contentNew, props.ending), props.encoding))
      await Bus.publish(File.Event.Edited, {
        file: filePath,
      })
      await Bus.publish(FileWatcher.Event.Updated, {
        file: filePath,
        event: "change",
      })
      contentNew = await file.text()
      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      FileTime.read(ctx.sessionID, filePath)
    })

    const filediff: Snapshot.FileDiff = {
      file: filePath,
      before: contentOld,
      after: contentNew,
      additions: 0,
      deletions: 0,
    }
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) filediff.additions += change.count || 0
      if (change.removed) filediff.deletions += change.count || 0
    }

    ctx.metadata({
      metadata: {
        diff,
        filediff,
        diagnostics: {},
      },
    })

    let output = `The file ${filePath} has been updated successfully.`
    await LSP.touchFile(filePath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilePath = Filesystem.normalizePath(filePath)
    const issues = diagnostics[normalizedFilePath] ?? []
    const errors = issues.filter((item) => item.severity === 1)
    if (errors.length > 0) {
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filePath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      metadata: {
        diagnostics,
        diff,
        filediff,
      },
      title: `${path.relative(Instance.worktree, filePath)}`,
      output,
    }
  },
})

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("oldString and newString must be different")
  }

  const actual = findActualString(content, oldString)
  if (!actual) throw new Error("oldString not found in content")

  const count = content.split(actual).length - 1
  if (count > 1 && !replaceAll)
    throw new Error(
      "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.",
    )

  if (newString === "") {
    if (!oldString.endsWith("\n") && content.includes(actual + "\n"))
      return replaceAll
        ? content.replaceAll(actual + "\n", newString).replaceAll(actual, newString)
        : content.replace(actual + "\n", newString)
  }

  return replaceAll ? content.replaceAll(actual, newString) : content.replace(actual, newString)
}
