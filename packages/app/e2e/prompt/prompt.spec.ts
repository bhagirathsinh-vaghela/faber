import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { sessionIDFromUrl, withSession } from "../actions"

test("can send a prompt and receive a reply", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(120_000)

  const pageErrors: string[] = []
  const onPageError = (err: Error) => {
    pageErrors.push(err.message)
  }
  page.on("pageerror", onPageError)

  await gotoSession()

  const token = `E2E_OK_${Date.now()}`

  const prompt = page.locator(promptSelector)
  await prompt.click()
  // Belt-and-braces phrasing: the sandbox project is the repo root, so the turn
  // carries whatever instruction files sit there (e.g. a local AGENTS.md), and
  // a small model greeting those instructions instead of obeying a bare
  // one-liner is a real failure mode. The spec verifies the
  // round-trip, not instruction-following subtlety.
  await page.keyboard.type(`Reply with only this exact text and nothing else, no tools, no greeting: ${token}`)
  await page.keyboard.press("Enter")

  await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })

  const sessionID = (() => {
    const id = sessionIDFromUrl(page.url())
    if (!id) throw new Error(`Failed to parse session id from url: ${page.url()}`)
    return id
  })()

  try {
    await expect
      .poll(
        async () => {
          const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((r) => r.data ?? [])
          const assistant = messages.filter((m) => m.info.role === "assistant")

          // A provider failure (quota, auth, network) never yields the token,
          // so waiting out the whole poll only obscures it. Surface it now.
          const failure = assistant
            .map((m) => (m.info.role === "assistant" ? m.info.error : undefined))
            .find((e) => e !== undefined)
          if (failure) throw new Error(`Assistant turn failed: ${JSON.stringify(failure)}`)

          return assistant
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        },
        { timeout: 90_000 },
      )

      .toContain(token)

    // Response text renders inline in the turn's steps; the summary section
    // is the changed-files list and only mounts when the turn produced diffs,
    // which a text-only reply never does. Scoped to the assistant message box:
    // the typed prompt also contains the token, so an unscoped getByText is
    // satisfied by the user bubble even when the reply never renders.
    await expect(
      page
        .locator('[data-component="message-box"][data-role="assistant"]')
        .getByText(token)
        .filter({ visible: true })
        .first(),
    ).toBeVisible({ timeout: 90_000 })
  } finally {
    page.off("pageerror", onPageError)
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }

  if (pageErrors.length > 0) {
    throw new Error(`Page error(s):\n${pageErrors.join("\n")}`)
  }
})
