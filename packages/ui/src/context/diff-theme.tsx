import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"

// The Shiki theme name used to highlight diff previews (edit/apply_patch). Kept
// separate from the code-block theme so the two surfaces can be themed
// independently. Defaults to "github-dark" so packages/ui renders correctly with
// no provider (standalone / tests). The app wraps its tree with DiffThemeProvider
// to feed the user's chosen theme in.
const fallback: Accessor<string> = () => "github-dark"

const Context = createContext<Accessor<string>>(fallback)

export function DiffThemeProvider(props: ParentProps<{ value: Accessor<string> }>) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}

export function useDiffTheme() {
  return useContext(Context)
}
