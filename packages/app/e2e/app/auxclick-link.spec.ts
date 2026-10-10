import { test, expect } from "../fixtures"

// A middle click on a link opens it in a new tab unless auxclick is cancelled:
// https://developer.mozilla.org/en-US/docs/Web/API/Element/auxclick_event
test("a middle click on a link is left to the browser", async ({ page, gotoSession }) => {
  await gotoSession()
  const prevented = await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "https://example.com/"
    link.textContent = "link"
    document.body.append(link)
    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    link.remove()
    return event.defaultPrevented
  })
  expect(prevented).toBe(false)
})
