import { Hono } from "hono"
import { Config } from "../../config/config"
import { VoicePreference } from "../../preference/voice"
import { lazy } from "../../util/lazy"

const DEFAULT_LOCAL_URL = "http://127.0.0.1:4100"

const sidecar = async () => (await Config.getGlobal()).dictation?.url ?? DEFAULT_LOCAL_URL

// The client alone knows which containers it can decode and which reading the
// request belongs to, so both ride through rather than being re-derived here.
const forward = (c: { req: { header(name: string): string | undefined } }) => ({
  "content-type": "application/json",
  accept: c.req.header("accept") ?? "*/*",
  "x-speech-session": c.req.header("x-speech-session") ?? "",
})

// Proxies synthesis to the speech sidecar so a client needs one origin and no
// knowledge of where the sidecar listens. The sidecar stays bound to loopback,
// and a phone on cellular reaches it the same way it reaches everything else.
export const TtsRoutes = lazy(() =>
  new Hono()
    .post("/speak", async (c) => {
      const body = await c.req.json().catch(() => undefined)
      if (!body?.text?.trim()) return c.text("empty", 400)
      const dictation = (await Config.getGlobal()).dictation
      // A voice picked in any client's UI wins over the config default; the
      // sidecar falls back to its own default when both are unset. The browser
      // never sends a voice, so a stale tab cannot pin an old one.
      const voice = (await VoicePreference.get()).name ?? dictation?.voice
      const response = await fetch(`${dictation?.url ?? DEFAULT_LOCAL_URL}/speak`, {
        method: "POST",
        body: JSON.stringify({ text: body.text, next: body.next, voice }),
        headers: forward(c),
      }).catch(() => undefined)
      if (!response?.ok) return c.text("speech unavailable", 503)
      return new Response(response.body, {
        headers: {
          "content-type": response.headers.get("content-type") ?? "audio/mp4",
          "cache-control": "no-store",
          ...(response.headers.get("x-audio-seconds")
            ? { "x-audio-seconds": response.headers.get("x-audio-seconds")! }
            : {}),
        },
      })
    })
    .post("/done", async (c) => {
      await fetch(`${await sidecar()}/done`, { method: "POST", headers: forward(c) }).catch(() => undefined)
      return c.json({ released: true })
    }),
)
