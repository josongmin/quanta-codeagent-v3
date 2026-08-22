import { describe, expect, test } from "bun:test"
import { osManagedSettingsPath } from "@/config"

// §P7 / ticket-05-③ — OS-managed-settings path enumeration. RCA: the host wired
// `managedPath: undefined`, so an org admin's machine-wide lockdown file was
// never read. This pins the per-OS convention + the override + fail-safe (always
// returns a path; a missing file simply contributes nothing). The override comes
// from `runtimeConfig().managedSettingsPath` (catalogued knob), not a raw env
// read in the pure fn (audit R3 — no orphan QUANTA_* read).

describe("osManagedSettingsPath", () => {
  test("darwin ⇒ /Library/Application Support/Quanta/managed-settings.json", () => {
    expect(osManagedSettingsPath("darwin")).toBe(
      "/Library/Application Support/Quanta/managed-settings.json",
    )
  })

  test("linux ⇒ /etc/quanta/managed-settings.json", () => {
    expect(osManagedSettingsPath("linux")).toBe("/etc/quanta/managed-settings.json")
  })

  test("win32 ⇒ %ProgramData%\\Quanta\\managed-settings.json (programData honored)", () => {
    expect(osManagedSettingsPath("win32", undefined, "D:\\PD")).toBe(
      "D:\\PD\\Quanta\\managed-settings.json",
    )
  })

  test("win32 with no programData ⇒ C:\\ProgramData default", () => {
    expect(osManagedSettingsPath("win32")).toBe("C:\\ProgramData\\Quanta\\managed-settings.json")
  })

  test("override wins on EVERY platform", () => {
    expect(osManagedSettingsPath("darwin", "/custom/managed.json")).toBe("/custom/managed.json")
    expect(osManagedSettingsPath("linux", "/custom/managed.json")).toBe("/custom/managed.json")
    expect(osManagedSettingsPath("win32", "/custom/managed.json", "D:\\PD")).toBe(
      "/custom/managed.json",
    )
  })

  test("blank/whitespace override is IGNORED (falls back to OS default)", () => {
    expect(osManagedSettingsPath("linux", "   ")).toBe("/etc/quanta/managed-settings.json")
  })

  test("unknown platform ⇒ unix /etc fallback (never undefined — fail-safe)", () => {
    expect(osManagedSettingsPath("freebsd" as NodeJS.Platform)).toBe(
      "/etc/quanta/managed-settings.json",
    )
  })
})
