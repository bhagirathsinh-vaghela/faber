import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { HeadlessAgent } from "@/session/headless"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const HeadlessRoutes = lazy(() =>
  new Hono().post(
    "/",
    describeRoute({
      summary: "Run an agent headless",
      description:
        "Run a named agent to completion with no human attached and get its final message back. Permission prompts are denied and listed; the session is removed afterwards.",
      operationId: "agent.headless",
      responses: {
        200: {
          description: "The agent's final message, or an error result",
          content: { "application/json": { schema: resolver(HeadlessAgent.Result) } },
        },
        ...errors(400),
      },
    }),
    validator("json", HeadlessAgent.Input),
    async (c) => {
      // Nothing is written until the run finishes, so the global idle timeout
      // would reap it mid-flight. c.env is the Bun Server; absent in tests.
      const server = c.env as { timeout?: (req: Request, seconds: number) => void }
      server?.timeout?.(c.req.raw, 0)
      return c.json(await HeadlessAgent.run(c.req.valid("json")))
    },
  ),
)
