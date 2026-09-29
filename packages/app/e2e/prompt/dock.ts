import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import { listItemSelector, modelTriggerSelector, selectContentSelector } from "../selectors"
import type { createSdk } from "../utils"

type Sdk = ReturnType<typeof createSdk>

// The Select content plays a 0.15s scale entrance (`select-open` in select.css)
// and Kobalte's popper re-places the listbox after mount, so an option's node can
// be re-inserted under a click and detach it — the "element is not stable" then
// detached failures. The entrance is irrelevant to this suite, so it is zeroed
// once per page to shrink that window.
const frozen = new WeakSet<Page>()
const freezeSelectAnimation = async (page: Page) => {
  if (frozen.has(page)) return
  await page.addStyleTag({
    content: `${selectContentSelector}[data-expanded] { animation: none !important; }`,
  })
  frozen.add(page)
}

// Opens the Select whose trigger is `trigger` and waits for its content, with
// the entrance animation frozen so a following option click cannot race it. The
// click is retried until the content appears: a single click can be swallowed
// when it lands during a dock re-render or before the Select has mounted.
export const openSelect = async (page: Page, trigger: Locator) => {
  await freezeSelectAnimation(page)
  const content = page.locator(selectContentSelector)
  if (await content.isVisible()) return
  await expect(async () => {
    await trigger.click({ timeout: 2000 })
    await expect(content).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20000 })
}

// Opens the Select and clicks the option. Freezing the entrance still leaves a
// post-mount listbox re-placement that can detach the option mid-click, so the
// open+click is retried as a unit: a detach reopens and clicks the fresh node,
// and the click is confirmed by the content closing.
export const chooseOption = async (page: Page, trigger: Locator, option: Locator) => {
  const content = page.locator(selectContentSelector)
  await expect(async () => {
    await openSelect(page, trigger)
    await option.click({ timeout: 2000 })
    await expect(content).toBeHidden({ timeout: 2000 })
  }).toPass({ timeout: 20000 })
}

// The variant labels a Select lists other than `before` and "default", read by
// opening the dropdown and closing it again — so a caller chooses among them
// without holding it open across the listbox re-placement that detaches nodes.
// Returns undefined when fewer than `least` such labels exist.
export const namedVariants = async (page: Page, trigger: Locator, before: string, least = 1) => {
  await openSelect(page, trigger)
  const labels = await page
    .getByRole("option")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""))
  await page.keyboard.press("Escape")
  await expect(page.locator(selectContentSelector)).toBeHidden()
  const skip = new RegExp(`^(${before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|default)$`, "i")
  const named = labels.filter((label) => label && !skip.test(label))
  return named.length >= least ? named : undefined
}

// The keys ("provider:model") the model picker lists, read by opening it. A
// model the picker hides has no dock, whatever the server's default says.
export const listedKeys = async (page: Page) => {
  await page.locator(modelTriggerSelector).click()
  await expect(page.locator(listItemSelector).first()).toBeVisible()
  const keys = await page
    .locator(listItemSelector)
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-key") ?? ""))
  await page.keyboard.press("Escape")
  return keys
}

// The agents the app offers, in its own order: primary and not hidden.
export const visibleAgents = async (sdk: Sdk) => {
  const agents = await sdk.app.agents().then((r) => r.data ?? [])
  return agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
}

// The agent a new session starts on, which is the first of those. The server's
// default agent can be another.
export const uiAgent = async (sdk: Sdk) => (await visibleAgents(sdk))[0]?.name
