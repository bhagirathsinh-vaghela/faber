// Copy text to the clipboard, with a fallback for non-secure contexts.
// navigator.clipboard is only defined over HTTPS or localhost; the embedded
// web UI is often reached over plain HTTP (e.g. a Tailscale hostname), where
// the modern API is undefined and silently fails. Fall back to a hidden
// textarea + execCommand("copy") there.
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }
  const area = document.createElement("textarea")
  area.value = text
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.focus()
  area.select()
  const ok = document.execCommand("copy")
  document.body.removeChild(area)
  return ok
}
