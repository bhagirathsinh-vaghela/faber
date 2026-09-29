import { describe, expect, test } from "bun:test"
import { jobAccent, jobGlyph, jobLabel, jobStatusColor } from "../util/job-status"

// A job killed before it wrote its exit code records no outcome, so the writer
// reports its status as `ended` (BackgroundNotify.statusWord for an undefined
// exit). Every reader must show that as NOT a success: the fix that named the
// unknown exit reached the jobs page and the envelope but originally fell
// through to the ✓ / "JOB DONE" / finished-colour default in this card renderer.
describe("job-status: an ended (unknown-exit) job is never shown as success", () => {
  test("the glyph is not the success check", () => {
    expect(jobGlyph("ended")).not.toBe("✓")
    expect(jobGlyph("ended")).toBe("•")
  })

  test("the label is not JOB DONE", () => {
    expect(jobLabel("ended")).not.toBe("JOB DONE")
    expect(jobLabel("ended")).toBe("JOB ENDED (EXIT UNKNOWN)")
  })

  test("the accent is muted, not the finished job accent", () => {
    expect(jobAccent("ended")).not.toBe("var(--box-accent-job)")
    expect(jobAccent("ended")).toBe("var(--text-weak)")
  })

  test("the status colour is muted, not the finished string colour", () => {
    expect(jobStatusColor("ended")).not.toBe("var(--syntax-string)")
    expect(jobStatusColor("ended")).toBe("var(--text-weak)")
  })
})

// The other statuses keep the vocabulary a reader already learned elsewhere.
describe("job-status: the other statuses are unchanged", () => {
  test("a completed job is the success vocabulary", () => {
    expect(jobGlyph("completed")).toBe("✓")
    expect(jobLabel("completed")).toBe("JOB DONE")
    expect(jobAccent("completed")).toBe("var(--box-accent-job)")
  })

  test("failed and timeout are critical", () => {
    expect(jobGlyph("failed")).toBe("✗")
    expect(jobGlyph("timeout")).toBe("⏱")
    expect(jobAccent("failed")).toBe("var(--syntax-critical)")
    expect(jobAccent("timeout")).toBe("var(--syntax-critical)")
  })

  test("a job a Stop killed is muted and named, never the success vocabulary", () => {
    expect(jobLabel("stopped")).toBe("JOB STOPPED")
    expect(jobGlyph("stopped")).toBe("■")
    expect(jobAccent("stopped")).toBe("var(--text-weak)")
    expect(jobStatusColor("stopped")).toBe("var(--text-weak)")
  })

  test("running is its own not-finished treatment", () => {
    expect(jobGlyph("running")).toBe("◐")
    expect(jobLabel("running")).toBe("JOB RUNNING")
    expect(jobStatusColor("running")).toBe("var(--syntax-constant)")
  })
})
