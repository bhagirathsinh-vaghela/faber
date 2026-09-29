import { describe, expect, test } from "bun:test"
import { fallback } from "../context/i18n"
import { LaunchCard } from "./launch-card"

// The agent tool's metadata for one call, minus `mode`. The card takes nothing
// else, so the output text the model reads cannot reach it.
const metadata: LaunchCard.Launch = {
  description: "count files",
  summary: "count the files in src",
  subagentType: "explore",
  includeContext: true,
  toolset: "explore",
  tools: ["read", "grep"],
}

describe("the launcher card", () => {
  test.each([
    ["launched", "subagent · count files · Launched"],
    ["steered", "subagent · count files · Steered"],
    ["continued", "subagent · count files · Continued"],
  ])("%s shows the same fields under its own title", (mode, title) => {
    const launch = { ...metadata, mode }
    expect(LaunchCard.title(fallback.t, launch)).toBe(title)
    expect(LaunchCard.fields(fallback.t, launch)).toBe(
      [
        "**Description** count files",
        "**Summary** count the files in src",
        "**Parent context** Included",
        "**Subagent** `explore`",
        "**Toolset** `explore`: `read` `grep`",
      ].join("\n\n"),
    )
  })

  test("a part without mode is titled as a launch", () => {
    expect(LaunchCard.title(fallback.t, metadata)).toBe("subagent · count files · Launched")
  })
})
