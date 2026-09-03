import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

type PartInput = {
  text: string
  synthetic?: boolean
  internal?: boolean
  backgroundJobResult?: MessageV2.BackgroundJobResult
  backgroundTaskResult?: MessageV2.BackgroundTaskResult
}

function user(parts: PartInput[]) {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    } as MessageV2.User,
    parts: parts.map((part) => ({
      id: Identifier.ascending("part"),
      messageID: id,
      sessionID: "ses_test",
      type: "text" as const,
      text: part.text,
      ...(part.synthetic ? { synthetic: true } : {}),
      ...(part.internal ? { internal: true } : {}),
      ...(part.backgroundJobResult ? { backgroundJobResult: part.backgroundJobResult } : {}),
      ...(part.backgroundTaskResult ? { backgroundTaskResult: part.backgroundTaskResult } : {}),
    })) as MessageV2.Part[],
  }
}

function body(msg: MessageV2.WithParts, index = 0) {
  const part = msg.parts[index]
  return part.type === "text" ? part.text : ""
}

// The last finished assistant floor: a message minted after this id joined the
// turn already in flight, so wrapQueued should frame it.
const floor = Identifier.ascending("message")
const jobResult: MessageV2.BackgroundJobResult = {
  jobId: "job_x",
  command: "go test ./...",
  description: "run tests",
  status: "completed",
  exit: 0,
  log: "",
  duration: 1200,
}
const taskResult: MessageV2.BackgroundTaskResult = {
  taskId: "prt_x",
  type: "subagent",
  description: "audit",
  status: "completed",
  duration: 3400,
}

describe("wrapQueued frames what joined the turn", () => {
  test("a delivered job result is framed as a finished background job", () => {
    const msg = user([{ text: "<background-job-result>...", synthetic: true, backgroundJobResult: jobResult }])
    SessionPrompt.wrapQueued([msg], floor)
    expect(body(msg)).toContain("A background job you started has finished")
    expect(body(msg)).toContain("<background-job-result>...")
    expect(body(msg)).toContain("Please address this and continue")
  })

  test("a delivered subtask result is framed as a finished background task", () => {
    const msg = user([{ text: "<background-task-result>...", synthetic: true, backgroundTaskResult: taskResult }])
    SessionPrompt.wrapQueued([msg], floor)
    expect(body(msg)).toContain("A background task you delegated has finished")
  })

  test("a typed prompt is framed as the user's message", () => {
    const msg = user([{ text: "also fix the header" }])
    SessionPrompt.wrapQueued([msg], floor)
    expect(body(msg)).toContain("The user sent the following message:")
    expect(body(msg)).toContain("also fix the header")
  })
})

describe("wrapQueued leaves alone what should not be framed", () => {
  test("an internal part (MCP catalog, rule reminder) is untouched", () => {
    const msg = user([{ text: "<mcp_tool_catalog>...", synthetic: true, internal: true }])
    SessionPrompt.wrapQueued([msg], floor)
    expect(body(msg)).toBe("<mcp_tool_catalog>...")
  })

  test("a bare synthetic part with no result marker is untouched", () => {
    const msg = user([{ text: "resume", synthetic: true }])
    SessionPrompt.wrapQueued([msg], floor)
    expect(body(msg)).toBe("resume")
  })

  test("a message older than the finished floor is untouched", () => {
    const old = user([{ text: "an earlier prompt" }])
    // Mint the floor AFTER the message so the message id is below it.
    SessionPrompt.wrapQueued([old], Identifier.ascending("message"))
    expect(body(old)).toBe("an earlier prompt")
  })

  test("an ignored part is untouched", () => {
    const msg = user([{ text: "typed but ignored" }])
    ;(msg.parts[0] as MessageV2.TextPart).ignored = true
    SessionPrompt.wrapQueued([msg], floor)
    expect(body(msg)).toBe("typed but ignored")
  })
})
