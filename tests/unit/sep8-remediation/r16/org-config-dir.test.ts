import { describe, expect, test } from "bun:test"
import { defaultOrgConfigDir, resolveOrgConfigDir } from "@/runner/assemble/session-authorities"

describe("G-F11 org config dir resolution", () => {
  test("explicit null is opt-out even when env is set", () => {
    expect(resolveOrgConfigDir({ QUANTA_ORG_CONFIG_DIR: "/from-env" }, null)).toBeNull()
  })

  test("empty env override is opt-out", () => {
    expect(resolveOrgConfigDir({ QUANTA_ORG_CONFIG_DIR: "" })).toBeNull()
    expect(resolveOrgConfigDir({ QUANTA_ORG_CONFIG_DIR: "   " })).toBeNull()
  })

  test("explicit dir wins over env", () => {
    expect(resolveOrgConfigDir({ QUANTA_ORG_CONFIG_DIR: "/from-env" }, "/explicit")).toBe("/explicit")
  })

  test("env wins over platform default", () => {
    expect(resolveOrgConfigDir({ QUANTA_ORG_CONFIG_DIR: "/from-env" })).toBe("/from-env")
  })

  test("omitted explicit uses XDG default when env is unset", () => {
    expect(resolveOrgConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/quanta/org")
  })

  test("default is XDG/APPDATA org path, not quanta home", () => {
    const unix = defaultOrgConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")
    expect(unix).toBe("/xdg/quanta/org")
    const fallback = defaultOrgConfigDir({}, "/home/u")
    expect(fallback.endsWith("/.config/quanta/org")).toBe(true)
  })
})
