/**
 * GET /api/knobs NO-LEAK RATCHET (ADR-0503 P3 security lock, jun-7 re-audit).
 *
 * The web settings endpoint serves the unified catalog WITH current values. A
 * CUSTOM free-form STRING value can hold a filesystem path, a credential-helper
 * command line, or policy JSON — none of which may cross the network. This locks
 * the `webSafeKnobValue` redaction so a regression (serving raw `.raw`) fails
 * CI, AND statically asserts the endpoint actually ROUTES through the helper.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CONFIG_ALLOWED_KEYS } from "@/apps/web-daemon/server"
import {
  buildWebKnobCatalog,
  resolveCatalogValues,
  webSafeKnobValue,
} from "@/apps/web-daemon/knob-catalog-wire"
import { isSessionForbidden } from "@/shared"

describe("GET /api/knobs never leaks custom string values (ADR-0503 security)", () => {
  test("redaction: no custom string value survives, across the FULL catalog", () => {
    const catalog = buildKnobCatalogForLeakTest()
    // synthetic env: stuff sensitive values into every string knob
    const SECRET = "/Users/victim/.secret/cmd --token=ABC123"
    const env: Record<string, string> = {}
    for (const k of catalog.values()) {
      if (k.kind === "string") env[k.envKey] = SECRET
    }
    const resolved = resolveCatalogValues(catalog, env)
    for (const k of catalog.values()) {
      const served = webSafeKnobValue(k.kind, resolved.get(k.envKey))
      // the secret must NEVER appear in a served value
      expect(served).not.toBe(SECRET)
      if (k.kind === "string") expect(served).toBe("[redacted]")
    }
  })

  test("bounded kinds + public defaults are still shown (usability preserved)", () => {
    expect(webSafeKnobValue("bool", { raw: "true", source: "env" })).toBe("true")
    expect(webSafeKnobValue("int", { raw: "5000", source: "env" })).toBe("5000")
    expect(webSafeKnobValue("enum", { raw: "high", source: "env" })).toBe("high")
    expect(webSafeKnobValue("string", { raw: "info", source: "default" })).toBe("info")
  })

  test("red-on-injection: a string env/session value is ALWAYS redacted", () => {
    expect(webSafeKnobValue("string", { raw: "anything", source: "env" })).toBe("[redacted]")
    expect(webSafeKnobValue("string", { raw: "x", source: "session" })).toBe("[redacted]")
  })

  test("static lock: the /api/knobs handler ROUTES values through webSafeKnobValue", () => {
    const server = readFileSync("src/apps/web-daemon/server.ts", "utf8")
    const idx = server.indexOf('"/api/knobs"')
    expect(idx).toBeGreaterThan(0)
    // within the handler block, the value field must go through the redactor —
    // a regression to `value: current.get(...)?.raw` would drop this reference.
    const block = server.slice(idx, idx + 1200)
    expect(block).toContain("webSafeKnobValue")
    expect(block).not.toMatch(/value:\s*current\.get\([^)]*\)\?\.raw/)
  })
})

// local helper so the import list stays minimal
function buildKnobCatalogForLeakTest() {
  return buildWebKnobCatalog()
}

describe("POST /config write-allowlist never overlaps the security carve-out (R2 hardening)", () => {
  test("CONFIG_ALLOWED_KEYS ∩ SESSION_FORBIDDEN_KNOBS = ∅ (no strict knob is web-writable)", () => {
    // The /config writer mutates process.env directly (bypassing setKnobOverride),
    // so a strict-security knob in the write allowlist would be armable via an
    // authed HTTP POST. This pins the invariant that the two sets stay disjoint;
    // handleConfigPost ALSO rejects isSessionForbidden(key) at runtime (belt+suspenders).
    const overlap = [...CONFIG_ALLOWED_KEYS].filter((k) => isSessionForbidden(k))
    expect(overlap).toEqual([])
  })
})
