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

// A job killed before it could write its own exit file records no exit code.
// Reading that absence as a non-zero exit claims the command failed, when
// nothing establishes whether it did. The record keeps "we do not know" apart
// from "returned non-zero", so every reader of it has to.
describe("BackgroundNotify: an exit code nobody recorded", () => {
  test("a job with no exit code is not called failed", () => {
    const record = job({ exit: undefined })
    expect(BackgroundNotify.meta(record, "completed").status).toBe("ended")
    expect(BackgroundNotify.render(record, "out", "completed")).toContain(
      "status: ended without recording an exit code",
    )
    expect(BackgroundNotify.render(record, "out", "completed")).toContain("exit: unknown")
  })

  test("a real non-zero exit is still a failure", () => {
    const record = job({ exit: 2 })
    expect(BackgroundNotify.meta(record, "completed").status).toBe("failed")
    expect(BackgroundNotify.render(record, "out", "completed")).toContain("status: failed")
  })

  test("a zero exit is still a completion", () => {
    expect(BackgroundNotify.meta(job(), "completed").status).toBe("completed")
  })
})

// The header is a fixed block the writer joins a blank line after, so the body
// begins at that separator. A reader that instead recognises header lines
// disagrees with the writer in both directions: it deletes an output line that
// looks like a field, and it keeps the tail of a multi-line command, which then
// renders as the result.
describe("BackgroundNotify: the header/body boundary", () => {
  test("output lines that look like header fields survive the envelope", () => {
    const rendered = BackgroundNotify.render(job(), "status: still here\ncommand: grep hit\ndone", "completed")
    const body = rendered.slice(rendered.indexOf("\n\n") + 2)
    expect(body).toContain("status: still here")
    expect(body).toContain("command: grep hit")
  })

  test("a multi-line command keeps its tail out of the body", () => {
    const rendered = BackgroundNotify.render(job({ command: "python3 - <<'PY'\nprint('x')\nPY" }), "done", "completed")
    const body = rendered.slice(rendered.indexOf("\n\n") + 2)
    expect(body).not.toContain("print('x')")
    expect(body).toContain("done")
  })

  // A command with an INTERNAL blank line (a heredoc script with an empty line)
  // would otherwise put a `\n\n` inside the header, so the reader's split at the
  // first blank line lands mid-header and every field below `command:` plus the
  // command's own tail render as the body. Collapsing blank lines in the value
  // keeps the real separator the only one, so the split still finds the body.
  test("a command containing a blank line does not forge the header boundary", () => {
    const command = "python3 - <<'PY'\nprint('a')\n\nprint('b')\nPY"
    const rendered = BackgroundNotify.render(job({ command }), "the real output", "completed")
    const body = rendered.slice(rendered.indexOf("\n\n") + 2).replace(/\n?<\/background-job-result>$/, "")

    expect(body).toBe("the real output")
    // The split landed at the real separator, so no header field and none of the
    // command's own lines leaked into the body.
    expect(body).not.toContain("status:")
    expect(body).not.toContain("log:")
    expect(body).not.toContain("print('b')")
  })

  // A SINGLE trailing newline is the subtler case: it is not a blank line on its
  // own, but it abuts the next header field across render's join and forges the
  // separator all the same. The value must end with no newline at all.
  test("a command with a trailing newline does not forge the header boundary", () => {
    const rendered = BackgroundNotify.render(job({ command: "echo hi\n" }), "the real output", "completed")
    const body = rendered.slice(rendered.indexOf("\n\n") + 2).replace(/\n?<\/background-job-result>$/, "")

    expect(body).toBe("the real output")
    expect(body).not.toContain("status:")
    expect(body).not.toContain("log:")
  })

  // A genuinely multi-line command (distinct non-blank lines) must survive intact
  // in the header — collapsing must remove only blank lines, never fold real ones.
  test("keeps the lines of a multi-line command that has no blank line", () => {
    const rendered = BackgroundNotify.render(
      job({ command: "python3 - <<'PY'\nprint('a')\nprint('b')\nPY" }),
      "the real output",
      "completed",
    )
    expect(rendered).toContain("print('a')")
    expect(rendered).toContain("print('b')")
    const body = rendered.slice(rendered.indexOf("\n\n") + 2).replace(/\n?<\/background-job-result>$/, "")
    expect(body).toBe("the real output")
  })
})
