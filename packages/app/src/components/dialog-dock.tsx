import { createSignal, For, type Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Button } from "@opencode-ai/ui/button"
import { useLocal } from "@/context/local"

// Canonical field registry: the show/hide units in fixed
// render order, grouped by the line they live on. Labels are display-only; the
// `id` matches what the render sites gate on (usage-line.tsx, message-footer.tsx,
// prompt-input.tsx) and what the server stores. Order here is documentation
// only — render order is owned by the render sites, not this list.
const SECTIONS: { title: string; fields: { id: string; label: string }[] }[] = [
  {
    title: "Header",
    fields: [
      { id: "agent", label: "Agent" },
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
    title: "Tasks",
    fields: [
      { id: "pending", label: "Pending (subtasks running)" },
      { id: "available", label: "Available (results to accept)" },
      { id: "auto-inject", label: "Auto-inject" },
    ],
  },
]

// Show/hide config dialog. Per-surface checkboxes — a desktop/mobile
// toggle picks which layout you're editing; the live dock + every message footer
// react instantly via the local.dock store. No reorder: order is
// canonical, so this is checkboxes only.
export const DialogDock: Component = () => {
  const local = useLocal()
  const [surface, setSurface] = createSignal<"desktop" | "mobile">(local.dock.isDesktop() ? "desktop" : "mobile")

  return (
    <Dialog title="Customize fields" size="normal">
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
        </div>
      </div>
    </Dialog>
  )
}
