import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"

export type BoxMode = "normal" | "zen"

// Bridges the app's per-box collapse defaults + current view mode into the ui
// layer (which cannot import app's settings/layout contexts). The app supplies
// `mode` (reactive) and a `collapsed(type, mode)` resolver; boxes read them to
// decide their default open state and to reset manual overrides on mode change.
export type BoxDefaults = {
  mode: Accessor<BoxMode>
  collapsed: (type: string, mode: BoxMode) => boolean
}

const ctx = createContext<BoxDefaults>()

export function BoxDefaultsProvider(props: ParentProps<BoxDefaults>) {
  return <ctx.Provider value={{ mode: props.mode, collapsed: props.collapsed }}>{props.children}</ctx.Provider>
}

// Non-throwing: a box rendered outside the provider (tests, isolated previews)
// gets undefined and falls back to its own defaultOpen.
export function useBoxDefaults() {
  return useContext(ctx)
}
