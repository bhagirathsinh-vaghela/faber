import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

// A failed first send leaves the draft in the composer, and a retry of it must
// go to a session that still exists.
test("a retry after a failed first send reaches a live session", async ({ page, sdk, gotoSession }) => {
  await gotoSession()

  const failing = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ name: "BadRequest" }) })
  await page.route("**/prompt_async**", failing)

  const text = `e2e failed first send ${Date.now()}`
  await page.locator(promptSelector).click()
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
  await expect(page.locator(promptSelector)).toHaveText(text)
  await page.unroute("**/prompt_async**", failing)

  const targets: string[] = []
  await page.route("**/prompt_async**", async (route) => {
    targets.push(new URL(route.request().url()).pathname.split("/")[2])
    await route.fulfill({ status: 204 })
  })
  await page.locator(promptSelector).click()
  await page.keyboard.press("Enter")
  await expect.poll(() => targets.length).toBe(1)
  const live = await sdk.session.get({ sessionID: targets[0] }).then((x) => x.data?.id)
  expect(live).toBe(targets[0])
  await sdk.session.delete({ sessionID: targets[0] })
})
