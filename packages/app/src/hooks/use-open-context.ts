import { createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"

// The one way to open the session's context panel, shared by every entry point
// (the statusline and dock context indicators, the "View context" palette
// command).
export function useOpenContext() {
  const layout = useLayout()
  const params = useParams()

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))

  return () => {
    if (!params.id) return
    layout.fileTree.open()
    layout.fileTree.setTab("all")
    tabs().open("context")
    tabs().setActive("context")
  }
}
