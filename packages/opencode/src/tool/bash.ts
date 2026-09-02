import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"
import { Server } from "@/server/server"
import { BackgroundSpawn } from "@/background/spawn"
import { BackgroundJob } from "@/background/job"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", "the current working directory")
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z
      .object({
        command: z.string().describe("The command to execute"),
        timeout: z.number().describe("Optional timeout in milliseconds").optional(),
        workdir: z
          .string()
          .describe(
            "The working directory to run the command in. Defaults to the session working directory. Use this instead of 'cd' commands.",
          )
          .optional(),
        description: z
          .string()
          .describe(
            "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
          ),
      })
      .strict(),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              // Git Bash on Windows returns Unix-style paths like /c/Users/...
              const normalized =
                process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                  ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                  : resolved
              if (!Instance.containsPath(normalized)) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => path.join(dir, "*"))
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
      const listening = Server.listening()
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      // One path for every command: a durable record, a detached process, and
      // output streaming to a file. The runtime decides the SHAPE of the result
      // by racing the process against the grace window, so nothing here has to
      // predict how long a command will take.
      const spawned = await BackgroundSpawn.run({
        command: params.command,
        description: params.description,
        sessionID: ctx.sessionID,
        directory: cwd,
        shell,
        env: {
          ...process.env,
          ...shellEnv.env,
          OPENCODE_SESSION_ID: ctx.sessionID,
          OPENCODE_MESSAGE_ID: ctx.messageID,
          OPENCODE_AGENT: ctx.agent,
          // Absent under a TUI that was never given --port: there is no API to
          // reach, and a default origin would name a port nothing is bound to.
          ...(listening ? { OPENCODE_SERVER_URL: listening } : {}),
        },
        hard: params.timeout,
      })

      // Past the window. The job keeps running and reports itself when it
      // finishes, so the turn is free rather than blocked; a caller that wants
      // progress reads the log, which is already streaming.
      if (spawned.type === "background") {
        const output = [
          `Command still running after ${Math.round(BackgroundSpawn.GRACE_MS / 1000)}s; it continues in the background.`,
          `job_id: ${spawned.job.id}`,
          `log: ${BackgroundJob.logPath(spawned.job.id)}`,
          ``,
          `The result will arrive on its own when the command finishes. Read the log with tail or grep for progress; do not poll for completion.`,
        ].join("\n")
        const metadata = {
          output,
          // Undefined rather than absent: the job has not exited, and a reader
          // must not mistake a missing field for a zero exit.
          exit: undefined as number | undefined,
          description: params.description,
          job: spawned.job.id,
        }
        ctx.metadata({ metadata })
        return { title: params.description, metadata, output }
      }

      let output = spawned.output
      if (ctx.abort.aborted) {
        output += "\n\n<bash_metadata>\nUser aborted the command\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: spawned.exit as number | undefined,
          description: params.description,
          job: spawned.job.id,
        },
        output,
      }
    },
  }
})
