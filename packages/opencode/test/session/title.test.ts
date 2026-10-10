import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { connected, tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

connected()

Log.init({ print: false })

function userMessage(input: { sessionID: string; text: string; synthetic?: boolean }): MessageV2.WithParts {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      role: "user",
      sessionID: input.sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      synthetic: input.synthetic,
    },
    parts: [
      {
        id: Identifier.ascending("part"),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
        synthetic: input.synthetic,
      },
    ],
  }
}

function assistantMessage(input: { sessionID: string; text: string }): MessageV2.WithParts {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      role: "assistant",
      sessionID: input.sessionID,
      parentID: Identifier.ascending("message"),
      time: { created: Date.now() },
      agent: "build",
      mode: "build",
      system: [],
      path: { cwd: "/", root: "/" },
      modelID: "test",
      providerID: "test",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    } as unknown as MessageV2.Assistant,
    parts: [
      {
        id: Identifier.ascending("part"),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
      },
    ],
  }
}

describe("session title parse", () => {
  test("takes the title out of the requested object", () => {
    expect(SessionPrompt.parseTitle('{"title": "Fix login button on mobile"}')).toBe("Fix login button on mobile")
  })

  test("reads the object out of a think-wrapped answer", () => {
    expect(SessionPrompt.parseTitle('<think>weighing it up</think>\n{"title": "Add OAuth authentication"}')).toBe(
      "Add OAuth authentication",
    )
  })

  test("keeps the existing title when the answer is prose", () => {
    expect(SessionPrompt.parseTitle("Sure! Here is a title for your session.")).toBeUndefined()
  })

  test("keeps the existing title when the answer is a bare fence", () => {
    expect(SessionPrompt.parseTitle("```")).toBeUndefined()
  })

  test("keeps the existing title when the object carries no title", () => {
    expect(SessionPrompt.parseTitle('{"name": "Fix login button"}')).toBeUndefined()
  })

  test("keeps the existing title when the object is malformed", () => {
    expect(SessionPrompt.parseTitle('{"title": "unterminated')).toBeUndefined()
  })

  test("keeps the existing title when the title is blank", () => {
    expect(SessionPrompt.parseTitle('{"title": "   "}')).toBeUndefined()
  })

  test("rejects an over-long title rather than truncating it", () => {
    const long = "Investigate and fix the issue where the login button does not respond on mobile devices"
    expect(long.length).toBeGreaterThan(80)
    expect(SessionPrompt.parseTitle(JSON.stringify({ title: long }))).toBeUndefined()
  })
})

describe("session title input", () => {
  test("reads the user's prompts and not the assistant's replies", () => {
    const content = SessionPrompt.titleInput([
      userMessage({ sessionID: "ses_test", text: "add retries to the http client" }),
      assistantMessage({ sessionID: "ses_test", text: "```ts\nconst retry = () => {}\n```" }),
      userMessage({ sessionID: "ses_test", text: "cap them at three" }),
    ])
    expect(content).toBe("add retries to the http client\ncap them at three")
  })

  test("skips a synthetic message", () => {
    const content = SessionPrompt.titleInput([
      userMessage({ sessionID: "ses_test", text: "add retries to the http client" }),
      userMessage({ sessionID: "ses_test", text: "Pardon the interruption", synthetic: true }),
    ])
    expect(content).toBe("add retries to the http client")
  })

  test("keeps the tail when the conversation runs past the window", () => {
    const content = SessionPrompt.titleInput([
      userMessage({ sessionID: "ses_test", text: "x".repeat(1500) }),
      userMessage({ sessionID: "ses_test", text: "cap them at three" }),
    ])
    expect(content.length).toBe(1000)
    expect(content.endsWith("cap them at three")).toBe(true)
  })
})

describe("session title placeholder", () => {
  test("takes the first line of the prompt", () => {
    expect(SessionPrompt.derivePlaceholder("add retries to the http client\nand cap them")).toBe(
      "add retries to the http client",
    )
  })

  test("cuts a long prompt at a word boundary", () => {
    const placeholder = SessionPrompt.derivePlaceholder(
      "add retries to the http client so that transient upstream failures do not surface",
    )
    expect(placeholder).toBe("add retries to the http client so that transient")
  })

  test("skips a leading tag block", () => {
    expect(SessionPrompt.derivePlaceholder("<system-reminder>ignore me</system-reminder>\nfix the parser")).toBe(
      "fix the parser",
    )
  })

  test("has nothing to show for an empty prompt", () => {
    expect(SessionPrompt.derivePlaceholder("   \n\n  ")).toBeUndefined()
  })
})

describe("session title trigger", () => {
  function session(overrides: Partial<Session.Info> = {}): Session.Info {
    return {
      id: "ses_test",
      title: "New session - 2026-08-10T00:00:00.000Z",
      ...overrides,
    } as Session.Info
  }

  function history(ordinals: (number | undefined)[]) {
    return ordinals.map((ordinal) => {
      const msg = userMessage({ sessionID: "ses_test", text: `prompt ${ordinal}` })
      ;(msg.info as MessageV2.User).ordinal = ordinal
      return msg
    })
  }

  test("fires on the opening prompt", () => {
    expect(SessionPrompt.titleTrigger(session(), history([1]))).toBe(1)
  })

  test("stays quiet on the second prompt", () => {
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 1 }), history([1, 2]))).toBeUndefined()
  })

  test("fires again on the third prompt", () => {
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 1 }), history([1, 2, 3]))).toBe(3)
  })

  test("stays quiet on every prompt after the third", () => {
    for (const ordinal of [4, 5, 12]) {
      expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 3 }), history([ordinal]))).toBeUndefined()
    }
  })

  test("stays quiet when the loop re-enters on an ordinal it already generated at", () => {
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 3 }), history([3]))).toBeUndefined()
  })

  test("stays quiet when a stopped session resumes past the third prompt", () => {
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 3 }), history([1, 2, 3, 4]))).toBeUndefined()
  })

  test("stays quiet when compaction leaves only a late prompt visible", () => {
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 3 }), history([7]))).toBeUndefined()
  })

  test("stays quiet once the user has renamed the session", () => {
    const renamed = session({ title: "My name", titleGenerated: "Generated name" })
    expect(SessionPrompt.titleTrigger(renamed, history([3]))).toBeUndefined()
  })

  test("stays quiet on a session renamed before anything was generated", () => {
    expect(SessionPrompt.titleTrigger(session({ title: "My name" }), history([1]))).toBeUndefined()
  })

  test("stays quiet on a session titled before the counter existed", () => {
    const legacy = session({ title: "Fix login button on mobile" })
    expect(SessionPrompt.titleTrigger(legacy, history([1, 2, 3]))).toBeUndefined()
  })

  test("stays quiet on a fork", () => {
    const fork = session({ title: "Fix login button on mobile (fork #1)" })
    expect(SessionPrompt.titleTrigger(fork, history([1]))).toBeUndefined()
  })

  test("replaces its own earlier title", () => {
    const generated = session({ title: "Generated name", titleGenerated: "Generated name", titleOrdinal: 1 })
    expect(SessionPrompt.titleTrigger(generated, history([3]))).toBe(3)
  })

  test("stays quiet on a subagent session", () => {
    expect(SessionPrompt.titleTrigger(session({ parentID: "ses_parent" }), history([1]))).toBeUndefined()
  })

  test("stays quiet when the newest message is the supervisor resuming", () => {
    const resumed = [
      ...history([1]),
      userMessage({ sessionID: "ses_test", text: "Pardon the interruption", synthetic: true }),
    ]
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 1 }), resumed)).toBeUndefined()
  })

  test("stays quiet when no prompt carries an ordinal", () => {
    expect(SessionPrompt.titleTrigger(session(), history([undefined]))).toBeUndefined()
  })

  test("still fires when a plan-switch (ordinal-less) message trails the opening prompt", () => {
    // plan_enter/plan_exit mint a human-typed user message with no ordinal. It
    // must not intercept the trigger and suppress the title on the switch turn.
    expect(SessionPrompt.titleTrigger(session(), history([1, undefined]))).toBe(1)
  })

  test("still fires at the third prompt across an intervening plan switch", () => {
    expect(SessionPrompt.titleTrigger(session({ titleOrdinal: 1 }), history([1, 2, undefined, 3]))).toBe(3)
  })
})

describe("session prompt ordinal", () => {
  test("counts a real prompt and skips a synthetic one", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const first = await SessionPrompt.prompt({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "add retries to the http client" }],
        })
        if (first.info.role !== "user") throw new Error("expected user message")
        expect(first.info.ordinal).toBe(1)
        expect(first.info.synthetic).toBeUndefined()

        const resume = await SessionPrompt.prompt({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Pardon the interruption", synthetic: true }],
        })
        if (resume.info.role !== "user") throw new Error("expected user message")
        expect(resume.info.synthetic).toBe(true)
        expect(resume.info.ordinal).toBeUndefined()

        const second = await SessionPrompt.prompt({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "cap them at three" }],
        })
        if (second.info.role !== "user") throw new Error("expected user message")
        expect(second.info.ordinal).toBe(2)

        expect(await Session.get(session.id).then((s) => s.prompts)).toBe(2)
      },
    })
  })

  test("keeps counting across a session reload", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        for (const text of ["one", "two", "three"]) {
          await SessionPrompt.prompt({
            model: Provider.DEFAULT,
            variant: Provider.DEFAULT,
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "text", text }],
          })
        }
        expect(await Session.get(session.id).then((s) => s.prompts)).toBe(3)
      },
    })
  })

  test("shows the first prompt as a placeholder instead of the default title", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        expect(Session.isDefaultTitle(session.title)).toBe(true)

        await SessionPrompt.prompt({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "add retries to the http client" }],
        })

        const updated = await Session.get(session.id)
        expect(updated.title).toBe("add retries to the http client")
        expect(updated.titleGenerated).toBe("add retries to the http client")
      },
    })
  })

  test("leaves a session created with a title alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Named up front" })
        await SessionPrompt.prompt({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "add retries to the http client" }],
        })
        expect(await Session.get(session.id).then((s) => s.title)).toBe("Named up front")
      },
    })
  })
})

describe("session rename", () => {
  const projectRoot = path.join(__dirname, "../..")

  async function rename(sessionID: string, title: string) {
    const app = Server.App()
    const response = await app.request(`/session/${sessionID}?directory=${encodeURIComponent(projectRoot)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as Session.Info
  }

  test("leaves titleGenerated behind so the generator no longer owns the title", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.title = "Generated name"
          draft.titleGenerated = "Generated name"
        })

        const renamed = await rename(session.id, "My name")
        expect(renamed.title).toBe("My name")
        expect(renamed.titleGenerated).toBe("Generated name")

        await Session.remove(session.id)
      },
    })
  })

  test("survives a rename made before anything was generated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        expect(Session.isDefaultTitle(session.title)).toBe(true)

        const renamed = await rename(session.id, "My name")
        expect(renamed.title).toBe("My name")
        expect(renamed.titleGenerated).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })

  test("keeps the user's name across a second rename", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        await rename(session.id, "First name")
        const second = await rename(session.id, "Second name")
        expect(second.title).toBe("Second name")
        expect(second.titleGenerated).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })
})
