import { createContext, useContext, type JSX } from "solid-js"

// Which shell the sidebar is mounted in. The docked rail sits in the layout and
// takes width from the content beside it; the overlay floats over that content
// as a drawer. That difference is not cosmetic — it decides where a menu
// portals to, what a project icon's second click means, whether a hover card
// may open, and which element captures scroll. Consumers read it where they
// depend on it rather than receiving it from a caller several levels up, so a
// component that cares says so at the point of use.
const SidebarModeContext = createContext<{ overlay: boolean }>({ overlay: false })

export function SidebarModeProvider(props: { overlay?: boolean; children: JSX.Element }) {
  const value = { get overlay() { return props.overlay ?? false } }
  return <SidebarModeContext.Provider value={value}>{props.children}</SidebarModeContext.Provider>
}

export function useSidebarMode() {
  return useContext(SidebarModeContext)
}
