import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WebFetchAnthropicTool } from "./webfetch-anthropic"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import type { SessionPin } from "../session/pin"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { WebSearchAnthropicTool } from "./websearch-anthropic"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { Auth } from "../auth"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    for (const dir of await Config.directories()) {
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        // Version the specifier with mtime: the ESM module cache never
        // invalidates, so a bare re-import after an edit + registry rebuild
        // would silently return the old module. Same content = same specifier,
        // so unchanged files reuse the cached module.
        const stat = await Bun.file(match)
          .stat()
          .catch(() => undefined)
        const mod = await import(stat ? `${match}?v=${stat.mtimeMs}` : match)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          const result = await def.execute(args as any, pluginCtx)
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  // Native Anthropic web search calls the API with the provider's key, so OAuth sessions
  // (no API key) keep the regular web search tool
  async function nativeSearch(providerID?: string) {
    if (providerID !== "anthropic") return false
    return (await Auth.get(providerID))?.type !== "oauth"
  }

  async function all(providerID?: string, pinned?: Tool.Info[]): Promise<Tool.Info[]> {
    const custom: Tool.Info[] = pinned ? pinned : await state().then((x) => x.custom)
    const config = await Config.get()

    // Use Anthropic-optimized tools (prompt-based webfetch, native server tool websearch)
    // when using the Anthropic provider directly
    const isAnthropic = providerID === "anthropic"
    const anthropicSearch = await nativeSearch(providerID)

    // Sort by id for deterministic ordering. tools[] sits at the front of
    // Anthropic's prefix cache hash chain; any order change invalidates all
    // downstream cache entries. Custom tools come from filesystem enumeration
    // which is OS/fs-dependent. Same pattern as the skill ordering fix.
    return [
      InvalidTool,
      ...(["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      isAnthropic ? WebFetchAnthropicTool : WebFetchTool,
      TodoWriteTool,
      // TodoReadTool,
      anthropicSearch ? WebSearchAnthropicTool : WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      PlanExitTool,
      PlanEnterTool,
      ...custom,
    ].sort((a, b) => a.id.localeCompare(b.id))
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    snapshot?: SessionPin.Snapshot,
  ) {
    const tools = await all(model.providerID, snapshot?.custom)
    const anthropicSearch = await nativeSearch(model.providerID)
    const result = await Promise.all(
      tools
        .filter((t) => {
          // Anthropic websearch uses the native server tool (Anthropic with an API key)
          // Exa websearch/codesearch only for opencode provider or via flag
          if (t.id === "websearch") {
            return anthropicSearch || model.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
          }
          if (t.id === "codesearch") {
            return model.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          return {
            id: t.id,
            ...(await t.init({ agent, snapshot })),
          }
        }),
    )
    return result
  }
}
