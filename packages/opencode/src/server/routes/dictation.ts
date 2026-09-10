import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { upgradeWebSocket } from "hono/bun"
import z from "zod"
import { Dictation } from "@/dictation"
import { DictationRecover } from "@/dictation/recover"
import { lazy } from "../../util/lazy"

export const DictationRoutes = lazy(() =>
  new Hono()
    .get(
      "/connect",
      describeRoute({
        summary: "Connect dictation stream",
        description:
          "Establish a WebSocket connection that proxies microphone audio to Deepgram and streams transcript text back.",
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
          "Return the transcript held for a dictation whose socket dropped before delivery, once. Absent or expired ids return 404.",
        operationId: "dictation.recover",
        responses: {
          200: {
            description: "Recovered",
            content: { "application/json": { schema: resolver(z.object({ text: z.string() })) } },
          },
          404: { description: "No transcript held for this id" },
        },
      }),
      (c) => {
        const text = DictationRecover.get(c.req.param("id"))
        if (text === undefined) return c.json({ error: "not found" }, 404)
        return c.json({ text })
      },
    ),
)
