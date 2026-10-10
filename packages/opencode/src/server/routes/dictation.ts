import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { upgradeWebSocket } from "hono/bun"
import z from "zod"
import { Dictation } from "@/dictation"
import { DictationRecover } from "@/dictation/recover"
import { lazy } from "../../util/lazy"
import { Origin } from "../origin"

// Below the web client's 60 s wait for response headers (app utils/fetch.ts),
// so a pull answers before the client gives up on it.
const RECOVER_WAIT_MS = 45_000

export const DictationRoutes = lazy(() =>
  new Hono()
    .get(
      "/connect",
      describeRoute({
        summary: "Connect dictation stream",
        description:
          "Establish a WebSocket connection that proxies microphone audio to the local transcription sidecar and streams transcript text back.",
        operationId: "dictation.connect",
        responses: {
          200: {
            description: "Connected",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      Origin.socket,
      upgradeWebSocket((c) => {
        // The client mints this id and sends it here, so an unexpected drop can
        // hold the finished transcript for it to pull on reconnect.
        const id = c.req.query("id")
        let handler: ReturnType<typeof Dictation.connect>
        return {
          onOpen(_event, ws) {
            handler = Dictation.connect(ws, id)
          },
          onMessage(event) {
            handler?.onMessage(event.data as string | ArrayBuffer)
          },
          onClose() {
            handler?.onClose()
          },
        }
      }),
    )
    .get(
      "/recover/:id",
      describeRoute({
        summary: "Recover a dropped dictation transcript",
        description:
          "Return the transcript held for a dictation whose socket dropped before delivery. It stays held until released with DELETE, or until it expires. A recovery still running after a wait returns 202; pull again. Absent or expired ids return 404.",
        operationId: "dictation.recover",
        responses: {
          200: {
            description: "Recovered",
            content: { "application/json": { schema: resolver(z.object({ text: z.string() })) } },
          },
          202: {
            description: "Recovery still running",
            content: { "application/json": { schema: resolver(z.object({ pending: z.literal(true) })) } },
          },
          404: { description: "No transcript held for this id" },
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        if (!(await DictationRecover.wait(id, RECOVER_WAIT_MS))) return c.json({ pending: true as const }, 202)
        const text = DictationRecover.peek(id)
        if (text === undefined) return c.json({ error: "not found" }, 404)
        return c.json({ text })
      },
    )
    .delete(
      "/recover/:id",
      describeRoute({
        summary: "Release a recovered dictation transcript",
        description: "Drop the transcript held for a dictation once the client has inserted it.",
        operationId: "dictation.release",
        responses: {
          200: {
            description: "Released",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      (c) => {
        DictationRecover.release(c.req.param("id"))
        return c.json(true)
      },
    ),
)
