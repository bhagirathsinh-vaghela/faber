import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { upgradeWebSocket } from "hono/bun"
import z from "zod"
import { Dictation } from "@/dictation"
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
    )
    .get(
      "/pool",
      describeRoute({
        summary: "List dictation pool entries",
        description: "Get the server-owned in-memory pool of transcripts captured from companion devices.",
        operationId: "dictation.pool.list",
        responses: {
          200: {
            description: "Pool entries",
            content: {
              "application/json": {
                schema: resolver(Dictation.Pool.Entry.array()),
              },
            },
          },
        },
      }),
      (c) => {
        return c.json(Dictation.Pool.list())
      },
    )
    .post(
      "/pool",
      describeRoute({
        summary: "Append a dictation pool entry",
        description: "Append a captured transcript to the server-owned dictation pool.",
        operationId: "dictation.pool.append",
        responses: {
          200: {
            description: "Entry appended",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("json", z.object({ text: z.string() })),
      (c) => {
        Dictation.Pool.append(c.req.valid("json").text)
        return c.json(true)
      },
    )
    .delete(
      "/pool/:id",
      describeRoute({
        summary: "Remove a dictation pool entry",
        description: "Remove a transcript from the server-owned dictation pool by id.",
        operationId: "dictation.pool.remove",
        responses: {
          200: {
            description: "Entry removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      (c) => {
        Dictation.Pool.remove(c.req.valid("param").id)
        return c.json(true)
      },
    ),
)
