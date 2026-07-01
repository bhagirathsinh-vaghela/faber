import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ModelPreference } from "@/preference/model"
import { Stash } from "@/preference/stash"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const PreferenceRoutes = lazy(() =>
  new Hono()
    .get(
      "/model",
      describeRoute({
        summary: "Get model preferences",
        description: "Get the server-owned model preferences (visibility, recents, variants).",
        operationId: "preference.model.get",
        responses: {
          200: {
            description: "Model preferences",
            content: {
              "application/json": {
                schema: resolver(ModelPreference.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ModelPreference.get())
      },
    )
    .put(
      "/model",
      describeRoute({
        summary: "Set model preferences",
        description: "Replace the server-owned model preferences.",
        operationId: "preference.model.set",
        responses: {
          200: {
            description: "Model preferences updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ModelPreference.Info),
      async (c) => {
        await ModelPreference.set(c.req.valid("json"))
        return c.json(true)
      },
    )
    .get(
      "/stash",
      describeRoute({
        summary: "List stash entries",
        description: "Get the server-owned prompt stash entries.",
        operationId: "preference.stash.list",
        responses: {
          200: {
            description: "Stash entries",
            content: {
              "application/json": {
                schema: resolver(Stash.Entry.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Stash.list())
      },
    )
    .post(
      "/stash",
      describeRoute({
        summary: "Push a stash entry",
        description: "Push a prompt onto the server-owned stash.",
        operationId: "preference.stash.push",
        responses: {
          200: {
            description: "Stash entry pushed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Stash.Entry),
      async (c) => {
        await Stash.push(c.req.valid("json"))
        return c.json(true)
      },
    )
    .delete(
      "/stash/:index",
      describeRoute({
        summary: "Remove a stash entry",
        description: "Remove a prompt from the server-owned stash by index.",
        operationId: "preference.stash.remove",
        responses: {
          200: {
            description: "Stash entry removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ index: z.coerce.number() })),
      async (c) => {
        await Stash.removeAt({ index: c.req.valid("param").index })
        return c.json(true)
      },
    ),
)
