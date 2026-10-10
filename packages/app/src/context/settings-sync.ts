import type { Event } from "@opencode-ai/sdk/v2/client"

export interface Local<T> {
  themes: T[]
  active: string | null
  dirty: boolean
  boxesDirty: boolean
}

// What a server preference event changes in this client. `theme` loads a user
// theme (null: back to the plain base); `active` only records the pointer, for
// a theme whose record arrives in the next theme.preference.updated. Unsaved
// edits in this client win: a dirty appearance or box matrix is left alone.
export interface Patch<T> {
  themes?: T[]
  active?: string
  theme?: T | null
  appearance?: unknown
  boxes?: unknown
  draft?: unknown
}

export function receive<T extends { id: string }>(local: Local<T>, event: Event): Patch<T> {
  if (event.type === "boxes.preference.updated") {
    if (local.boxesDirty) return { boxes: event.properties }
    return { boxes: event.properties, draft: event.properties }
  }
  if (event.type === "theme.preference.updated") {
    const themes = event.properties.themes as unknown as T[]
    const found = themes.find((x) => x.id === local.active)
    if (!found || local.dirty) return { themes }
    return { themes, theme: found }
  }
  if (event.type === "theme.preference.active-updated") {
    const id = event.properties.active
    if (id === local.active || local.dirty) return {}
    if (!id) return { theme: null }
    const found = local.themes.find((x) => x.id === id)
    if (!found) return { active: id }
    return { theme: found }
  }
  if (event.type === "appearance.preference.updated") {
    if (local.active || local.dirty) return {}
    return { appearance: event.properties }
  }
  return {}
}
