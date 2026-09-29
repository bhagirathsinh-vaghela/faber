// The agent tool's launcher card, built only from the call's structured
// metadata. The tool's output text is written for the model and changes with
// its wording; the card never reads it.
//
// Pure string work, in its own module so a test can reach it headless (the
// renderer pulls in the markdown stack, which needs a DOM).

import type { UiI18n } from "../context/i18n"

export namespace LaunchCard {
  export type Launch = {
    mode?: string
    description?: string
    summary?: string
    subagentType?: string
    includeContext?: boolean
    toolset?: string
    tools?: string[]
  }

  // A call from before `mode` existed was always a launch.
  const KEY = {
    launched: "ui.tool.subagent.box.launched",
    steered: "ui.tool.subagent.box.steered",
    continued: "ui.tool.subagent.box.continued",
  } as const

  // The subagent's identifier shown on BOTH its launch card and its result card
  // so the two read as one pair, capped so a long description cannot blow out
  // the header.
  export function label(description: string): string {
    const words = description.trim().split(/\s+/)
    if (words.length <= 5) return words.join(" ")
    return words.slice(0, 5).join(" ") + "\u2026"
  }

  export function title(t: UiI18n["t"], launch: Launch): string {
    const key = KEY[launch.mode as keyof typeof KEY] ?? KEY.launched
    return t(key, { label: label(launch.description ?? "") })
  }

  // One markdown block so it themes like the rest of the UI: bold labels, code
  // pills. Description repeats the header's label so summaryOnly can hide the
  // header subtitle on expand without losing it.
  export function fields(t: UiI18n["t"], launch: Launch): string {
    const tools = launch.tools?.length ? `: ${launch.tools.map((tool) => `\`${tool}\``).join(" ")}` : ""
    return [
      launch.description && `**${t("ui.tool.subagent.label.description")}** ${launch.description}`,
      launch.summary && `**${t("ui.tool.subagent.label.summary")}** ${launch.summary}`,
      `**${t("ui.tool.subagent.label.context")}** ${t(launch.includeContext ? "ui.tool.subagent.context.inherited" : "ui.tool.subagent.context.fresh")}`,
      launch.subagentType && `**${t("ui.tool.subagent.label.agent")}** \`${launch.subagentType}\``,
      launch.toolset && `**${t("ui.tool.subagent.label.toolset")}** \`${launch.toolset}\`${tools}`,
    ]
      .filter((line): line is string => !!line)
      .join("\n\n")
  }
}
