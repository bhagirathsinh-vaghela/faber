import type { Agent } from "./agent"

// Repo-scoped subagents are announced in a durable message block rather than in
// the task tool's description. The description rides in tools[], at the front of
// Anthropic's cumulative prefix hash, so listing an agent that exists in only
// one project would change those bytes per directory and cost every project the
// shared prefix. A message block sits after the system markers, where per-project
// content already lives.
export namespace AgentCatalog {
  const MARKER = "<project_subagents>"

  export function build(agents: Agent.Info[]): string | undefined {
    if (agents.length === 0) return undefined
    const lines = agents
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
    return [
      MARKER,
      "These subagents are defined by the current project and are available to the task tool in addition to the ones listed in its description. Pass the name as subagent_type.",
      ...lines,
      "</project_subagents>",
    ].join("\n")
  }
}
