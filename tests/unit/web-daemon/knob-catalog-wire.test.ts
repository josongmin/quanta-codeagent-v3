/**
 * Web-daemon knob catalog wire (ADR-0503 P3) — composes inventory + runner for
 * the `/api/knobs` settings endpoint, WITHOUT cli-render knobs (peer surface).
 */

import { describe, expect, test } from "bun:test"
import { buildWebKnobCatalog, webSafeKnobValue } from "@/apps/web-daemon/knob-catalog-wire"

describe("web knob catalog (ADR-0503 P3)", () => {
  test("includes inventory + runner knobs, EXCLUDES cli-render knobs", () => {
    const cat = buildWebKnobCatalog()
    expect(cat.size).toBeGreaterThan(150) // inventory(~150) + runner(~49) minus dups
    // inventory daemon knob present
    expect(cat.has("QUANTA_WEB_PORT")).toBe(true)
    expect(cat.get("QUANTA_WEB_PORT")?.home).toBe("runtime-config")
    // runner knob present (side-effect registration worked)
    expect([...cat.values()].some((k) => k.home === "runner-knobs")).toBe(true)
    // CLI-render knob ABSENT (cli sources intentionally empty)
    expect(cat.has("QUANTA_PILLS")).toBe(false)
    expect(cat.has("QUANTA_STATUSBAR")).toBe(false)
    expect([...cat.values()].some((k) => k.home === "cli")).toBe(false)
  })

  test("webSafeKnobValue redacts CUSTOM string values (paths/commands/policy)", () => {
    // string + non-default (env/session) ⇒ redacted (would leak path/command/JSON)
    expect(webSafeKnobValue("string", { raw: "/Users/jo/.quanta", source: "env" })).toBe("[redacted]")
    expect(webSafeKnobValue("string", { raw: "aws-vault exec p --", source: "session" })).toBe("[redacted]")
    // string DEFAULT is public (lives in source) ⇒ shown
    expect(webSafeKnobValue("string", { raw: "info", source: "default" })).toBe("info")
    // bounded kinds are safe ⇒ always shown
    expect(webSafeKnobValue("bool", { raw: "true", source: "env" })).toBe("true")
    expect(webSafeKnobValue("int", { raw: "5000", source: "env" })).toBe("5000")
    expect(webSafeKnobValue("enum", { raw: "high", source: "env" })).toBe("high")
    // unset ⇒ undefined
    expect(webSafeKnobValue("string", undefined)).toBeUndefined()
  })

  test("never exposes secrets (excluded from inventory by construction)", () => {
    const cat = buildWebKnobCatalog()
    for (const secret of [
      "QUANTA_WEB_AUTH_TOKEN",
      "QUANTA_LANCE_API_KEY",
      "QUANTA_QDRANT_API_KEY",
      "QUANTA_CHATGPT_AUTH_SOURCE",
    ]) {
      expect(cat.has(secret)).toBe(false)
    }
  })
})
