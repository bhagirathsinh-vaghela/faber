import { agentColor } from "./agent"
import { busyBase, busyOverlays, busyShown } from "@opencode-ai/ui/util/busy-tint"

export type Attention =
  | { kind: "error" }
  | { kind: "question"; tint: string }
  | { kind: "permission" }
  // Busy is the only layered state: `tint` fills the base dot and each entry in
  // `overlays` cross-fades over it, so call sites render one dot per colour.
  | { kind: "busy"; tint: string; overlays: string[] }
  | { kind: "unseen" }

export type AttentionInput = {
  error?: boolean
  question?: boolean
  permission?: boolean
  turn?: boolean
  subagents?: number
  jobs?: number
  unseen?: boolean
  agent?: string
}

export const AGENT_FALLBACK = "var(--icon-interactive-base)"

export function agentTint(agent: string | undefined, custom: string | undefined) {
  if (!agent) return AGENT_FALLBACK
  return agentColor(agent, custom) || AGENT_FALLBACK
}

// The one precedence every dot obeys: the two states that need the user answer
// first, then the two that only report what the session is doing. `custom` is
// the agent's configured color, resolved by the caller from its own store.
export function attention(input: AttentionInput, custom?: string): Attention | undefined {
  if (input.error) return { kind: "error" }
  if (input.question) return { kind: "question", tint: agentTint(input.agent, custom) }
  if (input.permission) return { kind: "permission" }
  // The dot and the spinners read the same facts through the same table, so
  // they cannot disagree about whether to show or about which colour.
  const facts = { turn: !!input.turn, subagents: input.subagents ?? 0, jobs: input.jobs ?? 0 }
  if (busyShown(facts)) {
    const agent = facts.turn ? agentTint(input.agent, custom) : undefined
    return { kind: "busy", tint: busyBase(facts, agent), overlays: busyOverlays(facts, agent) }
  }
  if (input.unseen) return { kind: "unseen" }
  return undefined
}

// Every state except busy paints one flat dot, so they share a single
// presentation: a class for the fixed colors, an inline tint for the agent one.
export function flat(state: Attention | undefined) {
  if (!state) return undefined
  if (state.kind === "busy") return undefined
  if (state.kind === "error") return { class: "bg-icon-critical-base", label: "home.attention.error" as const }
  if (state.kind === "permission")
    return { class: "bg-surface-warning-strong", label: "home.attention.permission" as const }
  if (state.kind === "question") return { class: "", tint: state.tint, label: "home.attention.question" as const }
  return { class: "bg-text-interactive-base", label: "home.attention.unseen" as const }
}

export function busy(state: Attention | undefined) {
  if (state?.kind !== "busy") return undefined
  return state
}

const RANK = { error: 0, question: 1, permission: 2, busy: 3, unseen: 4 } as const

// A project's dot is the strongest state across its sessions.
export function strongest(list: (Attention | undefined)[]) {
  return list.reduce<Attention | undefined>((best, next) => {
    if (!next) return best
    if (!best) return next
    return RANK[next.kind] < RANK[best.kind] ? next : best
  }, undefined)
}
