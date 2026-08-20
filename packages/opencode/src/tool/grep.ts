import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const VCS_EXCLUDES = ["!.git", "!.svn", "!.hg", "!.bzr", "!.jj", "!.sl"]
const DEFAULT_HEAD_LIMIT = 250
const RIPGREP_TIMEOUT_MS = 20_000

// One metadata shape across every output mode. Mode-specific counts
// (filenames/numFiles for file modes, numMatches for count, numLines for
// content) are optional so all return branches share a single inferred type;
// without this the tool's metadata is inferred from whichever branch runs
// first and the others fail to assign.
type Metadata = {
  numFiles?: number
  filenames?: string[]
  numMatches?: number
  numLines?: number
  totalBeforePagination: number
  appliedLimit: number | undefined
  appliedOffset: number
}

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z
    .object({
      pattern: z.string().describe("The regex pattern to search for in file contents"),
      path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
      include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .optional()
        .describe(
          'Output mode: "files_with_matches" (default) returns file paths, "content" returns matching lines, "count" returns match counts',
        ),
      before_context: z
        .number()
        .optional()
        .describe("Number of lines to show before each match (only for output_mode content)"),
      after_context: z
        .number()
        .optional()
        .describe("Number of lines to show after each match (only for output_mode content)"),
      context: z
        .number()
        .optional()
        .describe("Number of context lines before and after each match (only for output_mode content)"),
      case_insensitive: z.boolean().optional().describe("Enable case-insensitive matching"),
      line_numbers: z.boolean().optional().describe("Show line numbers (only for output_mode content, default true)"),
      type: z.string().optional().describe('File type filter using ripgrep type definitions (e.g. "js", "py", "rust")'),
      head_limit: z
        .number()
        .optional()
        .describe(
          `Limit output to first N entries after offset. Defaults to ${DEFAULT_HEAD_LIMIT} when unspecified. Pass 0 for unlimited (use sparingly).`,
        ),
      offset: z.number().optional().describe("Skip first N entries before applying head_limit"),
      multiline: z.boolean().optional().describe("Enable multiline matching mode"),
    })
    .strict(),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const searchPath = Filesystem.resolve(Instance.directory, params.path ?? Instance.directory)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const rgPath = await Ripgrep.filepath()
    const args = ["--hidden", "--no-messages", "--max-columns", "500"]

    // VCS directory exclusions
    for (const exclude of VCS_EXCLUDES) {
      args.push("--glob", exclude)
    }

    const mode = params.output_mode ?? "files_with_matches"

    // Mode-specific flags
    if (mode === "files_with_matches") {
      args.push("-l")
    } else if (mode === "count") {
      // -H keeps the file name even when the path is a single file
      args.push("-c", "-H")
    } else {
      // content mode
      if ((params.line_numbers ?? true) !== false) {
        args.push("-n")
      }
      args.push("-H")
      if (params.context !== undefined) {
        args.push("-C", String(params.context))
      }
      if (params.before_context !== undefined) {
        args.push("-B", String(params.before_context))
      }
      if (params.after_context !== undefined) {
        args.push("-A", String(params.after_context))
      }
    }

    if (params.case_insensitive) {
      args.push("-i")
    }

    if (params.multiline) {
      args.push("-U", "--multiline-dotall")
    }

    if (params.include) {
      args.push("--glob", params.include)
    }

    if (params.type) {
      args.push("--type", params.type)
    }

    args.push("--regexp", params.pattern, searchPath)

    const timeout = AbortSignal.timeout(RIPGREP_TIMEOUT_MS)
    const signal = AbortSignal.any([ctx.abort, timeout])
    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal,
    })

    const output = await new Response(proc.stdout).text()
    const errorOutput = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    const timedOut = timeout.aborted
    const appliedLimit = params.head_limit === 0 ? undefined : (params.head_limit ?? DEFAULT_HEAD_LIMIT)
    const appliedOffset = params.offset ?? 0

    if (!timedOut && (exitCode === 1 || (exitCode === 2 && !output.trim()))) {
      return {
        title: params.pattern,
        metadata: { numFiles: 0, filenames: [] as string[], totalBeforePagination: 0, appliedLimit, appliedOffset },
        output: "No files found",
      }
    }

    if (!timedOut && exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    const hasErrors = exitCode === 2 || timedOut
    const paginationParams = { ...params, head_limit: appliedLimit, offset: appliedOffset }

    if (mode === "files_with_matches") {
      return formatFilesWithMatches(output, paginationParams, hasErrors, timedOut)
    }

    if (mode === "count") {
      return formatCount(output, searchPath, paginationParams, hasErrors, timedOut)
    }

    return formatContent(output, searchPath, paginationParams, hasErrors, timedOut)
  },
})

async function formatFilesWithMatches(
  output: string,
  params: { pattern: string; head_limit?: number; offset?: number },
  hasErrors: boolean,
  timedOut: boolean,
): Promise<{ title: string; metadata: Metadata; output: string }> {
  let files = output
    .trim()
    .split(/\r?\n/)
    .filter((l) => l)

  const totalBeforePagination = files.length

  // Sort by mtime (most recent first), tolerating files deleted between grep and stat
  const results = await Promise.allSettled(
    files.map(async (f) => {
      const stats = await Bun.file(f).stat()
      return { path: f, mtime: stats.mtime.getTime() }
    }),
  )
  const entries = results
    .filter((r): r is PromiseFulfilledResult<{ path: string; mtime: number }> => r.status === "fulfilled")
    .map((r) => r.value)
  entries.sort((a, b) => b.mtime - a.mtime)
  files = entries.map((e) => e.path)

  files = paginate(files, params.offset, params.head_limit)

  if (files.length === 0) {
    return {
      title: params.pattern,
      metadata: { numFiles: 0, filenames: [] as string[], totalBeforePagination, appliedLimit: params.head_limit, appliedOffset: params.offset ?? 0 },
      output: timedOut ? "No files found\n\n(Search timed out — results may be incomplete)" : "No files found",
    }
  }

  const lines = [`Found ${files.length} file(s)`, ...files]
  if (timedOut) lines.push("", "(Search timed out — results may be incomplete)")
  if (hasErrors && !timedOut) lines.push("", "(Some paths were inaccessible and skipped)")

  return {
    title: params.pattern,
    metadata: {
      numFiles: files.length,
      filenames: files,
      totalBeforePagination,
      appliedLimit: params.head_limit,
      appliedOffset: params.offset ?? 0,
    },
    output: lines.join("\n"),
  }
}

function formatCount(
  output: string,
  searchPath: string,
  params: { pattern: string; head_limit?: number; offset?: number },
  hasErrors: boolean,
  timedOut: boolean,
): { title: string; metadata: Metadata; output: string } {
  let entries = output
    .trim()
    .split(/\r?\n/)
    .filter((l) => l)
    .map((line) => {
      const sep = line.lastIndexOf(":")
      const filepath = line.slice(0, sep)
      // A single-file search relativizes to "", so fall back to the file name
      const file = relativize(filepath, searchPath) || path.basename(filepath)
      const count = parseInt(line.slice(sep + 1), 10)
      return { file, count }
    })
    .filter((e) => e.count > 0)

  const totalBeforePagination = entries.length
  entries = paginate(entries, params.offset, params.head_limit)

  if (entries.length === 0) {
    return {
      title: params.pattern,
      metadata: { numFiles: 0, numMatches: 0, totalBeforePagination, appliedLimit: params.head_limit, appliedOffset: params.offset ?? 0 },
      output: timedOut ? "No files found\n\n(Search timed out — results may be incomplete)" : "No files found",
    }
  }

  const total = entries.reduce((sum, e) => sum + e.count, 0)
  const lines = entries.map((e) => `${e.file}:${e.count}`)
  lines.push("", `Found ${total} total occurrences across ${entries.length} files.`)
  if (timedOut) lines.push("", "(Search timed out — results may be incomplete)")
  if (hasErrors && !timedOut) lines.push("", "(Some paths were inaccessible and skipped)")

  return {
    title: params.pattern,
    metadata: {
      numFiles: entries.length,
      numMatches: total,
      totalBeforePagination,
      appliedLimit: params.head_limit,
      appliedOffset: params.offset ?? 0,
    },
    output: lines.join("\n"),
  }
}

function formatContent(
  output: string,
  searchPath: string,
  params: { pattern: string; head_limit?: number; offset?: number },
  hasErrors: boolean,
  timedOut: boolean,
): { title: string; metadata: Metadata; output: string } {
  let lines = output.trimEnd().split(/\r?\n/)

  // Relativize file paths in output lines. Strip only the path prefix: path.relative() on the
  // whole line would also normalize the matched text (e.g. "a // b" -> "a / b").
  if (path.isAbsolute(searchPath)) {
    const prefix = searchPath.endsWith(path.sep) ? searchPath : searchPath + path.sep
    lines = lines.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
  }

  const totalBeforePagination = lines.length
  lines = paginate(lines, params.offset, params.head_limit)

  if (lines.length === 0) {
    return {
      title: params.pattern,
      metadata: { numLines: 0, totalBeforePagination, appliedLimit: params.head_limit, appliedOffset: params.offset ?? 0 },
      output: timedOut ? "No files found\n\n(Search timed out — results may be incomplete)" : "No files found",
    }
  }

  // Count result lines before the notices are appended
  const numLines = lines.length
  if (timedOut) lines.push("", "(Search timed out — results may be incomplete)")
  if (hasErrors && !timedOut) lines.push("", "(Some paths were inaccessible and skipped)")

  return {
    title: params.pattern,
    metadata: {
      numLines,
      totalBeforePagination,
      appliedLimit: params.head_limit,
      appliedOffset: params.offset ?? 0,
    },
    output: lines.join("\n"),
  }
}

function paginate<T>(items: T[], offset?: number, limit?: number): T[] {
  const start = offset ?? 0
  if (limit !== undefined) return items.slice(start, start + limit)
  if (start > 0) return items.slice(start)
  return items
}

function relativize(filepath: string, base: string) {
  const rel = path.relative(base, filepath)
  if (rel.startsWith("..")) return filepath
  return rel
}
