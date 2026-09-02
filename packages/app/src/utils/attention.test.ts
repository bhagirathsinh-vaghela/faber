import { describe, expect, test } from "bun:test"
import { attention, busy } from "./attention"

// The overview dot and the spinners elsewhere read the same facts through the
// same table. A dot that appears on a narrower condition than the spinner
// leaves a session looking idle in one place and working in another, and the
// two views disagree about a session the user is deciding whether to stop.
describe("attention — work that no turn is executing", () => {
  test("a running job shows a busy dot with no turn in flight", () => {
    const state = busy(attention({ busy: false, busyJob: true }))
    expect(state?.tint).toBe("var(--box-accent-job)")
    expect(state?.overlays).toEqual([])
  })

  test("a helper owing a report shows one too", () => {
    const state = busy(attention({ busy: false, busyHelper: true }))
    expect(state?.tint).toBe("var(--box-accent-helper)")
  })

  test("an own turn alongside a job crossfades the job accent over the agent", () => {
    const state = busy(attention({ busy: true, busySelf: true, busyJob: true, agent: "build" }))
    expect(state?.overlays).toEqual(["var(--box-accent-job)"])
  })

  test("nothing running shows no busy dot", () => {
    expect(busy(attention({ busy: false }))).toBeUndefined()
  })

  // The states that need an answer still outrank the ones that only report
  // what a session is doing, whatever is running underneath them.
  test("a question outranks a running job", () => {
    expect(attention({ busy: false, busyJob: true, question: true })?.kind).toBe("question")
  })
})
