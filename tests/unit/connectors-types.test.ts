/**
 * Connectors — type model + port compile assertions (ADR-0160 Phase A).
 *
 * These tests compile-check the closed unions + structural contracts so any
 * future widening of `SupportedAuth` or `RefreshOutcome` triggers a sweep.
 */

import { describe, expect, test } from "bun:test"
import {
  type AvailabilityVerdict,
  type Connector,
  createInMemoryConnectorRegistry,
  OAuthDiscoveryError,
  OAuthRegistrationError,
  type RefreshOutcome,
  type SupportedAuth,
  TokenRotationError,
} from "@/connectors"

describe("connectors / types", () => {
  test("UNIT-1: SupportedAuth closed union exhaustive switch", () => {
    const all: ReadonlyArray<SupportedAuth> = ["oauth", "none"]
    let seen = 0
    for (const v of all) {
      switch (v) {
        case "oauth":
          seen += 1
          break
        case "none":
          seen += 1
          break
      }
    }
    expect(seen).toBe(2)
  })

  test("UNIT-2: RefreshOutcome closed union exhaustive switch", () => {
    const all: ReadonlyArray<RefreshOutcome> = ["fresh", "cached-degraded", "cached-fresh"]
    let seen = 0
    for (const v of all) {
      switch (v) {
        case "fresh":
        case "cached-degraded":
        case "cached-fresh":
          seen += 1
          break
      }
    }
    expect(seen).toBe(3)
  })

  test("UNIT-3: AvailabilityVerdict closed union exhaustive switch", () => {
    const all: ReadonlyArray<AvailabilityVerdict> = ["ok", "dns-fail", "http-fail", "timeout"]
    let seen = 0
    for (const v of all) {
      switch (v) {
        case "ok":
        case "dns-fail":
        case "http-fail":
        case "timeout":
          seen += 1
          break
      }
    }
    expect(seen).toBe(4)
  })

  test("UNIT-4: Connector requires id/displayName/host/auth", async () => {
    // The object literal carries the type contract at compile time; route it
    // through the real in-memory registry so a regression in get()/list()
    // indexing (not a literal read-back tautology) is what's asserted.
    const c: Connector = {
      id: "x",
      displayName: "X",
      host: "h.example",
      auth: "none",
    }
    const reg = createInMemoryConnectorRegistry([c])
    const fetched = await reg.get("x")
    expect(fetched).toEqual(c)
    expect(await reg.list()).toEqual([c])
  })

  test("UNIT-5: Connector with auth=oauth carries issuer", () => {
    const c: Connector = {
      id: "github",
      displayName: "GitHub",
      host: "api.github.com",
      auth: "oauth",
      oauthIssuer: "https://github.com",
    }
    expect(c.oauthIssuer).toBe("https://github.com")
  })

  test("UNIT-6: OAuthDiscoveryError preserves typed code arm", () => {
    const e = new OAuthDiscoveryError("well-known-404", "nope")
    expect(e.code).toBe("well-known-404")
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("OAuthDiscoveryError")
  })

  test("UNIT-7: OAuthRegistrationError preserves typed code arm + cause", () => {
    const cause = new Error("upstream")
    const e = new OAuthRegistrationError("network-failed", "boom", { cause })
    expect(e.code).toBe("network-failed")
    expect(e.cause).toBe(cause)
  })

  test("UNIT-8: TokenRotationError covers all 3 error codes", () => {
    const a = new TokenRotationError("store-write-failed", "a")
    const b = new TokenRotationError("refresh-callback-failed", "b")
    const c = new TokenRotationError("missing-token", "c")
    expect([a.code, b.code, c.code]).toEqual([
      "store-write-failed",
      "refresh-callback-failed",
      "missing-token",
    ])
  })
})
