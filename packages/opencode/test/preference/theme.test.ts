import { afterEach, describe, expect, test } from "bun:test"
import { ThemePreference } from "../../src/preference/theme"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// The store is shared with every other test file in the run.
afterEach(() => Storage.remove(["preference", "themes"]))

// The shape the web client saves: separate block and inline code fonts.
const theme = {
  id: "t1",
  name: "Mine",
  baseId: "oc-1",
  fontSize: 13,
  font: "inter",
  codeBlockFont: "geist-mono",
  inlineCodeFont: "jetbrains-mono",
  codeTheme: "github-dark",
  diffTheme: "github-dark",
  fontWeight: 400,
  headingWeight: { "1": 700 },
  overrides: { light: {}, dark: {} },
}

describe("PUT /preference/themes", () => {
  test("a theme with split block and inline code fonts is saved with both", async () => {
    const response = await Server.App().request("/preference/themes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(theme),
    })
    expect(response.status).toBe(200)
    expect(await ThemePreference.list()).toEqual([theme])
  })

  test("a legacy theme carrying only codeFont is still accepted", async () => {
    const legacy = { ...theme, codeBlockFont: undefined, inlineCodeFont: undefined, codeFont: "geist-mono" }
    const response = await Server.App().request("/preference/themes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(legacy),
    })
    expect(response.status).toBe(200)
    expect(await ThemePreference.list()).toEqual([JSON.parse(JSON.stringify(legacy))])
  })
})
