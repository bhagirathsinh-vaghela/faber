import { describe, expect, test } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundNotify } from "../../src/background/notify"

function job(overrides: Partial<BackgroundJob.Info> = {}): BackgroundJob.Info {
  const created = Date.now() - 12_000
  return {
    id: "01a06284-0000-7000-0000-000000000001",
    sessionID: "ses_notify_test",
    directory: "/tmp",
    command: "go test ./...",
    description: "run tests",
    status: "exited",
    exit: 0,
    time: { created, hard: created + 600_000, completed: created + 12_000 },
    ...overrides,
  }
}

describe("BackgroundNotify header", () => {
  test("carries what the model needs to act without a lookup", () => {
    const text = BackgroundNotify.render(job(), "ok\n", "completed")

    expect(text).toContain("job_id: 01a06284-0000-7000-0000-000000000001")
    expect(text).toContain("command: go test ./...")
    expect(text).toContain("status: completed")
    expect(text).toContain("exit: 0")
    expect(text).toContain("duration: 12s")
    // The path is what makes a pointer result actionable.
    expect(text).toContain(`log: ${BackgroundJob.logPath("01a06284-0000-7000-0000-000000000001")}`)
  })

  test("reports a non-zero exit as failed", () => {
    expect(BackgroundNotify.render(job({ exit: 1 }), "boom\n", "completed")).toContain("status: failed")
  })

  // A job killed by its own watchdog never wrote an exit code, and the reader
  // must not read that absence as success.
  test("names a timeout kill and says the exit is unknown", () => {
    const text = BackgroundNotify.render(job({ status: "killed", exit: undefined }), "partial\n", "timeout")

    expect(text).toContain("status: killed after exceeding its time limit")
    expect(text).toContain("exit: unknown")
    // Whatever it managed to write is still delivered.
    expect(text).toContain("partial")
  })
})

describe("BackgroundNotify card metadata", () => {
  // The envelope and the metadata are read by the same renderer, and it only
  // draws a card when both agree. Text alone renders as a wall of output.
  test("wraps the result in its own tag, distinct from a subagent task's", () => {
    const text = BackgroundNotify.render(job(), "ok\n", "completed")
    expect(text).toStartWith("<background-job-result>")
    expect(text).toEndWith("</background-job-result>")
    expect(text).not.toContain("background-task-result")
  })

  test("carries what identifies a job: its command, log and exit code", () => {
    const meta = BackgroundNotify.meta(job(), "completed")
    expect(meta.jobId).toBe(job().id)
    expect(meta.command).toBe("go test ./...")
    expect(meta.exit).toBe(0)
    expect(meta.log).toContain(job().id)
    expect(meta.description).toBe("run tests")
    expect(meta.duration).toBe(12_000)
  })

  test("reports a failing command as failed", () => {
    expect(BackgroundNotify.meta(job({ exit: 1 }), "completed").status).toBe("failed")
  })

  // A watchdog kill is not the command failing on its own, and a reader acts
  // differently on each.
  test("names a timeout rather than folding it into failed", () => {
    expect(BackgroundNotify.meta(job({ status: "killed", exit: undefined }), "timeout").status).toBe("timeout")
  })

  // A check-in is delivered while the job is still going, so a finished status
  // would be a lie.
  test("reports a check-in as running", () => {
    const running = job({
      status: "running",
      exit: undefined,
      time: { created: Date.now() - 60_000, hard: Date.now() },
    })
    expect(BackgroundNotify.meta(running, "checkin").status).toBe("running")
  })
})

describe("BackgroundNotify body", () => {
  test("inlines a small result whole", () => {
    const text = BackgroundNotify.render(job(), "line one\nline two\n", "completed")

    expect(text).toContain("line one")
    expect(text).toContain("line two")
    expect(text).not.toContain("full output in the log")
  })

  test("points at the log when the line count is large, keeping the tail", () => {
    const output = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n")
    const text = BackgroundNotify.render(job(), output, "completed")

    expect(text).toContain("500 lines")
    expect(text).toContain("full output in the log above")
    // The tail is where a failing build puts its error.
    expect(text).toContain("line-499")
    expect(text).not.toContain("line-0\n")
  })

  // Fifty lines of minified output is not a small result, which is why the
  // byte bound exists alongside the line bound.
  test("points at the log when few lines are still too many bytes", () => {
    const output = Array.from({ length: 5 }, () => "x".repeat(2_000)).join("\n")
    const text = BackgroundNotify.render(job(), output, "completed")

    expect(text).toContain("bytes")
    expect(text).toContain("full output in the log above")
  })

  test("says so plainly when a job produced nothing", () => {
    expect(BackgroundNotify.render(job(), "", "completed")).toContain("(no output)")
  })
})

describe("BackgroundNotify check-in", () => {
  // The soft deadline reports progress; it must not read as a finished job.
  // It shares the result envelope so it renders as a card, and the running
  // status plus the absent exit code are what distinguish it.
  test("reports elapsed time and no exit code", () => {
    const running = job({
      status: "running",
      exit: undefined,
      time: { created: Date.now() - 300_000, hard: Date.now() + 300_000 },
    })
    const text = BackgroundNotify.render(running, "compiling\n", "checkin")

    expect(text).toContain("<background-job-result>")
    expect(text).toContain("still running after 300s")
    expect(text).not.toContain("exit:")
  })

  // Progress is about where a job has GOT to, so a check-in always tails.
  test("shows the tail of a long log rather than its head", () => {
    const running = job({ status: "running", exit: undefined })
    const output = Array.from({ length: 300 }, (_, i) => `step-${i}`).join("\n")
    const text = BackgroundNotify.render(running, output, "checkin")

    expect(text).toContain("step-299")
    expect(text).not.toContain("step-1\n")
  })
})
