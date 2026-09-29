import { describe, expect, test } from "bun:test"
import { look, moving, owing } from "./subagent"

const STATUSES = ["running", "interrupted", "unpaid", "completed", "failed", "stopped"] as const

describe("subagent rows", () => {
  test("every status an open debt produces is in progress, every other one finished", () => {
    expect(STATUSES.filter((status) => owing({ status }))).toEqual(["running", "interrupted", "unpaid"])
  })

  test("only a row that can change on its own keeps the dialog polling", () => {
    expect(STATUSES.filter((status) => moving({ status }))).toEqual(["running", "unpaid"])
  })

  test("a status this client does not know reads as a finished, stopped row", () => {
    const status = "paused" as (typeof STATUSES)[number]
    expect(look(status)).toEqual(look("stopped"))
    expect(owing({ status })).toBe(false)
    expect(moving({ status })).toBe(false)
  })

  test("each status reads apart by label and icon", () => {
    expect(Object.fromEntries(STATUSES.map((status) => [status, look(status)]))).toEqual({
      running: { owing: true, label: "dialog.subagents.status.running", tone: "text-text-weak" },
      interrupted: { owing: true, label: "dialog.subagents.status.interrupted", icon: "pause", tone: "text-text-weak" },
      unpaid: { owing: true, label: "dialog.subagents.status.unpaid", icon: "check", tone: "text-text-weak" },
      completed: {
        owing: false,
        label: "dialog.subagents.status.completed",
        icon: "circle-check",
        tone: "text-success",
      },
      failed: { owing: false, label: "dialog.subagents.status.failed", icon: "circle-x", tone: "text-error" },
      stopped: {
        owing: false,
        label: "dialog.subagents.status.stopped",
        icon: "circle-ban-sign",
        tone: "text-text-weak",
      },
    })
  })
})
