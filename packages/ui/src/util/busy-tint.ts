// The colours a busy indicator cross-fades between, in one place.
//
// Three independent things can make a session busy — its own turn, a subagent
// under it, a background command it is waiting on — and any combination of them
// can run at once. Each contributes one colour, and every indicator fades
// through all the contributing colours in lockstep, so the number of tints a
// reader sees is the number of things actually working.
//
// One implementation because every indicator must agree: a table living at its
// own render site can only express the states its author had in mind, so a new
// busy cause reaches whichever copies get edited and silently omits the rest.

// The task accent covers a subagent and the job accent a background command. The
// job indicator carries the gold indicator colour, distinct from the blue accent
// its result card draws. Own turns carry the agent's own colour, which the
// caller resolves and passes in.
const TASK = "var(--box-accent-task)"
const JOB = "var(--box-indicator-job)"

export type BusyFacts = {
  busySelf: boolean
  busyDescendant: boolean
  busyJob?: boolean
}

// Ordered by which colour a reader should see first when only one is showing:
// the session's own turn is what they are watching, then a subagent, then a job.
// The first entry is the base every overlay fades over.
export function busyTints(facts: BusyFacts, agent: string | undefined) {
  const tints: string[] = []
  if (facts.busySelf) tints.push(agent ?? "var(--icon-interactive-base)")
  if (facts.busyDescendant) tints.push(TASK)
  if (facts.busyJob) tints.push(JOB)
  return tints
}

// The colour the indicator paints when nothing is fading over it. A session can
// be busy with no fact set (a turn whose rollup has not landed yet), so the
// base falls back rather than leaving the indicator untinted.
export function busyBase(facts: BusyFacts, agent: string | undefined) {
  return busyTints(facts, agent)[0] ?? TASK
}

// Whether an indicator shows at all. `busy` covers the turns in the open
// subtree; a running job is work the session is waiting on that no turn is
// executing, so it never reaches that rollup. An indicator keyed on `busy` alone
// goes dark while the answer is still coming back, which reads as finished.
export function busyShown(facts: { busy: boolean } & BusyFacts) {
  return facts.busy || facts.busyJob === true
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
