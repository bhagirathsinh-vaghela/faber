import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Command } from "../command"
import { InstructionPrompt } from "./instruction"

// A session's prompt-shaping state is PINNED to the generation that was
// current when the session first ran after server boot. Instance dispose
// (config reload) rebuilds the generation for NEW sessions, but a pinned
// session keeps serving byte-identical prompt state — both for UX stability
// and because the Anthropic prompt cache hashes the request prefix
// (tools[] + system), so swapping instructions mid-session pays a full
// cache miss. Pins are process-lifetime only by design: a server restart is
// the sanctioned way to refresh every session.
export namespace SessionPin {
  export interface Snapshot {
    instructions: { global: string[]; project: string[] }
    agents: Record<string, Agent.Info>
    agentList: Agent.Info[]
    defaultAgent: string | undefined
    skills: Record<string, Skill.Info>
    commands: Record<string, Command.Info>
    toolsets: Record<string, string[]>
  }

  // One snapshot per instance generation: Instance.state memoizes it, and
  // instance dispose clears the memo, so sessions pinning after a dispose
  // share a fresh snapshot while earlier pins keep the old object alive.
  const generation = Instance.state(async (): Promise<Snapshot> => {
    const [instructions, agents, skills, commands, toolsets, fallback] = await Promise.all([
      InstructionPrompt.system(),
      Agent.list(),
      Skill.all(),
      Command.list(),
      Agent.toolsets(),
      Agent.defaultAgent().catch(() => undefined),
    ])
    return {
      instructions,
      agents: Object.fromEntries(agents.map((a) => [a.name, a])),
      agentList: agents,
      defaultAgent: fallback,
      skills: Object.fromEntries(skills.map((s) => [s.name, s])),
      commands: Object.fromEntries(commands.map((c) => [c.name, c])),
      toolsets,
    }
  })

  // Module-level so pins survive instance dispose; sessionIDs are globally
  // unique so no directory key is needed.
  const pins = new Map<string, Promise<Snapshot>>()

  export function get(sessionID: string) {
    const existing = pins.get(sessionID)
    if (existing) return existing
    const pin = generation()
    pins.set(sessionID, pin)
    return pin
  }

  export function ensure(sessionID: string) {
    void get(sessionID)
  }

  // Subtasks must see the exact prompt state of their parent — a refresh
  // between parent turn and child spawn would otherwise give them different
  // instructions.
  export function adopt(childID: string, parentID: string) {
    if (pins.has(childID)) return
    pins.set(childID, get(parentID))
  }

  export function drop(sessionID: string) {
    pins.delete(sessionID)
  }
}
