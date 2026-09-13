import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ModelPreference } from "@/preference/model"
import { VoicePreference } from "@/preference/voice"
import { AppearancePreference } from "@/preference/appearance"
import { BoxPreference } from "@/preference/boxes"
import { ThemePreference } from "@/preference/theme"
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
      "/voice",
      describeRoute({
        summary: "Get voice preference",
        description: "Get the server-owned read-aloud voice, or null when unset.",
        operationId: "preference.voice.get",
        responses: {
          200: {
            description: "Voice preference",
            content: {
              "application/json": {
                schema: resolver(VoicePreference.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await VoicePreference.get())
      },
    )
    .put(
      "/voice",
      describeRoute({
        summary: "Set voice preference",
        description: "Set the server-owned read-aloud voice (null clears it).",
        operationId: "preference.voice.set",
        responses: {
          200: {
            description: "Voice preference updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", VoicePreference.Info),
      async (c) => {
        await VoicePreference.set(c.req.valid("json"))
        return c.json(true)
      },
    )
    .get(
      "/appearance",
      describeRoute({
        summary: "Get appearance preferences",
        description: "Get the server-owned appearance preferences (fonts, weights, per-mode theme overrides).",
        operationId: "preference.appearance.get",
        responses: {
          200: {
            description: "Appearance preferences",
            content: {
              "application/json": {
                schema: resolver(AppearancePreference.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppearancePreference.get())
      },
    )
    .put(
      "/appearance",
      describeRoute({
        summary: "Set appearance preferences",
        description: "Replace the server-owned appearance preferences.",
        operationId: "preference.appearance.set",
        responses: {
          200: {
            description: "Appearance preferences updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", AppearancePreference.Info),
      async (c) => {
        await AppearancePreference.set(c.req.valid("json"))
        return c.json(true)
      },
    )
    .get(
      "/boxes",
      describeRoute({
        summary: "Get box collapse preferences",
        description: "Get the server-owned per-box-type collapse defaults (per normal/reader mode).",
        operationId: "preference.boxes.get",
        responses: {
          200: {
            description: "Box preferences",
            content: {
              "application/json": {
                schema: resolver(BoxPreference.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await BoxPreference.get())
      },
    )
    .put(
      "/boxes",
      describeRoute({
        summary: "Set box collapse preferences",
        description: "Replace the server-owned per-box-type collapse defaults.",
        operationId: "preference.boxes.set",
        responses: {
          200: {
            description: "Box preferences updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", BoxPreference.Info),
      async (c) => {
        await BoxPreference.set(c.req.valid("json"))
        return c.json(true)
      },
    )
    .get(
      "/themes",
      describeRoute({
        summary: "List user themes",
        description: "Get the server-owned named user themes (base + appearance overrides).",
        operationId: "preference.theme.list",
        responses: {
          200: {
            description: "User themes",
            content: {
              "application/json": {
                schema: resolver(ThemePreference.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ThemePreference.list())
      },
    )
    .put(
      "/themes",
      describeRoute({
        summary: "Save a user theme",
        description: "Create or update a named user theme (upsert by id).",
        operationId: "preference.theme.save",
        responses: {
          200: {
            description: "User theme saved",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ThemePreference.Info),
      async (c) => {
        await ThemePreference.save(c.req.valid("json"))
        return c.json(true)
      },
    )
    .delete(
      "/themes/:id",
      describeRoute({
        summary: "Remove a user theme",
        description: "Delete a named user theme by id.",
        operationId: "preference.theme.remove",
        responses: {
          200: {
            description: "User theme removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        await ThemePreference.remove({ id: c.req.valid("param").id })
        return c.json(true)
      },
    )
    .get(
      "/themes/active",
      describeRoute({
        summary: "Get active theme",
        description: "Get the id of the active user theme, or null.",
        operationId: "preference.theme.getActive",
        responses: {
          200: {
            description: "Active theme id",
            content: {
              "application/json": {
                schema: resolver(z.string().nullable()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ThemePreference.getActive())
      },
    )
    .put(
      "/themes/active",
      describeRoute({
        summary: "Set active theme",
        description: "Set the active user theme id (null clears it).",
        operationId: "preference.theme.setActive",
        responses: {
          200: {
            description: "Active theme updated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ id: z.string().nullable() })),
      async (c) => {
        await ThemePreference.setActive({ id: c.req.valid("json").id })
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
