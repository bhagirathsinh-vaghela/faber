import type { Subagent } from "@opencode-ai/sdk/v2/client"
import type { IconProps } from "@opencode-ai/ui/icon"
import type { dict } from "@/i18n/en"

type Status = Subagent["status"]
type Row = { owing: boolean; label: keyof typeof dict; icon?: IconProps["name"]; tone: string }

// How a row reads in the dialog. A subagent still holding an open debt to its
// parent (working, waiting for a new message after an interrupt, or about to
// deliver) belongs to the in-progress section;
// one with no debt has delivered, or never will, and is finished. `icon` is
// absent for the one row that spins.
const LOOK: Record<Status, Row> = {
  running: { owing: true, label: "dialog.subagents.status.running", tone: "text-text-weak" },
  interrupted: { owing: true, label: "dialog.subagents.status.interrupted", icon: "pause", tone: "text-text-weak" },
  unpaid: { owing: true, label: "dialog.subagents.status.unpaid", icon: "check", tone: "text-text-weak" },
  completed: { owing: false, label: "dialog.subagents.status.completed", icon: "circle-check", tone: "text-success" },
  failed: { owing: false, label: "dialog.subagents.status.failed", icon: "circle-x", tone: "text-error" },
  stopped: { owing: false, label: "dialog.subagents.status.stopped", icon: "circle-ban-sign", tone: "text-text-weak" },
}

// A status from an older or newer server reads as stopped rather than throwing.
export function look(status: Status) {
  return LOOK[status] ?? LOOK.stopped
}

export function owing(task: Pick<Subagent, "status">) {
  return look(task.status).owing
}

// An interrupted row is in progress but waits for a message, so it changes
// only when one arrives (which moves the parent's subagent count) and never
// keeps the dialog polling.
export function moving(task: Pick<Subagent, "status">) {
  return owing(task) && task.status !== "interrupted"
}
