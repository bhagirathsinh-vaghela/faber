// The colours a busy indicator cross-fades between, in one place.
//
// Three independent things can make a session busy — its own turn, a subagent
// it called, a background command it is waiting on — and any combination of them
// can run at once. Each contributes one colour, and every indicator fades
// through all the contributing colours in lockstep, so the number of tints a
// reader sees is the number of things actually working.
//
// One implementation because every indicator must agree: a table living at its
// own render site can only express the states its author had in mind, so a new
// busy cause reaches whichever copies get edited and silently omits the rest.

// The subagent accent covers a subagent and the job accent a background command.
// The job indicator carries the gold indicator colour, distinct from the blue
// accent its result card draws. Own turns carry the agent's own colour, which the
// caller resolves and passes in.
const SUBAGENT = "var(--box-accent-subagent)"
const JOB = "var(--box-indicator-job)"

// `subagents` and `jobs` count the open debts where this session is the caller.
export type BusyFacts = {
  turn: boolean
  subagents: number
  jobs: number
}

export const IDLE: BusyFacts = { turn: false, subagents: 0, jobs: 0 }

// Ordered by which colour a reader should see first when only one is showing:
// the session's own turn is what they are watching, then a subagent, then a job.
// The first entry is the base every overlay fades over.
export function busyTints(facts: BusyFacts, agent: string | undefined) {
  const tints: string[] = []
  if (facts.turn) tints.push(agent ?? "var(--icon-interactive-base)")
  if (facts.subagents > 0) tints.push(SUBAGENT)
  if (facts.jobs > 0) tints.push(JOB)
  return tints
}

// The colour the indicator paints when nothing is fading over it. Callers read
// this unconditionally, including while an indicator fades out after going idle,
// so an idle session still resolves to a colour rather than leaving it untinted.
export function busyBase(facts: BusyFacts, agent: string | undefined) {
  return busyTints(facts, agent)[0] ?? SUBAGENT
}

export function busyShown(facts: BusyFacts) {
  return facts.turn || facts.subagents > 0 || facts.jobs > 0
}

// The colours that fade OVER the base, which is every contributing colour after
// the first. Empty when one thing is working, so an indicator with a single
// cause renders no overlay at all.
export function busyOverlays(facts: BusyFacts, agent: string | undefined) {
  return busyTints(facts, agent).slice(1)
}

// Each overlay's animation is phase-shifted so N colours divide the cycle
// evenly rather than peaking together. A single overlay lands on the half-cycle
// offset, which is what a two-colour cross-fade already holds.
const CYCLE = 2.6

export function busyDelay(index: number, total: number) {
  return `-${((CYCLE * (index + 1)) / (total + 1)).toFixed(2)}s`
}
