import { test, expect } from "../fixtures"
import { defocus, withSession } from "../actions"
import { listItemSelector, modelTriggerSelector, modelVariantSelector, promptSelector } from "../selectors"
import type { Locator, Page } from "@playwright/test"
import { chooseOption, listedKeys, namedVariants, uiAgent, visibleAgents } from "./dock"
import { modKey, type createSdk } from "../utils"

type Sdk = ReturnType<typeof createSdk>

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const seeded = async (sdk: Sdk, id: string) => {
  await sdk.session.promptAsync({ sessionID: id, noReply: true, parts: [{ type: "text", text: "seed" }] })
  await expect
    .poll(async () => (await sdk.session.messages({ sessionID: id, limit: 1 }).then((r) => r.data ?? [])).length)
    .toBeGreaterThan(0)
}

const capture = async (page: Page, pattern: string) => {
  const bodies: Record<string, unknown>[] = []
  await page.route(pattern, async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 204 })
  })
  return bodies
}

// The dock trigger counts the sends whose spend has run. A test that sends
// again, or reads state a spend changes, waits on it: frames, timers and the
// response event do not order against the `.then` that spends.
const spentCount = async (page: Page) => Number(await page.locator(modelTriggerSelector).getAttribute("data-spent"))
const spentTo = (page: Page, count: number) =>
  expect(page.locator(modelTriggerSelector)).toHaveAttribute("data-spent", String(count))

// Releases a held send and waits until its spend has run.
const settle = async (page: Page, release: () => void) => {
  const before = await spentCount(page)
  release()
  await spentTo(page, before + 1)
}

// A prompt into an open session names a model or variant only when the picker
// was changed; otherwise the server keeps the session's own, so a picker value
// that drifted with no pick can never change a turn.
test("a prompt carries a model or variant only after the picker changed it", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request model ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const bodies = await capture(page, "**/prompt_async**")
    await gotoSession(session.id)

    // A captured send never reaches the server, but this tab holds the session
    // busy until the server says otherwise, and a send while busy joins the
    // turn and keeps its picks. Reloading reads the server's idle state.
    const idle = async () => {
      await page.reload()
      await expect(page.locator(promptSelector)).toBeVisible()
    }
    const send = async (text: string) => {
      const spent = await spentCount(page)
      await page.locator(promptSelector).click()
      await page.keyboard.type(text)
      await page.keyboard.press("Enter")
      await expect.poll(() => bodies.length).toBeGreaterThan(0)
      const body = bodies.splice(0)[0]
      await spentTo(page, spent + 1)
      return body
    }

    const plain = await send("no pick")
    expect(plain.model).toBeUndefined()
    expect(plain.variant).toBeUndefined()
    await idle()

    const dock = page.locator(modelVariantSelector)
    test.skip((await dock.count()) === 0, "current model has no variants")
    const label = async () => (await dock.textContent())?.trim() ?? ""
    const before = await label()
    const choose = async (name: RegExp) =>
      chooseOption(page, dock.getByRole("button").first(), page.getByRole("option").filter({ hasText: name }).first())

    const trigger = dock.getByRole("button").first()
    const others = await namedVariants(page, trigger, before)
    test.skip(!others, "current model offers no other named variant")
    const name = others!.at(-1)!
    await chooseOption(
      page,
      trigger,
      page
        .getByRole("option")
        .filter({ hasText: new RegExp(`^${escape(name)}$`) })
        .first(),
    )
    await expect.poll(label).toBe(name)
    const named = await send("after a named pick")
    expect(named.variant).toBe(name)

    // The idle send spent the pick, so the dock is back on what the session
    // runs; pick the named variant again, then Default over it.
    await expect.poll(label).toBe(before)
    await idle()
    await choose(new RegExp(`^${escape(name)}$`))
    await expect.poll(label).toBe(name)
    await choose(/^default$/i)
    await expect.poll(label).toMatch(/^default$/i)
    const reset = await send("after picking default")
    // Picking Default when the session already runs the default variant is no
    // change. The captured sends never reached the server, so the session still
    // runs what the seed resolved; the seed ran the server default model.
    const runs = (await sdk.session.get({ sessionID: session.id }).then((r) => r.data))?.current?.variant
    const base = (await sdk.provider.default()).data?.variant
    expect(reset.variant).toBe((runs ?? base) === base ? undefined : "default")
  })
})

// "Default" over a session that runs a named variant is a real pick: it shows
// the dot and rides on the next prompt as "default".
test("choosing Default over a session's named variant is a pick", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request default variant ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const runs = async () => (await sdk.session.get({ sessionID: session.id })).data?.current
    await expect.poll(async () => !!(await runs())?.model).toBe(true)
    const key = (await runs())!.model!
    const providers = (await sdk.provider.list().then((r) => r.data))!
    const info = providers.all.find((p) => p.id === key.providerID)?.models[key.modelID]
    const named = Object.keys(info?.variants ?? {}).find((name) => name !== info?.variant)
    test.skip(!named, "the seeded model offers no named variant other than its default")
    await sdk.session.promptAsync({
      sessionID: session.id,
      noReply: true,
      variant: named,
      parts: [{ type: "text", text: "on a named variant" }],
    })
    await expect.poll(async () => (await runs())?.variant).toBe(named)
    const bodies = await capture(page, "**/prompt_async**")
    await gotoSession(session.id)

    const dock = page.locator(modelVariantSelector)
    test.skip((await dock.count()) === 0, "the variant dock is hidden")
    await expect.poll(async () => (await dock.textContent())?.trim()).toBe(named)
    await chooseOption(
      page,
      dock.getByRole("button").first(),
      page
        .getByRole("option")
        .filter({ hasText: /^default$/i })
        .first(),
    )
    await expect(dock.locator('[data-slot="pending"]')).toHaveCount(1)

    await page.locator(promptSelector).click()
    await page.keyboard.type("after picking default")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].variant).toBe("default")
  })
})

// Shell mode obeys the same rule: a plain `!cmd` names no model.
test("a plain shell command in an open session carries no model", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request shell ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const bodies = await capture(page, `**/session/${session.id}/shell*`)
    await gotoSession(session.id)

    await page.locator(promptSelector).click()
    await page.keyboard.type("!")
    await page.keyboard.type("echo e2e")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBeGreaterThan(0)
    expect(bodies[0].command).toBe("echo e2e")
    expect(bodies[0].model).toBeUndefined()
  })
})

// A pick belongs to the send that carries it: a send the server rejected keeps
// it for the retry, and a send the server took spends it.
test("a failed send keeps the pick and a successful one spends it", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request spend ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const bodies: Record<string, unknown>[] = []
    const statuses = [400]
    await page.route("**/prompt_async**", async (route) => {
      bodies.push(route.request().postDataJSON())
      const status = statuses.shift() ?? 204
      await (status === 204 ? route.fulfill({ status }) : route.fulfill({ status, json: { name: "BadRequest" } }))
    })
    await gotoSession(session.id)

    // A refused send never spends. Its draft coming back is the sign the failure
    // has been handled, and only then can "no spend" be read.
    const send = async (text: string, refused = false) => {
      const spent = await spentCount(page)
      await page.locator(promptSelector).click()
      await page.keyboard.press("ControlOrMeta+a")
      await page.keyboard.type(text)
      await page.keyboard.press("Enter")
      await expect.poll(() => bodies.length).toBeGreaterThan(0)
      const body = bodies.splice(0)[0]
      if (!refused) await spentTo(page, spent + 1)
      else {
        await expect(page.locator(promptSelector)).toContainText(text)
        await spentTo(page, spent)
      }
      return body
    }

    const dock = page.locator(modelVariantSelector)
    test.skip((await dock.count()) === 0, "current model has no variants")
    const label = async () => (await dock.textContent())?.trim() ?? ""
    const before = await label()
    const trigger = dock.getByRole("button").first()
    const others = await namedVariants(page, trigger, before)
    test.skip(!others, "current model offers no other named variant")
    const name = others!.at(-1)!
    await chooseOption(
      page,
      trigger,
      page
        .getByRole("option")
        .filter({ hasText: new RegExp(`^${escape(name)}$`) })
        .first(),
    )
    await expect.poll(label).toBe(name)

    const rejected = await send("rejected", true)
    expect(rejected.variant).toBe(name)
    await expect.poll(label).toBe(name)

    const accepted = await send("accepted")
    expect(accepted.variant).toBe(name)

    const after = await send("after the pick was spent")
    expect(after.variant).toBeUndefined()
  })
})

// A send spends only the pick it carried: a pick made while it is in flight is
// a new pick and belongs to the next send.
test("a pick made while a send is in flight survives that send", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request inflight ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const bodies: Record<string, unknown>[] = []
    const held: (() => void)[] = []
    await page.route("**/prompt_async**", async (route) => {
      bodies.push(route.request().postDataJSON())
      if (bodies.length === 1) await new Promise<void>((resolve) => held.push(resolve))
      await route.fulfill({ status: 204 })
    })
    await gotoSession(session.id)

    const dock = page.locator(modelVariantSelector)
    test.skip((await dock.count()) === 0, "current model has no variants")
    const label = async () => (await dock.textContent())?.trim() ?? ""
    const before = await label()
    const trigger = dock.getByRole("button").first()
    const names = await namedVariants(page, trigger, before, 2)
    test.skip(!names, "current model offers fewer than two other named variants")
    const first = names![0]
    const second = names!.at(-1)!
    await chooseOption(
      page,
      trigger,
      page
        .getByRole("option")
        .filter({ hasText: new RegExp(`^${escape(first)}$`) })
        .first(),
    )
    await expect.poll(label).toBe(first)

    await page.locator(promptSelector).click()
    await page.keyboard.type("in flight")
    await page.keyboard.press("Enter")
    await expect.poll(() => held.length).toBe(1)
    expect(bodies[0].variant).toBe(first)

    await chooseOption(
      page,
      trigger,
      page
        .getByRole("option")
        .filter({ hasText: new RegExp(`^${escape(second)}$`) })
        .first(),
    )
    await expect.poll(label).toBe(second)
    await settle(page, held[0])
    await expect.poll(label).toBe(second)

    await page.locator(promptSelector).click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("next")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBe(2)
    expect(bodies[1].variant).toBe(second)
  })
})

// A shell send carries no variant, so it cannot spend a variant pick.
test("a shell send leaves a variant pick for the next prompt", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request shell pick ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const shells = await capture(page, `**/session/${session.id}/shell*`)
    const prompts = await capture(page, "**/prompt_async**")
    await gotoSession(session.id)

    const dock = page.locator(modelVariantSelector)
    test.skip((await dock.count()) === 0, "current model has no variants")
    const label = async () => (await dock.textContent())?.trim() ?? ""
    const before = await label()
    const trigger = dock.getByRole("button").first()
    const others = await namedVariants(page, trigger, before)
    test.skip(!others, "current model offers no other named variant")
    const name = others!.at(-1)!
    await chooseOption(
      page,
      trigger,
      page
        .getByRole("option")
        .filter({ hasText: new RegExp(`^${escape(name)}$`) })
        .first(),
    )
    await expect.poll(label).toBe(name)

    const spent = await spentCount(page)
    await page.locator(promptSelector).click()
    await page.keyboard.type("!")
    await page.keyboard.type("echo x")
    await page.keyboard.press("Enter")
    await expect.poll(() => shells.length).toBe(1)
    expect(shells[0].command).toBe("echo x")
    await spentTo(page, spent + 1)

    await page.locator(promptSelector).click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("after the shell")
    await page.keyboard.press("Enter")
    await expect.poll(() => prompts.length).toBe(1)
    expect(prompts[0].variant).toBe(name)
  })
})

const base = (name: string) => name.split(" (")[0]

type ModelKey = { providerID: string; modelID: string }

const keyOf = (model: ModelKey) => `${model.providerID}:${model.modelID}`

// The model the seeded session ran.
const seedModel = async (sdk: Sdk, id: string) => {
  const seed = (await sdk.session.messages({ sessionID: id, limit: 1 }).then((r) => r.data ?? []))[0]?.info
  return seed?.role === "user" ? seed.model : undefined
}

// A model's name as the dock trigger shows it, or undefined when unlisted.
const nameOf = async (sdk: Sdk, key: ModelKey) => {
  const providers = (await sdk.provider.list().then((r) => r.data))!
  const model = providers.all.find((p) => p.id === key.providerID)?.models[key.modelID]
  return model ? base(model.name) : undefined
}

const ran = async (sdk: Sdk, id: string) => {
  const key = await seedModel(sdk, id)
  return key ? nameOf(sdk, key) : undefined
}

// Picks the first listed model other than the dock's and any in `exclude`;
// returns its key, or undefined when the picker lists no other.
const pickModel = async (page: Page, exclude: string[] = []) => {
  await page.locator(modelTriggerSelector).click()
  await expect(page.locator(listItemSelector).first()).toBeVisible()
  const keys = await page
    .locator(`${listItemSelector}:not([data-selected="true"])`)
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-key") ?? ""))
  const key = keys.find((candidate) => !exclude.includes(candidate))
  if (!key) {
    await page.keyboard.press("Escape")
    return undefined
  }
  await page.locator(`${listItemSelector}[data-key="${key}"]`).click()
  const [providerID, ...rest] = key.split(":")
  return { providerID, modelID: rest.join(":") }
}

// A model pick rides on the next send only; the server keeps it from there.
test("a model pick rides on one prompt and is spent", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request model pick ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const name = await ran(sdk, session.id)
    test.skip(!name, "the seeded model is not listed")
    const bodies = await capture(page, "**/prompt_async**")
    await gotoSession(session.id)

    const send = async (text: string) => {
      const spent = await spentCount(page)
      await page.locator(promptSelector).click()
      await page.keyboard.press("ControlOrMeta+a")
      await page.keyboard.type(text)
      await page.keyboard.press("Enter")
      await expect.poll(() => bodies.length).toBeGreaterThan(0)
      const body = bodies.splice(0)[0]
      await spentTo(page, spent + 1)
      return body
    }

    const other = await pickModel(page)
    test.skip(!other, "the picker lists no other model")
    const picked = await send("after a model pick")
    expect(picked.model).toEqual(other)

    const after = await send("after the model pick was spent")
    expect(after.model).toBeUndefined()
  })
})

// A shell send carries the model pick, so it spends it too.
test("a shell send spends a model pick", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request shell model ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const name = await ran(sdk, session.id)
    test.skip(!name, "the seeded model is not listed")
    const shells = await capture(page, `**/session/${session.id}/shell*`)
    const prompts = await capture(page, "**/prompt_async**")
    await gotoSession(session.id)

    const other = await pickModel(page)
    test.skip(!other, "the picker lists no other model")
    const spent = await spentCount(page)
    await page.locator(promptSelector).click()
    await page.keyboard.type("!")
    await page.keyboard.type("echo x")
    await page.keyboard.press("Enter")
    await expect.poll(() => shells.length).toBe(1)
    expect(shells[0].model).toEqual(other)
    await spentTo(page, spent + 1)

    await page.locator(promptSelector).click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("after the shell")
    await page.keyboard.press("Enter")
    await expect.poll(() => prompts.length).toBe(1)
    expect(prompts[0].model).toBeUndefined()
  })
})

// A pick made while a send is in flight is not that send's to spend. The store
// merges a new pick into the node an earlier read still points at, so a held
// pick that is not copied out reads as the newer one and deletes it.
test("a model picked while a send is in flight is kept", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e request in flight ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const seed = await seedModel(sdk, session.id)
    test.skip(!seed || !(await nameOf(sdk, seed)), "the seeded model is not listed")
    const bodies: Record<string, unknown>[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let held = false
    await page.route("**/prompt_async**", async (route) => {
      bodies.push(route.request().postDataJSON())
      if (!held) {
        held = true
        await gate
      }
      await route.fulfill({ status: 204 })
    })
    await gotoSession(session.id)

    const first = await pickModel(page)
    test.skip(!first, "the picker lists no other model")
    await page.locator(promptSelector).click()
    await page.keyboard.type("sent and held in flight")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].model).toEqual(first)

    const second = await pickModel(page, [keyOf(seed!), keyOf(first!)])
    test.skip(!second, "the picker lists fewer than three models")
    const name = (await nameOf(sdk, second!))!
    await expect(page.locator(modelTriggerSelector)).toContainText(name)

    await settle(page, release)
    await expect(page.locator(modelTriggerSelector)).toContainText(name)
    await page.locator(promptSelector).click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("after the held send settled")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBe(2)
    expect(bodies[1].model).toEqual(second)
  })
})

// The server's own default may be hidden from the picker, so it is routed to a
// model the picker lists. Installed before a reload so the bootstrap reads it;
// `move` changes it for the next visit to the new-session surface. The body
// names the agent the app itself starts on, or the client would not trust its
// variant. `ownModel` also gives the second visible agent a configured model,
// for a test that cycles onto it.
const routeDefault = async (
  page: Page,
  sdk: Sdk,
  gotoSession: () => Promise<void>,
  wanted: (model: { variant?: string; variants?: Record<string, unknown> }) => boolean = () => true,
  options: { ownModel?: boolean } = {},
) => {
  const real = (await sdk.provider.default()).data
  test.skip(!real, "no provider connected")
  const agent = await uiAgent(sdk)
  test.skip(!agent, "no visible agent")
  const providers = (await sdk.provider.list().then((r) => r.data))!
  const find = (key: string) => {
    const [providerID, ...rest] = key.split(":")
    const modelID = rest.join(":")
    return { providerID, modelID, model: providers.all.find((p) => p.id === providerID)?.models[modelID] }
  }

  await gotoSession()
  const trigger = page.locator(modelTriggerSelector)
  const keys = await listedKeys(page)
  const listed = keys.map(find).flatMap((entry) => (entry.model ? [{ ...entry, model: entry.model }] : []))
  // A model other than the one the server really runs, so a pick handed to the
  // created session differs from what that session records.
  const target = listed.find(
    (entry) => (entry.providerID !== real!.providerID || entry.modelID !== real!.modelID) && wanted(entry.model),
  )
  test.skip(!target, "the picker lists no suitable model other than the server default")
  const own = options.ownModel
    ? listed.find((entry) => entry !== target && !target!.model.name.includes(base(entry.model.name)))
    : undefined
  test.skip(!!options.ownModel && !own, "the picker lists no second model to give the cycled agent")
  if (own)
    await page.route(
      (url) => url.pathname.endsWith("/agent"),
      async (route) => {
        // The page can close (test teardown) while this handler's fetch is in
        // flight; a rejected continuation is not a test failure.
        try {
          const response = await route.fetch()
          const agents = (await response.json()) as { mode: string; hidden?: boolean; model?: ModelKey }[]
          const cycled = agents.filter((entry) => entry.mode !== "subagent" && !entry.hidden)[1]
          const patched = agents.map((entry) =>
            entry === cycled ? { ...entry, model: { providerID: own.providerID, modelID: own.modelID } } : entry,
          )
          await route.fulfill({ response, json: patched })
        } catch {
          await route.fallback().catch(() => undefined)
        }
      },
    )

  let routed: { providerID: string; modelID: string; variant?: string } = {
    providerID: target!.providerID,
    modelID: target!.modelID,
    variant: target!.model.variant,
  }
  await page.route("**/provider/default**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...real, ...routed, agent }),
    }),
  )
  const bodies = await capture(page, "**/prompt_async**")
  await page.reload()
  await expect(page.locator(promptSelector)).toBeVisible()
  await expect(trigger).toContainText(base(target!.model.name))

  const created: string[] = []
  // Submits a prompt, or a shell command. Leaving the new-session surface
  // records the created session at once, so a send that stalls after that
  // point still gets cleaned up.
  const enter = async (text: string, shell = false) => {
    const fresh = /\/session$/.test(page.url())
    await page.locator(promptSelector).click()
    await page.keyboard.press("ControlOrMeta+a")
    if (shell) await page.keyboard.type("!")
    await page.keyboard.type(text)
    await page.keyboard.press("Enter")
    if (!fresh) return
    await expect(page).toHaveURL(/\/session\/[^/]+$/)
    created.push(page.url().split("/").pop()!)
  }
  const send = async (text: string) => {
    const spent = await spentCount(page)
    await enter(text)
    await expect.poll(() => bodies.length).toBeGreaterThan(0)
    const body = bodies.splice(0)[0]
    await spentTo(page, spent + 1)
    return body
  }

  const dock = page.locator(modelVariantSelector)
  const label = async () => (await dock.textContent())?.trim() ?? ""
  const chooseVariant = async (name: RegExp) =>
    chooseOption(page, dock.getByRole("button").first(), page.getByRole("option").filter({ hasText: name }).first())
  // The routed default offers variants, so only a dock the preferences hide can be missing.
  const needsDock = async () => {
    await dock.waitFor({ timeout: 5000 }).catch(() => undefined)
    test.skip(!(await dock.isVisible()), "the variant dock is hidden by the dock preferences")
  }

  // Picks another model, then the routed default back.
  const bounce = async () => {
    const other = await pickModel(page)
    test.skip(!other, "the picker lists no model other than the routed default")
    await expect(trigger).toContainText(base(find(keyOf(other!)).model!.name))
    await trigger.click()
    await page.locator(`${listItemSelector}[data-key="${target!.providerID}:${target!.modelID}"]`).first().click()
    await expect(trigger).toContainText(base(target!.model.name))
  }

  // Back to the new-session surface, which re-reads /provider/default on entry;
  // waiting for that response means the dock reflects the moved default first.
  const revisit = async () => {
    await defocus(page)
    const refetch = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/provider/default"))
    await page.keyboard.press(`${modKey}+Shift+S`)
    await expect(page).toHaveURL(/\/session$/)
    await refetch
  }

  return {
    real: real!,
    target: target!,
    listed,
    trigger,
    created,
    enter,
    send,
    dock,
    label,
    chooseVariant,
    needsDock,
    own,
    bounce,
    revisit,
    move: (next: typeof routed) => {
      routed = next
    },
    // The session in the URL is deleted too: a send that stalled before it was
    // recorded still created one.
    cleanup: async () => {
      // Drop the route handlers first: an /agent or /provider/default fetch in
      // flight when the page closes would otherwise reject the handler.
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined)
      const open = /\/session\/([^/?#]+)$/.exec(page.url())?.[1]
      const ids = new Set([...created, ...(open ? [open] : [])])
      await Promise.all([...ids].map((sessionID) => sdk.session.delete({ sessionID }).catch(() => undefined)))
    },
  }
}

// A pick reset to the default is no pick: the first send from the new-session
// surface omits the model, and nothing unsent is handed to the created session
// to ride on its second send.
test("a model reset to the default rides on neither send from a new session", async ({ page, sdk, gotoSession }) => {
  const route = await routeDefault(page, sdk, gotoSession)
  try {
    await route.bounce()
    const first = await route.send(`e2e new session reset ${Date.now()}`)
    expect(first.model).toBeUndefined()
    const id = route.created[0]
    // The captured send never reached the server; a real one records the model
    // the server resolves, which is not the routed default.
    await seeded(sdk, id)
    await expect
      .poll(async () => (await sdk.session.get({ sessionID: id }).then((r) => r.data))?.current?.model?.modelID)
      .toBe(route.real.modelID)
    await expect(page.getByText("seed", { exact: true }).last()).toBeVisible()
    const second = await route.send("second send in the created session")
    expect(second.model).toBeUndefined()
  } finally {
    await route.cleanup()
  }
})

// A send spends the pick it stood on, sent or not: a model reset to the default
// leaves nothing behind, so a later change of the server's default shows on the
// next new session and rides on nothing.
test("a model reset to the default follows a later default change", async ({ page, sdk, gotoSession }) => {
  const route = await routeDefault(page, sdk, gotoSession)
  const moved = route.listed.find((entry) => !route.target.model.name.includes(base(entry.model.name)))
  test.skip(!moved, "the picker lists no model distinct from the routed default")
  try {
    await route.bounce()
    const first = await route.send(`e2e new session follow ${Date.now()}`)
    expect(first.model).toBeUndefined()

    route.move({ providerID: moved!.providerID, modelID: moved!.modelID, variant: moved!.model.variant })
    await route.revisit()
    await expect(route.trigger).toContainText(base(moved!.model.name))
    const next = await route.send("after the default moved")
    expect(next.model).toBeUndefined()
  } finally {
    await route.cleanup()
  }
})

// The same for a variant reset to Default, which sends nothing either.
test("a variant reset to the default follows a later default change", async ({ page, sdk, gotoSession }) => {
  const route = await routeDefault(page, sdk, gotoSession, (model) => Object.keys(model.variants ?? {}).length > 0)
  const names = Object.keys(route.target.model.variants ?? {})
  const { label, chooseVariant: choose } = route
  try {
    await route.needsDock()
    await choose(new RegExp(`^${escape(names[0])}$`, "i"))
    await expect.poll(label).toBe(names[0])
    await choose(/^default$/i)
    await expect.poll(label).toMatch(/^default$/i)
    const first = await route.send(`e2e new session variant follow ${Date.now()}`)
    expect(first.variant).toBeUndefined()

    const moved = names[names.length - 1]
    route.move({ providerID: route.target.providerID, modelID: route.target.modelID, variant: moved })
    await route.revisit()
    await expect.poll(label).toBe(moved)
    const next = await route.send("after the default variant moved")
    expect(next.variant).toBeUndefined()
  } finally {
    await route.cleanup()
  }
})

// A shell send carries no variant, but the variant picked on the new-session
// surface is still spent by it: left behind, it would ride on a later new session.
test("a fresh shell send clears a variant picked on the new-session surface", async ({ page, sdk, gotoSession }) => {
  const route = await routeDefault(page, sdk, gotoSession, (model) =>
    Object.keys(model.variants ?? {}).some((name) => name !== model.variant),
  )
  const picked = Object.keys(route.target.model.variants ?? {}).find((name) => name !== route.target.model.variant)!
  const shells = await capture(page, "**/session/*/shell*")
  try {
    await route.needsDock()
    await route.chooseVariant(new RegExp(`^${escape(picked)}$`, "i"))
    await expect.poll(route.label).toBe(picked)
    const spent = await spentCount(page)
    await route.enter("echo e2e fresh shell", true)
    await expect.poll(() => shells.length).toBe(1)
    expect(shells[0].model).toBeUndefined()
    await spentTo(page, spent + 1)

    await route.revisit()
    await expect.poll(route.label).toBe(route.target.model.variant ?? "Default")
  } finally {
    await route.cleanup()
  }
})

const cycleAgent = async (page: Page) => {
  await defocus(page)
  await page.keyboard.press(`${modKey}+.`)
}

// Cycling the agent is not a model pick: a variant pick made before it stands.
test("cycling the agent keeps a variant pick", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to cycle to")
  await withSession(sdk, `e2e request cycle agent ${Date.now()}`, async (session) => {
    await seeded(sdk, session.id)
    const seed = (await sdk.session.messages({ sessionID: session.id, limit: 1 }).then((r) => r.data ?? []))[0]?.info
    const from = agents.findIndex((entry) => entry.name === (seed?.role === "user" ? seed.agent : undefined))
    const bodies = await capture(page, "**/prompt_async**")
    await gotoSession(session.id)

    const dock = page.locator(modelVariantSelector)
    test.skip((await dock.count()) === 0, "current model has no variants")
    const label = async () => (await dock.textContent())?.trim() ?? ""
    const before = await label()
    const trigger = dock.getByRole("button").first()
    const others = await namedVariants(page, trigger, before)
    test.skip(!others, "current model offers no other named variant")
    const name = others!.at(-1)!
    await chooseOption(
      page,
      trigger,
      page
        .getByRole("option")
        .filter({ hasText: new RegExp(`^${escape(name)}$`) })
        .first(),
    )
    await expect.poll(label).toBe(name)

    await cycleAgent(page)
    await expect.poll(label).toBe(name)

    await page.locator(promptSelector).click()
    await page.keyboard.type("after cycling the agent")
    await page.keyboard.press("Enter")
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].agent).toBe(agents[(from + 1) % agents.length].name)
    expect(bodies[0].variant).toBe(name)
    expect(bodies[0].model).toBeUndefined()
  })
})

// An agent with its own model runs it in a session that has no model of its own
// yet, so cycling onto one makes the dock show it, and the send names it.
test("cycling to an agent with its own model makes the dock follow it", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to cycle to")
  const route = await routeDefault(page, sdk, gotoSession, undefined, { ownModel: true })
  try {
    await cycleAgent(page)
    await expect(route.trigger).toContainText(base(route.own!.model.name))
    const body = await route.send(`e2e cycle follows ${Date.now()}`)
    expect(body.agent).toBe(agents[1].name)
    expect(body.model).toEqual({ providerID: route.own!.providerID, modelID: route.own!.modelID })
  } finally {
    await route.cleanup()
  }
})

// A model the user picked stays through a cycle, whatever the agent configures.
test("cycling keeps an explicit model pick over the agent's own model", async ({ page, sdk, gotoSession }) => {
  const agents = await visibleAgents(sdk)
  test.skip(agents.length < 2, "there is no second agent to cycle to")
  const route = await routeDefault(page, sdk, gotoSession, undefined, { ownModel: true })
  try {
    const picked = await pickModel(page, [keyOf(route.own!)])
    test.skip(!picked, "the picker lists no third model")
    const name = (await nameOf(sdk, picked!))!
    await expect(route.trigger).toContainText(name)
    await cycleAgent(page)
    await expect(route.trigger).toContainText(name)
    const body = await route.send(`e2e cycle keeps pick ${Date.now()}`)
    expect(body.agent).toBe(agents[1].name)
    expect(body.model).toEqual(picked)
  } finally {
    await route.cleanup()
  }
})

// A handed-over pick was spent by the send that carried it. When the session's
// record settles on another model, the dock shows that one and the next send
// names nothing.
test("a handed-over model pick does not outlive the session's own record", async ({ page, sdk, gotoSession }) => {
  const route = await routeDefault(page, sdk, gotoSession)
  try {
    const picked = await pickModel(page, [keyOf(route.real)])
    test.skip(!picked, "the picker lists no model other than the server default")
    const settled = await nameOf(sdk, route.real)
    test.skip(!settled, "the server default is not listed")
    const first = await route.send(`e2e handed pick ${Date.now()}`)
    expect(first.model).toEqual(picked)

    // The captured send never reached the server; this message makes the session
    // record the server's own model instead.
    await sdk.session.promptAsync({
      sessionID: route.created[0],
      noReply: true,
      model: { providerID: route.real.providerID, modelID: route.real.modelID },
      parts: [{ type: "text", text: "seed" }],
    })
    await expect(route.trigger).toContainText(settled!)
    const second = await route.send("second send after the record settled")
    expect(second.model).toBeUndefined()
  } finally {
    await route.cleanup()
  }
})
