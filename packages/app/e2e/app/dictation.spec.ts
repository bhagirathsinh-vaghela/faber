import { test, expect } from "../fixtures"

// The pause control is the chunking feature's user surface: pausing commits the
// audio so far and drops incoming frames until resume. These assert the overlay
// exposes the control, its state machine flips correctly, and — end to end
// against a fake mic — that audio frames stop crossing the WebSocket while
// paused and a commit is sent at the pause boundary.
test.describe("dictation pause control", () => {
  test("the overlay shows a pause button that toggles to resume and back", async ({ page, gotoSession }) => {
    await gotoSession()

    const mic = page.locator('button[aria-label="Dictate"]')
    test.skip((await mic.count()) === 0, "dictation unsupported in this browser")
    await mic.click()

    const pause = page.locator("[data-dictation-pause]")
    await expect(pause).toBeVisible()
    await expect(pause).toHaveAttribute("aria-pressed", "false")
    await expect(pause).toHaveAccessibleName("Pause")

    // A session must establish (fake mic + rate handshake) before pause has an
    // effect, so the toggle is polled rather than asserted on the first click.
    await expect
      .poll(async () => {
        await pause.click()
        return pause.getAttribute("aria-pressed")
      })
      .toBe("true")
    await expect(pause).toHaveAccessibleName("Resume")

    await pause.click()
    await expect(pause).toHaveAttribute("aria-pressed", "false")
    await expect(pause).toHaveAccessibleName("Pause")
  })

  test("audio frames stop crossing the wire while paused, and a commit is sent", async ({ page, gotoSession }) => {
    const wire = { audio: 0, committed: false }
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/dictation/connect")) return
      ws.on("framesent", (frame) => {
        if (typeof frame.payload !== "string") {
          wire.audio++
          return
        }
        if (frame.payload.includes('"commit"')) wire.committed = true
      })
    })

    await gotoSession()

    const mic = page.locator('button[aria-label="Dictate"]')
    test.skip((await mic.count()) === 0, "dictation unsupported in this browser")
    await mic.click()

    const pause = page.locator("[data-dictation-pause]")
    await expect(pause).toBeVisible()

    await expect.poll(() => wire.audio).toBeGreaterThan(0)

    await pause.click()
    await expect(pause).toHaveAttribute("aria-pressed", "true")
    expect(wire.committed).toBe(true)

    const paused = wire.audio
    await page.waitForTimeout(1000)
    expect(wire.audio).toBe(paused)

    await pause.click()
    await expect(pause).toHaveAttribute("aria-pressed", "false")
    await expect.poll(() => wire.audio).toBeGreaterThan(paused)
  })

  test("committed transcript chunks render live in the overlay", async ({ page, gotoSession }) => {
    // Capture the dictation socket so the test can push transcript messages the
    // way the server would, without needing real speech.
    await page.addInitScript(() => {
      const Native = window.WebSocket
      const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const ws = protocols ? new Native(url, protocols) : new Native(url)
        if (String(url).includes("/dictation/connect")) (window as unknown as { __ws: WebSocket }).__ws = ws
        return ws
      } as unknown as typeof WebSocket
      Patched.prototype = Native.prototype
      Object.assign(Patched, {
        CONNECTING: Native.CONNECTING,
        OPEN: Native.OPEN,
        CLOSING: Native.CLOSING,
        CLOSED: Native.CLOSED,
      })
      window.WebSocket = Patched
    })

    await gotoSession()

    const mic = page.locator('button[aria-label="Dictate"]')
    test.skip((await mic.count()) === 0, "dictation unsupported in this browser")
    await mic.click()

    await expect(page.locator("[data-dictation-pause]")).toBeVisible()

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws
      if (!ws) throw new Error("dictation socket not captured")
      const fire = (obj: unknown) => ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(obj) }))
      fire({ type: "rate", rate: 16000 })
      fire({ type: "transcript", final: true, text: "first committed chunk" })
      fire({ type: "transcript", final: true, text: "second committed chunk" })
    })

    await expect(page.getByText("first committed chunk second committed chunk")).toBeVisible()
  })

  test("spacebar toggles pause while the overlay is open", async ({ page, gotoSession }) => {
    await gotoSession()

    const mic = page.locator('button[aria-label="Dictate"]')
    test.skip((await mic.count()) === 0, "dictation unsupported in this browser")
    await mic.click()

    const pause = page.locator("[data-dictation-pause]")
    await expect(pause).toBeVisible()

    await expect
      .poll(async () => {
        await page.keyboard.press("Space")
        return pause.getAttribute("aria-pressed")
      })
      .toBe("true")

    await page.keyboard.press("Space")
    await expect(pause).toHaveAttribute("aria-pressed", "false")
  })
})
