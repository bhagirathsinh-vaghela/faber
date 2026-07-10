import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { upgradeWebSocket } from "hono/bun"
import z from "zod"
import { Dictation } from "@/dictation"
import { lazy } from "../../util/lazy"

export const DictationRoutes = lazy(() =>
  new Hono().get(
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
    upgradeWebSocket(() => {
      let handler: ReturnType<typeof Dictation.connect>
      return {
        onOpen(_event, ws) {
          handler = Dictation.connect(ws)
        },
        onMessage(event) {
          handler?.onMessage(event.data as string | ArrayBuffer)
        },
        onClose() {
          handler?.onClose()
        },
      }
    }),
  ),
)
