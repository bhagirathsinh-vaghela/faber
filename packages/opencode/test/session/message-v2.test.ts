import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

const sessionID = "session"
const model: Provider.Model = {
  id: "test-model",
  providerID: "test",
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id,
    sessionID,
    messageID,
  }
}

function compactionUser(id: string): MessageV2.WithParts {
  return {
    info: userInfo(id),
    parts: [{ ...basePart(id, id + "-p"), type: "compaction", auto: true }] as MessageV2.Part[],
  }
}

function summaryAssistant(id: string, parentID: string): MessageV2.WithParts {
  return {
    info: { ...assistantInfo(id, parentID), summary: true, finish: "stop" } as MessageV2.Assistant,
    parts: [{ ...basePart(id, id + "-p"), type: "text", text: "summary" }] as MessageV2.Part[],
  }
}

function plainUser(id: string, text: string): MessageV2.WithParts {
  return {
    info: userInfo(id),
    parts: [{ ...basePart(id, id + "-p"), type: "text", text }] as MessageV2.Part[],
  }
}

async function* toStream(msgs: MessageV2.WithParts[]) {
  for (const msg of msgs) yield msg
}

describe("session.message-v2.filterCompacted", () => {
  // Stream is newest-first. A compaction pair: user request U (compaction part)
  // answered by summary assistant S (summary+finish, parentID=U). Everything
  // before U should be dropped once S answers U.

  test("drops pre-compaction history when the summary sorts after its request", async () => {
    // newest-first: S (newest) -> U -> old
    const stream = toStream([summaryAssistant("s", "u"), compactionUser("u"), plainUser("old", "old turn")])
    const result = await MessageV2.filterCompacted(stream)
    // result is oldest-first after reverse; boundary is U, so "old" is dropped.
    expect(result.map((m) => m.info.id)).toStrictEqual(["u", "s"])
  })

  test("still finds the boundary when the summary sorts BEFORE its request (id inversion)", async () => {
    // Inversion: the summary carries a smaller id than its own request, so
    // newest-first yields U before S. The old single-pass build-as-you-walk
    // missed the boundary here and kept "old"; the link-based two-pass finds it.
    const stream = toStream([compactionUser("u"), summaryAssistant("s", "u"), plainUser("old", "old turn")])
    const result = await MessageV2.filterCompacted(stream)
    expect(result.map((m) => m.info.id)).toStrictEqual(["s", "u"])
  })

  test("keeps all history when no compaction has completed", async () => {
    const stream = toStream([plainUser("u2", "second"), plainUser("u1", "first")])
    const result = await MessageV2.filterCompacted(stream)
    expect(result.map((m) => m.info.id)).toStrictEqual(["u1", "u2"])
  })

  test("does not cut at a compaction request with no matching summary", async () => {
    // U has a compaction part but no summary answers it yet: history is kept.
    const stream = toStream([compactionUser("u"), plainUser("old", "old turn")])
    const result = await MessageV2.filterCompacted(stream)
    expect(result.map((m) => m.info.id)).toStrictEqual(["old", "u"])
  })
})

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([])
  })

  test("includes synthetic text parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model).messages).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    expect(result.messages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("returns correct idToIndex mapping", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user-1"),
        parts: [
          {
            ...basePart("m-user-1", "p1"),
            type: "text",
            text: "first",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant-1", "m-user-1"),
        parts: [
          {
            ...basePart("m-assistant-1", "p2"),
            type: "text",
            text: "response 1",
          },
        ] as MessageV2.Part[],
      },
      {
        // This message should be skipped (empty parts)
        info: userInfo("m-user-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user-2"),
        parts: [
          {
            ...basePart("m-user-2", "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    // Should have 3 messages (skipped the empty one)
    expect(result.messages).toHaveLength(3)

    // Check idToIndex mapping
    expect(result.idToIndex.get("m-user-1")).toBe(0)
    expect(result.idToIndex.get("m-assistant-1")).toBe(1)
    expect(result.idToIndex.get("m-user-empty")).toBeUndefined() // skipped
    expect(result.idToIndex.get("m-user-2")).toBe(2)
  })

  test("idToIndex accounts for tool block offsets from convertToModelMessages", () => {
    // convertToModelMessages adds a 'tool' role message after each assistant with tool outputs.
    // This shifts subsequent indices by 1 for each such assistant.
    // Example: user(0), assistant+tool(1), [tool block inserted at 2], user(3)
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user-1"),
        parts: [{ ...basePart("m-user-1", "p1"), type: "text", text: "hello" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant-1", "m-user-1"),
        parts: [
          { ...basePart("m-assistant-1", "p2"), type: "text", text: "let me help" },
          {
            ...basePart("m-assistant-1", "p3"),
            type: "tool",
            tool: "bash",
            callID: "tc1",
            state: { status: "completed", input: { command: "ls" }, output: "file.txt", time: {}, metadata: {} },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo("m-user-2"),
        parts: [{ ...basePart("m-user-2", "p4"), type: "text", text: "thanks" }] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    // convertToModelMessages produces: user(0), assistant(1), tool(2), user(3)
    expect(result.messages).toHaveLength(4)
    expect(result.messages[0].role).toBe("user")
    expect(result.messages[1].role).toBe("assistant")
    expect(result.messages[2].role).toBe("tool")
    expect(result.messages[3].role).toBe("user")

    // idToIndex should account for the inserted tool block
    expect(result.idToIndex.get("m-user-1")).toBe(0)
    expect(result.idToIndex.get("m-assistant-1")).toBe(1)
    expect(result.idToIndex.get("m-user-2")).toBe(3) // shifted by 1 due to tool block
  })

  test("idToIndex with multiple assistant-with-tools messages", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user-1"),
        parts: [{ ...basePart("m-user-1", "p1"), type: "text", text: "first" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant-1", "m-user-1"),
        parts: [
          { ...basePart("m-assistant-1", "p2"), type: "text", text: "response 1" },
          {
            ...basePart("m-assistant-1", "p3"),
            type: "tool",
            tool: "bash",
            callID: "tc1",
            state: { status: "completed", input: { command: "ls" }, output: "out1", time: {}, metadata: {} },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo("m-user-2"),
        parts: [{ ...basePart("m-user-2", "p4"), type: "text", text: "second" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant-2", "m-user-2"),
        parts: [
          { ...basePart("m-assistant-2", "p5"), type: "text", text: "response 2" },
          {
            ...basePart("m-assistant-2", "p6"),
            type: "tool",
            tool: "read",
            callID: "tc2",
            state: { status: "completed", input: { path: "x" }, output: "out2", time: {}, metadata: {} },
          },
        ] as MessageV2.Part[],
      },
      {
        info: userInfo("m-user-3"),
        parts: [{ ...basePart("m-user-3", "p7"), type: "text", text: "third" }] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    // Structure: user(0), assistant(1), tool(2), user(3), assistant(4), tool(5), user(6)
    expect(result.messages).toHaveLength(7)

    // Verify indices account for both tool block insertions
    expect(result.idToIndex.get("m-user-1")).toBe(0)
    expect(result.idToIndex.get("m-assistant-1")).toBe(1)
    expect(result.idToIndex.get("m-user-2")).toBe(3) // +1 offset from first tool block
    expect(result.idToIndex.get("m-assistant-2")).toBe(4) // +1 offset
    expect(result.idToIndex.get("m-user-3")).toBe(6) // +2 offset from both tool blocks
  })
})
