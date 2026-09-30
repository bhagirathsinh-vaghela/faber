import { describe, expect, test } from "bun:test"
import { migrateSettings } from "./settings"

describe("migrateSettings — default sounds", () => {
  test("a record on the oldest defaults moves to the current ones", () => {
    const migrated = migrateSettings({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03" },
    })
    expect(migrated).toEqual({ sounds: { agent: "yup-03", blocking: "alert-02", errors: "nope-05", revision: 2 } })
  })

  test("a record already on revision 1 moves only its error sound", () => {
    const migrated = migrateSettings({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03", revision: 1 },
    })
    expect(migrated).toEqual({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-05", revision: 2 },
    })
  })

  test("a chosen sound is kept", () => {
    const migrated = migrateSettings({ sounds: { agent: "yup-02", blocking: "alert-04", errors: "nope-01" } })
    expect(migrated).toEqual({ sounds: { agent: "yup-02", blocking: "alert-04", errors: "nope-01", revision: 2 } })
  })

  test("a record on the current revision keeps the old sounds it picked", () => {
    const migrated = migrateSettings({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03", revision: 2 },
    })
    expect(migrated).toEqual({
      sounds: { agent: "staplebops-01", blocking: "staplebops-02", errors: "nope-03", revision: 2 },
    })
  })

  test("a legacy `permissions` sound becomes the blocking sound before the default check", () => {
    const migrated = migrateSettings({ sounds: { agent: "yup-01", permissions: "staplebops-02" } })
    expect(migrated).toEqual({ sounds: { agent: "yup-01", blocking: "alert-02", revision: 2 } })
  })
})
