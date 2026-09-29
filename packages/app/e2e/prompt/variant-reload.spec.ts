import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { modelVariantSelector, promptSelector } from "../selectors"

// A session running a non-default variant keeps it across a reload: the dock
// shows what the session last ran, and a plain send still names nothing.
test("a reload keeps the session's non-default variant", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e variant reload ${Date.now()}`, async (session) => {
    const seed = async (variant?: string) => {
      await sdk.session.promptAsync({
        sessionID: session.id,
        noReply: true,
        ...(variant && { variant }),
        parts: [{ type: "text", text: "seed" }],
      })
      await expect
        .poll(async () => {
          const messages = (await sdk.session.messages({ sessionID: session.id }).then((r) => r.data ?? [])).filter(
            (m) => m.info.role === "user",
          )
          return messages.length
        })
        .toBeGreaterThan(variant ? 1 : 0)
      const last = (await sdk.session.messages({ sessionID: session.id }).then((r) => r.data ?? []))
        .filter((m) => m.info.role === "user")
        .at(-1)!.info
      return last.role === "user" ? last : undefined
    }

    const first = (await seed())!
    const providers = (await sdk.provider.list().then((r) => r.data))!
    const resolved = (await sdk.provider.default()).data
    const model = providers.all.find((p) => p.id === first.model.providerID)?.models[first.model.modelID]
    // Differs from the configured variant too, so reverting to the default
    // on reload cannot pass.
    const other = Object.keys(model?.variants ?? {}).find(
      (name) => name !== first.variant && name !== model?.variant && name !== resolved?.variant,
    )
    test.skip(!other, "the session's model offers no second variant")
    const second = (await seed(other))!
    expect(second.variant).toBe(other)

    const bodies: Record<string, unknown>[] = []
    await page.route("**/prompt_async**", async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 204 })
    })
    await gotoSession(session.id)
    const dock = page.locator(modelVariantSelector)
    await expect.poll(async () => (await dock.textContent())?.trim()).toBe(other)

    await page.reload()
    await expect.poll(async () => (await dock.textContent())?.trim()).toBe(other)

    await page.locator(promptSelector).click()
    await page.keyboard.type("after reload")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBeGreaterThan(0)
    expect(bodies[0].variant).toBeUndefined()
    expect(bodies[0].model).toBeUndefined()
  })
})
