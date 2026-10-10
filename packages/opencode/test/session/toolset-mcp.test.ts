import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { Agent } from "../../src/agent/agent"
import { MCP } from "../../src/mcp/index"
import { Instance } from "../../src/project/instance"
import type { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"
import { ToolRegistry } from "../../src/tool/registry"
import { LspTool } from "../../src/tool/lsp"
import { McpSearchTool } from "../../src/tool/mcp-search"
import { ApplyPatchTool } from "../../src/tool/apply_patch"

// The MCP-capable subagent toolsets and the sentinel grant live in two places:
// Agent.BUILTIN_TOOLSETS names the presets (with the MCP sentinels), and
// SessionPrompt.toolDenial enforces them at execute time. These assert both,
// and — the load-bearing invariant — that a ROOT session (allowedTools
// undefined) is gated by NONE of it: every tool stays allowed exactly as today.

const READ_KEY = "notion_search"
const WRITE_KEY = "notion_create_page"

// Agent.toolsets reads Config.get, which needs an instance context. Run under a
// tmpdir with no subagent_toolsets so the built-in presets are what resolve,
// independent of the machine's own config.
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir()
  return Instance.provide({ directory: tmp.path, fn })
}

// The read-only grant's own toolset carries MCP_READ + mcp_search; the
// write-capable one carries MCP_WRITE + mcp_search. Resolved from the presets so
// a rename of a preset can't silently desync the tests from what ships.
async function toolset(name: string): Promise<Session.AllowedTool[]> {
  return withInstance(async () => {
    const sets = await Agent.toolsets()
    const set = sets[name]
    if (!set) throw new Error(`toolset "${name}" not found`)
    return set as Session.AllowedTool[]
  })
}

describe("Agent.toolsets presets", () => {
  test("question is absent from every built-in subagent preset", async () => {
    const sets = await withInstance(() => Agent.toolsets())
    for (const [name, tools] of Object.entries(sets)) {
      expect(tools, `preset "${name}" must not grant question`).not.toContain("question")
    }
  })

  test("explore-mcp grants the read sentinel + mcp_search, not the write sentinel", async () => {
    const set = await toolset("explore-mcp")
    expect(set).toContain(Agent.MCP_READ)
    expect(set).toContain("mcp_search")
    expect(set).not.toContain(Agent.MCP_WRITE)
  })

  test("general-mcp grants the write sentinel + mcp_search, not the read sentinel", async () => {
    const set = await toolset("general-mcp")
    expect(set).toContain(Agent.MCP_WRITE)
    expect(set).toContain("mcp_search")
    expect(set).not.toContain(Agent.MCP_READ)
  })

  // A preset entry that names no tool grants nothing, silently. The edit-capable
  // presets must grant apply_patch by its real id, since GPT models get it in
  // place of edit/write. lsp and mcp_search register only under a flag or with
  // MCP configured, so they count without being present.
  test("every built-in preset entry names a real tool or an MCP sentinel", async () => {
    const known = await withInstance(async () => [
      ...(await ToolRegistry.ids()),
      LspTool.id,
      McpSearchTool.id,
      Agent.MCP_READ,
      Agent.MCP_WRITE,
    ])
    const sets = await withInstance(() => Agent.toolsets())
    for (const name of ["explore", "general", "explore-mcp", "general-mcp"]) {
      expect(sets[name].filter((tool) => !known.includes(tool)), `preset "${name}"`).toEqual([])
    }
    expect(sets.general).toContain(ApplyPatchTool.id)
    expect(sets["general-mcp"]).toContain(ApplyPatchTool.id)
  })

  test("the plain explore/general presets carry no MCP sentinel", async () => {
    for (const name of ["explore", "general"]) {
      const set = await toolset(name)
      expect(set).not.toContain(Agent.MCP_READ)
      expect(set).not.toContain(Agent.MCP_WRITE)
    }
  })
})

describe("toolDenial — root/parent session denies NOTHING", () => {
  // A root session has allowedTools undefined and toolDenial returns undefined
  // (allowed) for it. This is the whole safety boundary: the subagent presets
  // never reach a parent, so a parent keeps question, write, and all MCP.
  test("native tools (question, write) are allowed", () => {
    expect(SessionPrompt.toolDenial(undefined, "question", {})).toBeUndefined()
    expect(SessionPrompt.toolDenial(undefined, "write", { filePath: "/tmp/x" })).toBeUndefined()
  })

  test("MCP read and write tools are allowed", () => {
    expect(SessionPrompt.toolDenial(undefined, READ_KEY, {}, { readOnly: true })).toBeUndefined()
    expect(SessionPrompt.toolDenial(undefined, WRITE_KEY, {}, { readOnly: false })).toBeUndefined()
  })

  test("question is allowed for an undefined allowlist", () => {
    expect(SessionPrompt.toolDenial(undefined, "question", {})).toBeUndefined()
  })
})

describe("toolDenial — read-only MCP subagent (explore-mcp)", () => {
  test("an MCP read tool is allowed", async () => {
    const set = await toolset("explore-mcp")
    expect(SessionPrompt.toolDenial(set, READ_KEY, {}, { readOnly: true })).toBeUndefined()
  })

  test("an MCP write tool is denied", async () => {
    const set = await toolset("explore-mcp")
    const denial = SessionPrompt.toolDenial(set, WRITE_KEY, {}, { readOnly: false })
    expect(denial).toBe(`Tool "${WRITE_KEY}" is not available for this task. Available tools: ${set.join(", ")}`)
  })

  test("mcp_search is allowed", async () => {
    const set = await toolset("explore-mcp")
    expect(SessionPrompt.toolDenial(set, "mcp_search", {})).toBeUndefined()
  })

  test("question is denied", async () => {
    const set = await toolset("explore-mcp")
    const denial = SessionPrompt.toolDenial(set, "question", {})
    expect(denial).toBe(`Tool "question" is not available for this task. Available tools: ${set.join(", ")}`)
  })
})

describe("toolDenial — write-capable MCP subagent (general-mcp)", () => {
  test("an MCP read tool is allowed", async () => {
    const set = await toolset("general-mcp")
    expect(SessionPrompt.toolDenial(set, READ_KEY, {}, { readOnly: true })).toBeUndefined()
  })

  test("an MCP write tool is allowed", async () => {
    const set = await toolset("general-mcp")
    expect(SessionPrompt.toolDenial(set, WRITE_KEY, {}, { readOnly: false })).toBeUndefined()
  })

  test("mcp_search is allowed", async () => {
    const set = await toolset("general-mcp")
    expect(SessionPrompt.toolDenial(set, "mcp_search", {})).toBeUndefined()
  })

  test("question is denied", async () => {
    const set = await toolset("general-mcp")
    const denial = SessionPrompt.toolDenial(set, "question", {})
    expect(denial).toBe(`Tool "question" is not available for this task. Available tools: ${set.join(", ")}`)
  })
})

describe("toolDenial — non-MCP subagent (explore/general) denies all MCP", () => {
  test("an MCP read tool is denied even though it is read-only", async () => {
    const set = await toolset("explore")
    const denial = SessionPrompt.toolDenial(set, READ_KEY, {}, { readOnly: true })
    expect(denial).toBe(`Tool "${READ_KEY}" is not available for this task. Available tools: ${set.join(", ")}`)
  })

  test("an MCP write tool is denied", async () => {
    const set = await toolset("general")
    const denial = SessionPrompt.toolDenial(set, WRITE_KEY, {}, { readOnly: false })
    expect(denial).toBe(`Tool "${WRITE_KEY}" is not available for this task. Available tools: ${set.join(", ")}`)
  })
})

describe("cache stability — the sentinel can never be a tool id", () => {
  // tools[] on the wire is built from registered native ids + MCP.tools() keys,
  // never from allowedTools, so the sentinel is execute-time-only. As a
  // structural guard: a sentinel carries ":", but MCP.toolKey sanitizes every
  // non-[a-zA-Z0-9_-] char to "_" and native ids use only [a-z_], so no real
  // tool id or key can ever equal a sentinel. A sentinel placed in tools[]
  // would change the prompt-cache prefix; this proves it structurally cannot be
  // mistaken for a registerable tool.
  test("sentinels contain ':' and no MCP toolKey can", () => {
    expect(Agent.MCP_READ).toContain(":")
    expect(Agent.MCP_WRITE).toContain(":")
    for (const [server, tool] of [
      ["notion", "search"],
      ["ddwrite", "datadog:create"],
      ["weird server", "a:b"],
    ]) {
      expect(MCP.toolKey(server, tool)).not.toContain(":")
    }
  })
})

describe("toolDenial — sentinel is inert for native tools", () => {
  // A native tool passes no mcp descriptor, so the sentinel never matches its
  // id. A write-capable subagent still denies a native tool that is not on its
  // list (proving the sentinel grants MCP keys only, not native ids).
  //
  // `question` is the subject because it is excluded from every preset by
  // design, not by omission — a headless subagent has no human to answer one.
  // A tool that merely happens to be absent today gets granted eventually, and
  // then this test fails for a reason that has nothing to do with sentinels.
  test("general-mcp still denies a native tool it does not list", async () => {
    const set = await toolset("general-mcp")
    const denial = SessionPrompt.toolDenial(set, "question", {})
    expect(denial).toBe(`Tool "question" is not available for this task. Available tools: ${set.join(", ")}`)
  })
})
