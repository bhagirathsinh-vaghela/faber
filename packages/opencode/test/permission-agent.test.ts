import { describe, test, expect } from "bun:test"
import { PermissionNext } from "../src/permission/next"
import { Config } from "../src/config/config"
import { Instance } from "../src/project/instance"
import { tmpdir } from "./fixture/fixture"

describe("PermissionNext.evaluate for permission.agent", () => {
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionNext.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "agent",
      pattern,
      action,
    }))

  test("returns ask when no match (default)", () => {
    expect(PermissionNext.evaluate("agent", "code-reviewer", []).action).toBe("ask")
  })

  test("returns deny for explicit deny", () => {
    const ruleset = createRuleset({ "code-reviewer": "deny" })
    expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("deny")
  })

  test("returns allow for explicit allow", () => {
    const ruleset = createRuleset({ "code-reviewer": "allow" })
    expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("allow")
  })

  test("returns ask for explicit ask", () => {
    const ruleset = createRuleset({ "code-reviewer": "ask" })
    expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with deny", () => {
    const ruleset = createRuleset({ "orchestrator-*": "deny" })
    expect(PermissionNext.evaluate("agent", "orchestrator-fast", ruleset).action).toBe("deny")
    expect(PermissionNext.evaluate("agent", "orchestrator-slow", ruleset).action).toBe("deny")
    expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with allow", () => {
    const ruleset = createRuleset({ "orchestrator-*": "allow" })
    expect(PermissionNext.evaluate("agent", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(PermissionNext.evaluate("agent", "orchestrator-slow", ruleset).action).toBe("allow")
  })

  test("matches wildcard patterns with ask", () => {
    const ruleset = createRuleset({ "orchestrator-*": "ask" })
    expect(PermissionNext.evaluate("agent", "orchestrator-fast", ruleset).action).toBe("ask")
    const globalRuleset = createRuleset({ "*": "ask" })
    expect(PermissionNext.evaluate("agent", "code-reviewer", globalRuleset).action).toBe("ask")
  })

  test("later rules take precedence (last match wins)", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      "orchestrator-fast": "allow",
    })
    expect(PermissionNext.evaluate("agent", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(PermissionNext.evaluate("agent", "orchestrator-slow", ruleset).action).toBe("deny")
  })

  test("matches global wildcard", () => {
    expect(PermissionNext.evaluate("agent", "any-agent", createRuleset({ "*": "allow" })).action).toBe("allow")
    expect(PermissionNext.evaluate("agent", "any-agent", createRuleset({ "*": "deny" })).action).toBe("deny")
    expect(PermissionNext.evaluate("agent", "any-agent", createRuleset({ "*": "ask" })).action).toBe("ask")
  })
})

describe("PermissionNext.disabled for agent tool", () => {
  // Note: The `disabled` function checks if a TOOL should be completely removed from the tool list.
  // It only disables a tool when there's a rule with `pattern: "*"` and `action: "deny"`.
  // It does NOT evaluate complex subagent patterns - those are handled at runtime by `evaluate`.
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionNext.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "agent",
      pattern,
      action,
    }))

  test("agent tool is disabled when global deny pattern exists (even with specific allows)", () => {
    // When "*": "deny" exists, the agent tool is disabled because the disabled() function
    // only checks for wildcard deny patterns - it doesn't consider that specific subagents might be allowed
    const ruleset = createRuleset({
      "orchestrator-*": "allow",
      "*": "deny",
    })
    const disabled = PermissionNext.disabled(["agent", "bash", "read"], ruleset)
    // The agent tool IS disabled because there's a pattern: "*" with action: "deny"
    expect(disabled.has("agent")).toBe(true)
  })

  test("agent tool is disabled when global deny pattern exists (even with ask overrides)", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "ask",
      "*": "deny",
    })
    const disabled = PermissionNext.disabled(["agent"], ruleset)
    // The agent tool IS disabled because there's a pattern: "*" with action: "deny"
    expect(disabled.has("agent")).toBe(true)
  })

  test("agent tool is disabled when global deny pattern exists", () => {
    const ruleset = createRuleset({ "*": "deny" })
    const disabled = PermissionNext.disabled(["agent"], ruleset)
    expect(disabled.has("agent")).toBe(true)
  })

  test("agent tool is NOT disabled when only specific patterns are denied (no wildcard)", () => {
    // The disabled() function only disables tools when pattern: "*" && action: "deny"
    // Specific subagent denies don't disable the agent tool - those are handled at runtime
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      general: "deny",
    })
    const disabled = PermissionNext.disabled(["agent"], ruleset)
    // The agent tool is NOT disabled because no rule has pattern: "*" with action: "deny"
    expect(disabled.has("agent")).toBe(false)
  })

  test("agent tool is enabled when no agent rules exist (default ask)", () => {
    const disabled = PermissionNext.disabled(["agent"], [])
    expect(disabled.has("agent")).toBe(false)
  })

  test("agent tool is NOT disabled when last wildcard pattern is allow", () => {
    // Last matching rule wins - if wildcard allow comes after wildcard deny, tool is enabled
    const ruleset = createRuleset({
      "*": "deny",
      "orchestrator-coder": "allow",
    })
    const disabled = PermissionNext.disabled(["agent"], ruleset)
    // The disabled() function uses findLast and checks if the last matching rule
    // has pattern: "*" and action: "deny". In this case, the last rule matching
    // "agent" permission has pattern "orchestrator-coder", not "*", so not disabled
    expect(disabled.has("agent")).toBe(false)
  })
})

// Integration tests that load permissions from real config files
describe("permission.agent with real config files", () => {
  test("loads agent permissions from opencode.json config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          agent: {
            "*": "allow",
            "code-reviewer": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})
        // general and orchestrator-fast should be allowed, code-reviewer denied
        expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("agent", "orchestrator-fast", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("deny")
      },
    })
  })

  test("loads agent permissions with wildcard patterns from config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          agent: {
            "*": "ask",
            "orchestrator-*": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})
        // general and code-reviewer should be ask, orchestrator-* denied
        expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("ask")
        expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("ask")
        expect(PermissionNext.evaluate("agent", "orchestrator-fast", ruleset).action).toBe("deny")
      },
    })
  })

  test("evaluate respects agent permission from config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          agent: {
            general: "allow",
            "code-reviewer": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})
        expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("deny")
        // Unspecified agents default to "ask"
        expect(PermissionNext.evaluate("agent", "unknown-agent", ruleset).action).toBe("ask")
      },
    })
  })

  test("mixed permission config with agent and other tools", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: "allow",
          edit: "ask",
          agent: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})

        // Verify agent permissions
        expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("deny")

        // Verify other tool permissions
        expect(PermissionNext.evaluate("bash", "*", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("edit", "*", ruleset).action).toBe("ask")

        // Verify disabled tools
        const disabled = PermissionNext.disabled(["bash", "edit", "agent"], ruleset)
        expect(disabled.has("bash")).toBe(false)
        expect(disabled.has("edit")).toBe(false)
        // agent is NOT disabled because disabled() uses findLast, and the last rule
        // matching "agent" permission is {pattern: "general", action: "allow"}, not pattern: "*"
        expect(disabled.has("agent")).toBe(false)
      },
    })
  })

  test("agent tool disabled when global deny comes last in config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          agent: {
            general: "allow",
            "code-reviewer": "allow",
            "*": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})

        // Last matching rule wins - "*" deny is last, so all agents are denied
        expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("deny")
        expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("deny")
        expect(PermissionNext.evaluate("agent", "unknown", ruleset).action).toBe("deny")

        // Since "*": "deny" is the last rule, disabled() finds it with findLast
        // and sees pattern: "*" with action: "deny", so agent is disabled
        const disabled = PermissionNext.disabled(["agent"], ruleset)
        expect(disabled.has("agent")).toBe(true)
      },
    })
  })

  test("agent tool NOT disabled when specific allow comes last in config", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          agent: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})

        // Evaluate uses findLast - "general" allow comes after "*" deny
        expect(PermissionNext.evaluate("agent", "general", ruleset).action).toBe("allow")
        // Other agents still denied by the earlier "*" deny
        expect(PermissionNext.evaluate("agent", "code-reviewer", ruleset).action).toBe("deny")

        // disabled() uses findLast and checks if the last rule has pattern: "*" with action: "deny"
        // In this case, the last rule is {pattern: "general", action: "allow"}, not pattern: "*"
        // So the agent tool is NOT disabled (even though most subagents are denied)
        const disabled = PermissionNext.disabled(["agent"], ruleset)
        expect(disabled.has("agent")).toBe(false)
      },
    })
  })
})
