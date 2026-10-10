import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines, structuredPatch } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { swap } from "../util/text"
import { Instance } from "../project/instance"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectory } from "./external-directory"
import { applyLineEnding, detectFileProperties, encodeContent } from "../util/encoding"
import { Truncate } from "./truncation"

const MAX_DIAGNOSTICS_PER_FILE = 20

export const CHANGED =
  "Note: this file changed since you last read it (a shell command, another session, or an editor wrote to it). The edit applied where oldString matched the current content; read the file before relying on its other parts."

type Replacement = { oldString: string; newString: string; replaceAll?: boolean }

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
  parameters: z
    .object({
      filePath: z.string().describe("The absolute path to the file to modify"),
      oldString: z.string().describe("The text to replace"),
      newString: z.string().describe("The text to replace it with (must be different from oldString)"),
      replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
    })
    .strict(),
  async execute(params, ctx) {
    return change(params.filePath, [params], ctx)
  },
})

// The one write path for edit and multiedit. Every replacement is applied in
// memory before the single write, so one that fails leaves the file untouched.
export async function change(target: string, edits: Replacement[], ctx: Tool.Context) {
  if (!target) throw new Error("filePath is required")
  if (edits.length === 0) throw new Error("edits must contain at least one edit")
  if (edits.some((edit) => edit.oldString === edit.newString))
    throw new Error("oldString and newString must be different")

  const filePath = Filesystem.resolve(Instance.directory, target)
  await assertExternalDirectory(ctx, filePath)

  let diff = ""
  let contentOld = ""
  let contentNew = ""
  let changed = false
  let stamp: { mtime: number; hash?: string } | undefined
  await FileTime.withLock(filePath, async () => {
    const stats = await Bun.file(filePath)
      .stat()
      .catch(() => undefined)
    if (stats?.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
    const create = edits[0].oldString === ""
    if (!stats && !create) throw new Error(`File ${filePath} not found`)
    const props = stats ? await detectFileProperties(filePath) : undefined
    contentOld = props?.text ?? ""
    if (create && contentOld.length > 0)
      throw new Error(
        `Cannot use empty oldString on a file that already has content. Use the Write tool for full overwrites, or provide the specific text to replace.`,
      )
    changed = stats ? await FileTime.changed(ctx.sessionID, filePath) : false
    // In a CRLF file, match on LF text: the read tool never shows \r, so a multi-line oldString
    // arrives with \n only. The write below re-applies CRLF. LF files keep any stray CRLF lines as-is.
    const lf = (text: string) => (props?.ending === "CRLF" ? normalizeLineEndings(text) : text)
    contentNew = (create ? edits.slice(1) : edits).reduce(
      (text, edit) => replace(text, lf(edit.oldString), lf(edit.newString), edit.replaceAll),
      create ? edits[0].newString : lf(contentOld),
    )

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

    await Bun.write(filePath, encodeContent(applyLineEnding(contentNew, props?.ending ?? "LF"), props?.encoding ?? "utf8"))
    await Bus.publish(File.Event.Edited, {
      file: filePath,
    })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: filePath,
      event: stats ? "change" : "add",
    })
    contentNew = await Bun.file(filePath).text()
    diff = trimDiff(
      createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
    )
    // Re-stamp with the file's actual post-write mtime and content hash, not
    // Date.now(). The real mtime lands after the wall clock we would capture,
    // so a bare Date.now() re-stamp makes the very next edit see mtime > stored
    // and report the file as changed by someone else. Stamping the true mtime
    // plus the hash we just wrote keeps our own writes from looking foreign.
    stamp = await FileTime.restamp(ctx.sessionID, filePath)
  })

  const filediff: Snapshot.FileDiff = {
    file: filePath,
    before: contentOld,
    after: contentNew,
    additions: 0,
    deletions: 0,
  }
  for (const part of diffLines(contentOld, contentNew)) {
    if (part.added) filediff.additions += part.count || 0
    if (part.removed) filediff.deletions += part.count || 0
  }

  // Neither the running event nor the persisted result carries the before/after
  // bodies: they are whole-file copies (2x the file) that no renderer needs (the
  // edit card renders the stored `diff`) and the model never reads metadata.
  // Ship only the +/- stat.
  const { before, after, ...stat } = filediff
  ctx.metadata({
    metadata: {
      filediff: stat,
      diagnostics: {},
    },
  })

  const patch = structuredPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew))
  const hunks = patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }))

  let output = `The file ${filePath} has been updated successfully.\n\n`
  output += hunks
    .map((h) => {
      const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
      return `${header}\n${h.lines.join("\n")}`
    })
    .join("\n")
  if (changed) output += `\n\n${CHANGED}`

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
      // Persist only the edited file's diagnostics, keyed by its path. The
      // renderers index this map by the edited path; the whole LSP.diagnostics()
      // map scales with the repo (tens of MB in a monorepo) and no reader wants
      // the other files. The model never reads metadata — it gets the bounded
      // <diagnostics> block from `output`.
      diagnostics: issues.length ? { [normalizedFilePath]: issues } : {},
      diff: Truncate.diff(diff),
      // The +/-/file stat is all any renderer needs; the edit card draws the
      // change from `diff`, so whole-file bodies would only cost storage.
      filediff: stat,
      // Persisted so seed() can carry this edit's post-write mtime+hash across
      // turns, instead of restoring the stale pre-edit read state.
      mtime: stamp?.mtime,
      hash: stamp?.hash,
    },
    title: filePath,
    output,
  }
}

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
        ? swap(swap(content, actual + "\n", newString, true), actual, newString, true)
        : swap(content, actual + "\n", newString)
  }

  return swap(content, actual, newString, replaceAll)
}
