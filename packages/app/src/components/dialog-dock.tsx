import { createSignal, For, type Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Button } from "@opencode-ai/ui/button"
import { useLocal } from "@/context/local"
import { dictationEnhanced, setDictationEnhanced } from "@/utils/dictation"

// Canonical field registry: the show/hide units in fixed
// render order, grouped by the line they live on. Labels are display-only; the
// `id` matches what the render sites gate on (usage-line.tsx, message-footer.tsx,
// prompt-input.tsx) and what the server stores. Order here is documentation
// only — render order is owned by the render sites, not this list.
const SECTIONS: { title: string; fields: { id: string; label: string }[] }[] = [
  {
    title: "Header",
    fields: [
      { id: "agent", label: "Mode" },
      { id: "model", label: "Model" },
      { id: "variant", label: "Variant" },
      { id: "duration", label: "Duration (footer only)" },
      { id: "cwd", label: "Working directory" },
      { id: "branch", label: "Git branch" },
    ],
  },
  {
    title: "Usage",
    fields: [
      { id: "context", label: "Context window" },
      { id: "cached", label: "Cached (this turn)" },
      { id: "cache-write", label: "Cache write (this turn)" },
      { id: "next-turn", label: "Next turn" },
      { id: "input", label: "Session input" },
      { id: "output", label: "Session output" },
      { id: "session-cache-write", label: "Session cache write" },
      { id: "cost", label: "Cost" },
    ],
  },
  {
    title: "Subagents",
    fields: [{ id: "mcp", label: "MCP tools" }],
  },
  {
    title: "Controls",
    fields: [{ id: "auto-accept", label: "Auto-accept edits" }],
  },
  {
    title: "Titlebar",
    fields: [
      { id: "back-forward", label: "Back / forward (desktop only)" },
      { id: "terminal", label: "Terminal (desktop only)" },
      { id: "review", label: "Review panel" },
    ],
  },
]

// Dock & input preferences: per-surface show/hide checkboxes — a
// desktop/mobile toggle picks which layout you're editing; the live dock + every
// message footer react instantly via the local.dock store — plus input-behavior
// preferences (dictation mic mode) that are not per-surface. No reorder:
// field order is canonical, so the field list is checkboxes only.
export const DialogDock: Component = () => {
  const local = useLocal()
  const [surface, setSurface] = createSignal<"desktop" | "mobile">(local.dock.isDesktop() ? "desktop" : "mobile")

  return (
    <Dialog title="Dock & input preferences" size="normal">
      {/* Fill the dialog body (which is flex:1 / overflow:hidden) and keep the
          surface toggle pinned while the field list scrolls — without an inner
          scroll region the list is clipped, not scrollable, on short viewports
          like a phone. */}
      <div class="flex h-full min-h-0 flex-col gap-4 px-5 pb-5">
        <div class="flex shrink-0 items-center gap-1 self-start rounded-md bg-surface-inset-base p-0.5">
          <For each={["desktop", "mobile"] as const}>
            {(s) => (
              <Button
                variant={surface() === s ? "secondary" : "ghost"}
                class="capitalize"
                onClick={() => setSurface(s)}
              >
                {s}
              </Button>
            )}
          </For>
        </div>

        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <For each={SECTIONS}>
            {(section) => (
              <div class="flex flex-col gap-2">
                <span class="text-11-medium uppercase tracking-wide text-text-weak">{section.title}</span>
                <For each={section.fields}>
                  {(field) => (
                    <Checkbox
                      checked={local.dock.list(surface()).includes(field.id)}
                      onChange={() => local.dock.toggle(surface(), field.id)}
                    >
                      {field.label}
                    </Checkbox>
                  )}
                </For>
              </div>
            )}
          </For>

          {/* Dictation is a per-device behavior preference, not a per-surface
              show/hide field, so it sits outside SECTIONS and ignores the
              desktop/mobile toggle. Raw sends no browser voice-processing DSP
              (best for a good external mic); Enhanced enables echo
              cancellation, noise suppression, and auto gain (helps a quiet
              built-in mic). Takes effect on the next recording. */}
          <div class="flex flex-col gap-2">
            <span class="text-11-medium uppercase tracking-wide text-text-weak">Dictation</span>
            <div class="flex items-center justify-between gap-3">
              <div class="flex flex-col">
                <span class="text-13-regular text-text-base">Microphone processing</span>
                <span class="text-11-regular text-text-weak">Applies to the next recording</span>
              </div>
              <div class="flex items-center rounded-full border border-border-base p-0.5 text-11-medium">
                <button
                  type="button"
                  aria-pressed={!dictationEnhanced()}
                  onClick={() => setDictationEnhanced(false)}
                  class="rounded-full px-3 py-1 transition-colors text-text-weak hover:text-text-base aria-[pressed=true]:bg-surface-inset-base aria-[pressed=true]:text-text-base"
                >
                  Raw
                </button>
                <button
                  type="button"
                  aria-pressed={dictationEnhanced()}
                  onClick={() => setDictationEnhanced(true)}
                  class="rounded-full px-3 py-1 transition-colors text-text-weak hover:text-text-base aria-[pressed=true]:bg-surface-inset-base aria-[pressed=true]:text-text-base"
                >
                  Enhanced
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
