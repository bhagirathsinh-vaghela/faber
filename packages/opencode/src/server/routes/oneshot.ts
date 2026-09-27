import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Oneshot } from "@/session/oneshot"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const OneshotRoutes = lazy(() =>
  new Hono().post(
    "/",
    describeRoute({
      summary: "One-shot model call",
      description:
        "Send a system prompt and a prompt; get the model's text back. No session, no tools, no instructions, nothing persisted.",
      operationId: "oneshot",
      responses: {
        200: {
          description: "The model's answer, or an error result",
          content: { "application/json": { schema: resolver(Oneshot.Result) } },
        },
        ...errors(400),
      },
    }),
    validator("json", Oneshot.Input),
    async (c) => {
      // Nothing is written until the model finishes, so the global idle timeout
      // would reap a slow call mid-flight. c.env is the Bun Server; absent in tests.
      const server = c.env as { timeout?: (req: Request, seconds: number) => void }
      server?.timeout?.(c.req.raw, 0)
      return c.json(await Oneshot.run(c.req.valid("json")))
    },
  ),
)
