import { createContext, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"

export type BoxMode = "normal" | "reader" | "minimal"

// Bridges the app's per-box collapse defaults + current view mode into the ui
// layer (which cannot import app's settings/layout contexts). The app supplies
// `mode` (reactive), a `collapsed(type, mode)` resolver, and the store holding
// manual overrides; boxes read them to decide their open state.
export type BoxDefaults = {
  mode: Accessor<BoxMode>
  collapsed: (type: string, mode: BoxMode) => boolean
  open: (sessionID: string, boxID: string) => boolean | undefined
  setOpen: (sessionID: string, boxID: string, open: boolean) => void
  // Debug: render the injected blocks the transcript hides (rule reminders,
  // the MCP catalog, mid-turn nudges) so what the model was sent can be read.
  // Absent outside the provider, which reads as off.
  showInternal?: Accessor<boolean>
}

const ctx = createContext<BoxDefaults>()

export function BoxDefaultsProvider(props: ParentProps<BoxDefaults>) {
  return (
    <ctx.Provider
      value={{
        mode: props.mode,
        collapsed: props.collapsed,
        open: props.open,
        setOpen: props.setOpen,
        get showInternal() {
          return props.showInternal
        },
      }}
    >
      {props.children}
    </ctx.Provider>
  )
}

// Non-throwing: a box rendered outside the provider (tests, isolated previews)
// gets undefined and falls back to its own defaultOpen.
export function useBoxDefaults() {
  return useContext(ctx)
}

// The open/toggle pair every collapsible transcript box shares. Inputs are
// accessors because virtua recycles a box across turns: capturing one turn's
// identity would leave it reading a previous turn's override.
//
// A box with no identity (a permission prompt, a preview outside the provider)
// keeps its state locally, which is all such a box needs — it does not outlive
// the view that owns it.
export function createBoxOpen(input: {
  sessionID: () => string | undefined
  boxID: () => string | undefined
  fallback: () => boolean
}) {
  const defaults = useBoxDefaults()
  const [local, setLocal] = createSignal<boolean | undefined>(undefined)

  const key = () => {
    const session = input.sessionID()
    const box = input.boxID()
    if (!defaults || !session || !box) return undefined
    return { session, box }
  }

  const open = () => {
    const current = key()
    if (!current) return local() ?? input.fallback()
    return defaults!.open(current.session, current.box) ?? input.fallback()
  }

  return [
    open,
    (next: boolean) => {
      const current = key()
      if (!current) {
        setLocal(next)
        return
      }
      defaults!.setOpen(current.session, current.box, next)
    },
  ] as const
}
