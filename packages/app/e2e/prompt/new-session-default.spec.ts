import { test, expect } from "../fixtures"
import { defocus, withSession } from "../actions"
import { modelVariantSelector, promptSelector } from "../selectors"
import { modKey } from "../utils"
import { listedKeys, uiAgent } from "./dock"

// The dock renders `common.default` for no variant.
const label = (variant?: string) => variant ?? "Default"

// The new-session surface renders the server's resolution and sends nothing
// the tab did not pick, so the server alone decides what the first turn runs.
test("a plain first send from a new session carries no model or variant", async ({ page, sdk, gotoSession }) => {
  const resolved = (await sdk.provider.default()).data
  test.skip(!resolved, "no provider connected")
  // The app trusts the server's variant only for the agent the server resolved it
  // for, so the label below is the server's only when the app starts on that agent.
  test.skip((await uiAgent(sdk)) !== resolved!.agent, "the app starts on another agent than the server default")
  const providers = (await sdk.provider.list().then((r) => r.data))!
  const model = providers.all.find((p) => p.id === resolved!.providerID)?.models[resolved!.modelID]
  test.skip(Object.keys(model?.variants ?? {}).length === 0, "the default model offers no variants, so no dock")

  const bodies: Record<string, unknown>[] = []
  await page.route("**/prompt_async**", async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 204 })
  })
  await gotoSession()
  const shown = await listedKeys(page)
  test.skip(
    !shown.includes(`${resolved!.providerID}:${resolved!.modelID}`),
    "the default model is hidden from the picker",
  )

  const dock = page.locator(modelVariantSelector)
  await expect(dock).toBeVisible()
  await expect.poll(async () => (await dock.textContent())?.trim()).toBe(label(resolved!.variant))

  await page.locator(promptSelector).click()
  await page.keyboard.type(`e2e new session default ${Date.now()}`)
  await page.keyboard.press("Enter")
  await expect.poll(() => bodies.length).toBeGreaterThan(0)
  expect(bodies[0].model).toBeUndefined()
  expect(bodies[0].variant).toBeUndefined()
})

// Each visit to the new-session surface re-reads the server's resolution, so a
// changed default shows without a reload.
test("the new-session dock follows a changed server default", async ({ page, sdk, gotoSession }) => {
  const resolved = (await sdk.provider.default()).data
  test.skip(!resolved, "no provider connected")
  const agent = await uiAgent(sdk)
  test.skip(agent !== resolved!.agent, "the app starts on another agent than the server default")
  const providers = (await sdk.provider.list().then((r) => r.data))!
  const model = providers.all.find((p) => p.id === resolved!.providerID)?.models[resolved!.modelID]
  const other = Object.keys(model?.variants ?? {}).find((name) => name !== resolved!.variant)
  test.skip(!other, "the default model offers no second variant")

  await gotoSession()
  const shown = await listedKeys(page)
  test.skip(
    !shown.includes(`${resolved!.providerID}:${resolved!.modelID}`),
    "the default model is hidden from the picker",
  )
  const dock = page.locator(modelVariantSelector)
  await expect(dock).toBeVisible()
  await expect.poll(async () => (await dock.textContent())?.trim()).toBe(label(resolved!.variant))

  await withSession(sdk, `e2e new session default revisit ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    await expect(page.locator(promptSelector)).toBeVisible()
    // Changed only after the last reload, and left by in-app navigation, so
    // only the new-session refetch can deliver it.
    await page.route("**/provider/default**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...resolved, agent, variant: other }),
      }),
    )
    const refetch = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/provider/default"))
    await defocus(page)
    await page.keyboard.press(`${modKey}+Shift+S`)
    await expect(page).toHaveURL(/\/session$/)
    await refetch
  })
  await expect(dock).toBeVisible()
  await expect.poll(async () => (await dock.textContent())?.trim()).toBe(other)
})
