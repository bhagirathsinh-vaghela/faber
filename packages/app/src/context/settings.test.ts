import { describe, expect, test } from "bun:test"
import { migrateSettings } from "./settings"

describe("migrateSettings — default sounds", () => {
  test("a record on the old defaults moves to the new ones", () => {
    const migrated = migrateSettings({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03" },
    })
    expect(migrated).toEqual({ sounds: { agent: "yup-03", blocking: "alert-02", errors: "nope-03" } })
  })

  test("a chosen sound is kept", () => {
    const migrated = migrateSettings({ sounds: { agent: "yup-02", blocking: "alert-04", errors: "nope-01" } })
    expect(migrated).toEqual({ sounds: { agent: "yup-02", blocking: "alert-04", errors: "nope-01" } })
  })

  test("a record that already has the revision keeps the old sound it picked", () => {
    const migrated = migrateSettings({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03", revision: 1 },
    })
    expect(migrated).toEqual({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03", revision: 1 },
    })
  })

  test("a legacy `permissions` sound becomes the blocking sound before the default check", () => {
    const migrated = migrateSettings({ sounds: { agent: "yup-01", permissions: "staplebops-02" } })
    expect(migrated).toEqual({ sounds: { agent: "yup-01", blocking: "alert-02" } })
  })
})
