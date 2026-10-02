import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { PlanEnterTool, PlanExitTool } from "../../src/tool/plan"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const tools = [
  { name: "plan_exit", tool: PlanExitTool, from: "plan", to: "build", stay: "Staying in plan mode" },
  { name: "plan_enter", tool: PlanEnterTool, from: "build", to: "plan", stay: "Staying in build mode" },
]

describe("plan_exit / plan_enter answers", () => {
  let ask: ReturnType<typeof spyOn>
  let deliver: ReturnType<typeof spyOn>

  beforeEach(() => {
    ask = spyOn(Question, "ask")
    deliver = spyOn(SessionPrompt, "deliver").mockImplementation(async () => undefined as never)
  })

  afterEach(() => {
    ask.mockRestore()
    deliver.mockRestore()
  })

  async function run(entry: (typeof tools)[number], answers: string[][]) {
    await using project = await tmpdir({ git: true })
    return await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => void (draft.current = { agent: entry.from }), { touch: false })
        ask.mockResolvedValueOnce(answers)
        const tool = await entry.tool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "msg_test",
          callID: "call_test",
          agent: entry.from,
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const outcome = await tool.execute({}, ctx).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        )
        const after = await Session.get(session.id)
        await Session.remove(session.id)
        return { ...outcome, agent: after.current?.agent }
      },
    })
  }

  for (const entry of tools) {
    test(`${entry.name} offers a typed answer`, async () => {
      await run(entry, [["Yes"]])
      const question = ask.mock.calls[0][0].questions[0]
      expect(question.custom).toBeUndefined()
      expect(question.options.map((option: { label: string }) => option.label)).toEqual(["Yes", "No"])
    })

    test(`${entry.name} Yes switches to ${entry.to}`, async () => {
      const outcome = await run(entry, [["Yes"]])
      expect(outcome.error).toBeUndefined()
      expect(outcome.agent).toBe(entry.to)
      expect(deliver).toHaveBeenCalledTimes(1)
    })

    test(`${entry.name} No dismisses and stays in ${entry.from}`, async () => {
      const outcome = await run(entry, [["No"]])
      expect(outcome.error).toBeInstanceOf(Question.RejectedError)
      expect(outcome.agent).toBe(entry.from)
      expect(deliver).toHaveBeenCalledTimes(0)
    })

    test(`${entry.name} typed text stays in ${entry.from} and hands the text back`, async () => {
      const outcome = await run(entry, [["Add a rollback step first"]])
      expect(outcome.error).toBeUndefined()
      expect(outcome.agent).toBe(entry.from)
      expect(deliver).toHaveBeenCalledTimes(0)
      expect(outcome.value?.title).toBe(entry.stay)
      expect(outcome.value?.output).toContain("Add a rollback step first")
    })

    test(`${entry.name} an empty answer does not switch`, async () => {
      const outcome = await run(entry, [[]])
      expect(outcome.agent).toBe(entry.from)
      expect(deliver).toHaveBeenCalledTimes(0)
    })
  }
})
