import { test, expect } from "bun:test"
import { BackgroundProcess } from "../../src/background/process"

// The coupling the two halves of the kill depend on. The wrapper's own trap ends
// a SIGTERM-ignoring command on its `ESCALATION_SECONDS` clock; the outer
// `SIGKILL_DELAY_MS` must EXCEED that window so the outer SIGKILL is a backstop
// that fires only if the trap failed, not a signal that tears the wrapper's
// group down mid-escalation. This is the one falsifiable statement of the
// coupling: a live-kill test cannot see it, because the trap kills the command
// whether or not the outer delay is right.
test("the outer kill delay exceeds the wrapper's own escalation window", () => {
  expect(BackgroundProcess.SIGKILL_DELAY_MS).toBeGreaterThan(BackgroundProcess.ESCALATION_SECONDS * 1000)
})
