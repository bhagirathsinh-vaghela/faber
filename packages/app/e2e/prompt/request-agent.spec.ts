import { test, expect } from "../fixtures"
import { defocus, withSession } from "../actions"
import { modelTriggerSelector, promptSelector } from "../selectors"
import type { Page } from "@playwright/test"
import { visibleAgents } from "./dock"
import { modKey, type createSdk } from "../utils"

type Sdk = ReturnType<typeof createSdk>

const picker = '[data-action="agent-picker"]'
const dot = `${picker} [data-slot="pending"]`

// Writes a message as `agent` without a turn, so the session's record runs it.
const runs = async (sdk: Sdk, id: string, agent: string) => {
  await sdk.session.promptAsync({ sessionID: id, noReply: true, agent, parts: [{ type: "text", text: `as ${agent}` }] })
  await expect.poll(async () => (await sdk.session.get({ sessionID: id })).data?.current?.agent).toBe(agent)
}

const capture = async (page: Page) => {
  const bodies: Record<string, unknown>[] = []
  await page.route("**/prompt_async**", async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 204 })
  })
  return { bodies }
}

const spent = async (page: Page) => Number(await page.locator(modelTriggerSelector).getAttribute("data-spent"))

// Sends `text` and waits for the request and for the send's spend to run.
const send = async (page: Page, bodies: Record<string, unknown>[], text: string) => {
  const before = await spent(page)
  const count = bodies.length
  await page.locator(promptSelector).click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
  await expect.poll(() => bodies.length).toBe(count + 1)
  await expect(page.locator(modelTriggerSelector)).toHaveAttribute("data-spent", String(before + 1))
  return bodies[count]
}

const cycle = async (page: Page) => {
  await defocus(page)
  await page.keyboard.press(`${modKey}+.`)
}

test("a prompt names an agent only after the picker changed it", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to pick")
  await withSession(sdk, `e2e request agent ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    const { bodies } = await capture(page)
    await gotoSession(session.id)
    await expect(page.locator(picker)).toContainText(agents[0].name)

    expect((await send(page, bodies, "no pick")).agent).toBeUndefined()
    await expect(page.locator(dot)).toHaveCount(0)

    await cycle(page)
    await expect(page.locator(picker)).toContainText(agents[1].name)
    await expect(page.locator(dot)).toHaveCount(1)
    // The captured send above holds the session busy in this tab until the
    // server says otherwise, and a send while busy joins, keeping the pick.
    // Reloading reads the server's idle state (and drops the pick, so re-pick).
    await page.reload()
    await expect(page.locator(picker)).toContainText(agents[0].name)
    await cycle(page)
    await expect(page.locator(dot)).toHaveCount(1)
    expect((await send(page, bodies, "after a pick")).agent).toBe(agents[1].name)

    // The captured send never reached the server, so the session still runs the
    // first agent; the spent pick leaves the chip following it.
    await expect(page.locator(picker)).toContainText(agents[0].name)
    await expect(page.locator(dot)).toHaveCount(0)
    expect((await send(page, bodies, "after the pick was spent")).agent).toBeUndefined()
  })
})

test("an untouched agent chip follows the session when it switches", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to switch to")
  await withSession(sdk, `e2e agent follows ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    const { bodies } = await capture(page)
    await gotoSession(session.id)
    await expect(page.locator(picker)).toContainText(agents[0].name)

    await runs(sdk, session.id, agents[1].name)
    await expect(page.locator(picker)).toContainText(agents[1].name)
    await expect(page.locator(dot)).toHaveCount(0)
    expect((await send(page, bodies, "after the switch")).agent).toBeUndefined()
  })
})

test("choosing the agent the session runs is no pick", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to switch to")
  await withSession(sdk, `e2e agent same pick ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    await gotoSession(session.id)
    await cycle(page)
    await expect(page.locator(dot)).toHaveCount(1)
    await defocus(page)
    await page.keyboard.press(`Shift+${modKey}+.`)
    await expect(page.locator(picker)).toContainText(agents[0].name)
    await expect(page.locator(dot)).toHaveCount(0)

    await runs(sdk, session.id, agents[1].name)
    await expect(page.locator(picker)).toContainText(agents[1].name)
    await expect(page.locator(dot)).toHaveCount(0)
  })
})

// The busy indicators, the permission ring and the question panel belong to the
// turn, so they take the colour of the agent the session runs, never of a pick
// that has not been sent.
test("the session's tint follows the agent it runs, not an unsent pick", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to pick")
  await withSession(sdk, `e2e agent tint ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    await gotoSession(session.id)
    const tint = () =>
      page
        .locator('[style*="--permission-accent"]')
        .first()
        .evaluate((el) => (el as HTMLElement).style.getPropertyValue("--permission-accent"))
    await expect(page.locator(picker)).toContainText(agents[0].name)
    const before = await tint()

    await cycle(page)
    await expect(page.locator(dot)).toHaveCount(1)
    expect(await tint()).toBe(before)

    await runs(sdk, session.id, agents[1].name)
    await expect.poll(tint).not.toBe(before)
  })
})

// A slash command with no agent of its own runs on the picked agent, so an idle
// one spends the pick like a prompt does; left behind, the pick would return
// with a dot once the session's agent moves, and switch it back.
test("an idle slash command spends the agent pick it carried", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to pick")
  await withSession(sdk, `e2e agent command ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    const bodies: Record<string, unknown>[] = []
    await page.route(`**/session/${session.id}/command*`, async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: {} })
    })
    await gotoSession(session.id)

    await cycle(page)
    await expect(page.locator(dot)).toHaveCount(1)
    await page.locator(promptSelector).click()
    await page.keyboard.type("/spellcheck now")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].command).toBe("spellcheck")
    expect(bodies[0].agent).toBe(agents[1].name)

    await expect(page.locator(picker)).toContainText(agents[0].name)
    await expect(page.locator(dot)).toHaveCount(0)
  })
})

// A send into a running turn joins it and runs on that turn's values, so the
// pick it carried is not spent: the dot stays and the next send names it again.
test("a pick sent into a running turn stays pending", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to pick")
  await withSession(sdk, `e2e agent joins ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    const { bodies } = await capture(page)
    await gotoSession(session.id)

    // A real turn on the server, so the session reads busy to every client. It
    // outlasts any load on the machine and is stopped once the checks are done.
    const turn = sdk.session.shell({ sessionID: session.id, command: "sleep 120" })
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

    await cycle(page)
    await expect(page.locator(dot)).toHaveCount(1)
    expect((await send(page, bodies, "joins the turn")).agent).toBe(agents[1].name)
    await expect(page.locator(picker)).toContainText(agents[1].name)
    await expect(page.locator(dot)).toHaveCount(1)
    await sdk.session.abortTurn({ sessionID: session.id })
    await turn
  })
})

// Each client keeps its own picks: an untouched tab follows the session, a tab
// with a pick keeps it and its dot until it sends.
test("two tabs: the untouched one follows, the picked one keeps its pick", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to pick")
  await withSession(sdk, `e2e agent two tabs ${Date.now()}`, async (session) => {
    await runs(sdk, session.id, agents[0].name)
    await gotoSession(session.id)
    const other = await page.context().newPage()
    try {
      await other.goto(page.url())
      await expect(other.locator(picker)).toContainText(agents[0].name)
      await cycle(other)
      await expect(other.locator(dot)).toHaveCount(1)

      await runs(sdk, session.id, agents[1].name)
      await expect(page.locator(picker)).toContainText(agents[1].name)
      await expect(page.locator(dot)).toHaveCount(0)
      await expect(other.locator(picker)).toContainText(agents[1].name)
      await expect(other.locator(dot)).toHaveCount(0)

      await runs(sdk, session.id, agents[0].name)
      await expect(page.locator(picker)).toContainText(agents[0].name)
      await expect(page.locator(dot)).toHaveCount(0)
      await expect(other.locator(picker)).toContainText(agents[1].name)
      await expect(other.locator(dot)).toHaveCount(1)
    } finally {
      await other.close()
    }
  })
})
