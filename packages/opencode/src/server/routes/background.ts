import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { BackgroundTask } from "../../background"
import { acceptPendingResult, acceptAllPending, subagentsForSession } from "../../tool/task"
import { lazy } from "../../util/lazy"

export const BackgroundRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List background tasks",
        description: "Get a list of all background tasks, optionally filtered by session.",
        operationId: "background.list",
        responses: {
          200: {
            description: "List of background tasks",
            content: {
              "application/json": {
                schema: resolver(BackgroundTask.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: z.string().optional().meta({ description: "Filter by parent session ID" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        // For one session, derive from the durable child sessions so the list
        // survives a restart and cannot double-count a resumed child. The
        // unfiltered list has no parent to walk children under, so it stays the
        // in-memory view (a diagnostic, not the dialog's source).
        if (query.sessionID) return c.json(await subagentsForSession(query.sessionID))
        return c.json(BackgroundTask.list())
      },
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get background task",
        description: "Get a specific background task by ID.",
        operationId: "background.get",
        responses: {
          200: {
            description: "Background task",
            content: {
              "application/json": {
                schema: resolver(BackgroundTask.Info),
              },
            },
          },
          404: {
            description: "Task not found",
          },
        },
      }),
      validator(
        "param",
        z.object({
          id: z.string().meta({ description: "Task ID" }),
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const task = BackgroundTask.get(id)
        if (!task) return c.json({ error: "Task not found" }, 404)
        return c.json(task)
      },
    )
    .post(
      "/:id/cancel",
      describeRoute({
        summary: "Cancel background task",
        description: "Cancel a running background task.",
        operationId: "background.cancel",
        responses: {
          200: {
            description: "Task cancelled",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          id: z.string().meta({ description: "Task ID" }),
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const success = BackgroundTask.cancel(id)
        return c.json({ success })
      },
    )
    .get(
      "/session/:sessionID/auto-inject",
      describeRoute({
        summary: "Get auto-inject setting",
        description: "Get the auto-inject setting for a session.",
        operationId: "background.getAutoInject",
        responses: {
          200: {
            description: "Auto-inject setting",
            content: {
              "application/json": {
                schema: resolver(z.object({ autoInject: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        return c.json({ autoInject: await BackgroundTask.getAutoInject(sessionID) })
      },
    )
    .post(
      "/session/:sessionID/auto-inject",
      describeRoute({
        summary: "Set auto-inject setting",
        description: "Set the auto-inject setting for a session.",
        operationId: "background.setAutoInject",
        responses: {
          200: {
            description: "Auto-inject setting updated",
            content: {
              "application/json": {
                schema: resolver(z.object({ autoInject: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          autoInject: z.boolean().meta({ description: "Enable or disable auto-inject" }),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const { autoInject } = c.req.valid("json")
        BackgroundTask.setAutoInject(sessionID, autoInject)
        return c.json({ autoInject })
      },
    )
    .post(
      "/session/:sessionID/auto-inject/toggle",
      describeRoute({
        summary: "Toggle auto-inject setting",
        description: "Toggle the auto-inject setting for a session.",
        operationId: "background.toggleAutoInject",
        responses: {
          200: {
            description: "Auto-inject setting toggled",
            content: {
              "application/json": {
                schema: resolver(z.object({ autoInject: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const autoInject = await BackgroundTask.toggleAutoInject(sessionID)
        return c.json({ autoInject })
      },
    )
    .get(
      "/session/:sessionID/pending",
      describeRoute({
        summary: "Get pending results",
        description: "Get all pending background task results for a session.",
        operationId: "background.getPending",
        responses: {
          200: {
            description: "Pending results",
            content: {
              "application/json": {
                schema: resolver(BackgroundTask.PendingResult.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        return c.json(BackgroundTask.getPending(sessionID))
      },
    )
    .post(
      "/session/:sessionID/pending/:taskId/accept",
      describeRoute({
        summary: "Accept pending result",
        description: "Accept and inject a pending background task result into the session.",
        operationId: "background.acceptPending",
        responses: {
          200: {
            description: "Result accepted",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          taskId: z.string().meta({ description: "Task ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          triggerLLM: z.boolean().optional().meta({ description: "Trigger LLM to process the result after injection" }),
        }),
      ),
      async (c) => {
        const { sessionID, taskId } = c.req.valid("param")
        const { triggerLLM } = c.req.valid("json")
        const success = await acceptPendingResult(sessionID, taskId, triggerLLM ?? false)
        return c.json({ success })
      },
    )
    .post(
      "/session/:sessionID/pending/accept-all",
      describeRoute({
        summary: "Accept all pending results",
        description: "Accept and inject all pending background task results into the session.",
        operationId: "background.acceptAllPending",
        responses: {
          200: {
            description: "All results accepted",
            content: {
              "application/json": {
                schema: resolver(z.object({ count: z.number() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          triggerLLM: z
            .boolean()
            .optional()
            .meta({ description: "Trigger LLM to process the results after injection" }),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const { triggerLLM } = c.req.valid("json")
        const count = await acceptAllPending(sessionID, triggerLLM ?? false)
        return c.json({ count })
      },
    )
    .post(
      "/session/:sessionID/pending/dismiss",
      describeRoute({
        summary: "Dismiss pending results",
        description: "Dismiss (discard) pending background task results without injecting them.",
        operationId: "background.dismissPending",
        responses: {
          200: {
            description: "Results dismissed",
            content: {
              "application/json": {
                schema: resolver(z.object({ count: z.number() })),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          taskIds: z.array(z.string()).optional().meta({ description: "Task IDs to dismiss (all if not specified)" }),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const { taskIds } = c.req.valid("json")
        const removed = BackgroundTask.clearPending(sessionID, taskIds)
        return c.json({ count: removed.length })
      },
    )
    .get(
      "/auto-inject/default",
      describeRoute({
        summary: "Get auto-inject default",
        description: "Get the global default auto-inject setting for new sessions.",
        operationId: "background.getAutoInjectDefault",
        responses: {
          200: {
            description: "Auto-inject default",
            content: {
              "application/json": {
                schema: resolver(z.object({ autoInject: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ autoInject: await BackgroundTask.getAutoInjectDefault() })
      },
    )
    .post(
      "/auto-inject/default/toggle",
      describeRoute({
        summary: "Toggle auto-inject default",
        description: "Toggle the global default auto-inject setting for new sessions.",
        operationId: "background.toggleAutoInjectDefault",
        responses: {
          200: {
            description: "Auto-inject default toggled",
            content: {
              "application/json": {
                schema: resolver(z.object({ autoInject: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const autoInject = await BackgroundTask.toggleAutoInjectDefault()
        return c.json({ autoInject })
      },
    ),
)
