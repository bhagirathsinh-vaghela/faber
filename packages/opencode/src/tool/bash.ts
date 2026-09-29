import z from "zod"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { swap } from "../util/text"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"
import { Server } from "@/server/server"
import { BackgroundSpawn } from "@/background/spawn"
import { BackgroundJob } from "@/background/job"
import { BackgroundNotify } from "@/background/notify"
import { Debt } from "@/storage/debt"
import { Config } from "@/config/config"
import { parseDuration, formatDuration } from "@/util/format"

const MAX_METADATA_LENGTH = 30_000

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
    description: Object.entries({
      "${directory}": "the current working directory",
      "${maxLines}": String(Truncate.MAX_LINES),
      "${maxBytes}": String(Truncate.MAX_BYTES),
      "${graceSeconds}": String(Math.round(BackgroundSpawn.GRACE_MS / 1000)),
    }).reduce((text, [key, value]) => swap(text, key, value, true), DESCRIPTION),
    parameters: z
      .object({
        command: z.string().describe("The command to execute. Omit when killing a job.").optional(),
        kill: z
          .string()
          .describe("A job_id to stop. The only way to end a background job before its timeout.")
          .optional(),
        timeout: z
          .string()
          .describe(
            "Duration after which the job is killed, like '30m', '1h30m', '90s', or '2h' (a bare number is seconds). Overrides the configured default (background.job.hard_timeout, itself defaulting to 30m).",
          )
          .optional(),
        estimate: z
          .string()
          .describe(
            "Optional estimate of how long the command should take, as a duration like '90s', '5m', or '1h'. If the job is still running past this, you get a progress check-in. It only makes the first check-in EARLIER (capped at ~3 minutes), so a rough guess is fine and a wrong one is cheap. Give one for a command you expect to finish quickly and want to hear about sooner if it hangs.",
          )
          .optional(),
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

      // Killing is a different verb, not a runtime outcome, so it takes the
      // job id instead of a command and returns before any of the command
      // machinery below.
      if (params.kill) {
        const target = await BackgroundJob.get(params.kill)
        if (target && target.sessionID !== ctx.sessionID) {
          throw new Error(
            `Refusing to kill job ${params.kill}: it belongs to session ${target.sessionID}, not this session (${ctx.sessionID}).`,
          )
        }
        // The reply below is the payment only for a job THIS call ended. One
        // that finished on its own keeps its debt, so Recovery delivers its
        // output. So does one killed by a turn that is being cancelled, since
        // nothing reads this reply; that result is collected at once. So is
        // one this call found dead and settled without a kill, which is owed
        // now rather than at the next pass.
        const pay = !ctx.abort.aborted
        const stopped = await BackgroundJob.stop(params.kill, { why: "kill", pay })
        const collect = stopped.type === "settled" && (stopped.killed ? !pay : await Debt.has(params.kill))
        if (collect) {
          const { Recovery } = await import("@/session/recovery")
          const { SessionPrompt } = await import("@/session/prompt")
          await Recovery.collect(ctx.sessionID, { fresh: true, wake: ctx.abort.reason !== SessionPrompt.STOPPED })
        }
        const owed = await Debt.has(params.kill)
        const output =
          stopped.type === "unknown"
            ? `No job ${params.kill}. It may have finished and been cleaned up.`
            : // Its record exists but its spawn has not returned, so there is
              // no process to signal yet. Saying so beats claiming a kill that
              // did not happen: the caller can try again in a moment.
              stopped.type === "unspawned"
              ? `Job ${params.kill} is still starting and cannot be killed yet. Try again in a moment.`
              : stopped.killed
                ? `Killed job ${params.kill} and everything it spawned.`
                : `Job ${params.kill} had already ended (${BackgroundNotify.meta(stopped.job, BackgroundJob.outcome(stopped.job)).status}, exit ${stopped.job.exit ?? "unknown"}); its result ${owed ? "will be" : "was already"} delivered.`
        return {
          title: params.description,
          metadata: {
            output,
            exit: undefined as number | undefined,
            description: params.description,
            job: params.kill,
          },
          output,
        }
      }

      if (!params.command) throw new Error("Either command or kill is required.")
      const command = params.command
      const timeoutSecs = params.timeout === undefined ? undefined : parseDuration(params.timeout)
      if (timeoutSecs !== undefined && !(timeoutSecs > 0)) {
        throw new Error(`Invalid timeout: ${params.timeout}. Use a positive duration like '30m', '90s', or '1h30m'.`)
      }
      const estimateSecs = params.estimate === undefined ? undefined : parseDuration(params.estimate)
      if (estimateSecs !== undefined && !(estimateSecs > 0)) {
        throw new Error(`Invalid estimate: ${params.estimate}. Use a positive duration like '90s', '5m', or '1h'.`)
      }
      const tree = await parser().then((p) => p.parse(command))
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
      const cfg = await Config.get()
      const listening = Server.listening()
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      // The tool, the config, and the model all speak human durations; the job
      // machinery speaks milliseconds. Resolve the ceiling in SECONDS here (so
      // the message below can report it) and convert at the single boundary into
      // `run`. A configured value is parsed the same way as a tool argument.
      const configSecs =
        cfg.background?.job?.hard_timeout === undefined ? undefined : parseDuration(cfg.background.job.hard_timeout)
      const seconds = timeoutSecs ?? configSecs ?? BackgroundSpawn.HARD_MS / 1000

      // One path for every command: a durable record, a detached process, and
      // output streaming to a file. The runtime decides the SHAPE of the result
      // by racing the process against the grace window, so nothing here has to
      // predict how long a command will take.
      const spawned = await BackgroundSpawn.run({
        command: params.command,
        description: params.description,
        sessionID: ctx.sessionID,
        signal: ctx.abort,
        directory: cwd,
        // Not `cwd`: a workdir argument can name anywhere, and the session is
        // only findable under the project the tool call is running in.
        project: Instance.directory,
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
        hard: seconds * 1000,
        soft: estimateSecs === undefined ? undefined : estimateSecs * 1000,
      })

      // Past the window. The job keeps running and reports itself when it
      // finishes, so the turn is free rather than blocked; a caller that wants
      // progress reads the log, which is already streaming.
      if (spawned.type === "background") {
        const output = [
          `Command still running after ${Math.round(BackgroundSpawn.GRACE_MS / 1000)}s; it continues in the background.`,
          `job_id: ${spawned.job.id}`,
          `log: ${BackgroundJob.logPath(spawned.job.id)}`,
          `hard deadline: killed if it runs past ${formatDuration(seconds)}. If the command legitimately needs longer, re-run with a larger timeout.`,
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
