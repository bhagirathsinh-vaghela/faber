import { describe, expect, test } from "bun:test"
import { stripJobResult, stripTaskResult } from "../util/envelope"

// The writer emits a fixed header block, one blank line, then the output. The
// card reads the body back out. Recognising header lines instead of splitting
// at that separator disagrees with the writer in both directions: an output
// line shaped like a field is deleted, and a multi-line command puts its own
// tail below the `command:` line, where no field matches, so the command's
// source renders as the result. 51 of 302 delivered job results in one existing
// store showed the command's text as their body.
function envelope(command: string, output: string) {
  return [
    `<background-job-result>`,
    `job_id: 01a06284-0000-7000-0000-000000000001`,
    `command: ${command}`,
    `status: completed`,
    `exit: 0`,
    `duration: 12s`,
    `log: /tmp/job.log`,
    ``,
    output,
    `</background-job-result>`,
  ].join("\n")
}

describe("stripJobResult", () => {
  test("keeps an output line that looks like a header field", () => {
    const body = stripJobResult(envelope("grep -rn 'status:' src", "status: pending\nsrc/b.ts:4: done"))
    expect(body).toContain("status: pending")
    expect(body).toContain("done")
  })

  test("keeps an output line beginning with the command field's own name", () => {
    expect(stripJobResult(envelope("grep -rn command src", "command: run"))).toContain("command: run")
  })

  test("drops the tail of a multi-line command rather than drawing it as output", () => {
    const body = stripJobResult(envelope("python3 - <<'PY'\nprint('hello')\nPY", "hello"))
    expect(body).toBe("hello")
  })

  test("drops every header field", () => {
    const body = stripJobResult(envelope("echo hi", "hi"))
    expect(body).toBe("hi")
    expect(body).not.toContain("job_id:")
    expect(body).not.toContain("duration:")
  })

  test("an empty body stays empty", () => {
    expect(stripJobResult(envelope("true", ""))).toBe("")
  })

  // A wrapper with no blank-line separator is malformed (the writer always emits
  // one), but it must degrade the same way the task reader does: drop the known
  // header fields rather than return the raw header text as the body.
  test("a separator-less wrapper drops the header fields rather than echoing them", () => {
    const text = [
      `<background-job-result>`,
      `job_id: j1`,
      `command: echo hi`,
      `status: completed`,
      `exit: 0`,
      `duration: 1s`,
      `log: /tmp/j.log`,
      `hi`,
      `</background-job-result>`,
    ].join("\n")
    const body = stripJobResult(text)
    expect(body).toBe("hi")
    expect(body).not.toContain("job_id:")
    expect(body).not.toContain("command:")
  })
})

describe("stripTaskResult", () => {
  test("keeps an output line that looks like a header field", () => {
    const text = [
      `<background-task-result>`,
      `task_id: t1`,
      `type: subagent`,
      `status: completed`,
      `duration: 3s`,
      `agent: build`,
      `session_id: ses_1`,
      ``,
      `status: still here`,
      `the finding`,
      `</background-task-result>`,
    ].join("\n")
    const body = stripTaskResult(text)
    expect(body).toContain("status: still here")
    expect(body).toContain("the finding")
  })
})
