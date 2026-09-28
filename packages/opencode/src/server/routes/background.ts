import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Recovery } from "../../session/recovery"
import { lazy } from "../../util/lazy"

export const BackgroundRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "List subagents",
      description:
        "A session's subagents as the database records them, newest first. Stopping one is POST /session/:id/abort on the subagent's session.",
      operationId: "background.list",
      responses: {
        200: {
          description: "Subagents of the session",
          content: {
            "application/json": {
              schema: resolver(Recovery.Subagent.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        sessionID: z.string().meta({ description: "The parent session" }),
      }),
    ),
    async (c) => c.json(await Recovery.subagents(c.req.valid("query").sessionID)),
  ),
)
