/**
 * §2.5 — marketplace.json install/auth POLICY gating.
 *
 * SOTA mechanism (Claude Code managed-settings `strictKnownMarketplaces` +
 * blocklist): an enterprise policy may declare a STRICT allowlist of marketplace
 * sources (ONLY these exact sources may be added) and/or a BLOCKLIST (these exact
 * sources are blocked). The check happens BEFORE download, so a blocked source
 * NEVER touches the filesystem. Policy scope only.
 *
 * This slice is the PURE policy decision — `checkMarketplaceSource(source,
 * policy)` returns a typed verdict (`allow` | `block` with reason). NO I/O.
 * Default-OFF: `QUANTA_MARKETPLACE_POLICY` unset ⇒ `enforceMarketplacePolicy`
 * returns `allow` for everything (byte-identical — no gating).
 */
import { describe, expect, test } from "bun:test"
import {
  checkMarketplaceSource,
  enforceMarketplacePolicy,
  type MarketplacePolicy,
} from "../../src/connectors/marketplace-policy"

const STRICT: MarketplacePolicy = {
  strictKnownSources: ["https://github.com/acme/official", "https://github.com/acme/internal"],
}
const BLOCK: MarketplacePolicy = {
  blockedSources: ["https://evil.example.com/m", "git@github.com:bad/repo.git"],
}

describe("§2.5 checkMarketplaceSource — pure policy decision", () => {
  test("empty policy ⇒ allow (no constraints)", () => {
    expect(checkMarketplaceSource("https://x/y", {})).toEqual({ kind: "allow" })
  })

  test("strict allowlist: an exact-match source is allowed", () => {
    expect(checkMarketplaceSource("https://github.com/acme/official", STRICT)).toEqual({
      kind: "allow",
    })
  })

  test("strict allowlist: a non-listed source is blocked (reason=not-allowlisted)", () => {
    const r = checkMarketplaceSource("https://github.com/rando/x", STRICT)
    expect(r.kind).toBe("block")
    if (r.kind === "block") expect(r.reason).toBe("not-allowlisted")
  })

  test("blocklist: a blocked source is blocked (reason=blocklisted)", () => {
    const r = checkMarketplaceSource("https://evil.example.com/m", BLOCK)
    expect(r.kind).toBe("block")
    if (r.kind === "block") expect(r.reason).toBe("blocklisted")
  })

  test("blocklist: a non-blocked source is allowed", () => {
    expect(checkMarketplaceSource("https://ok.example.com/m", BLOCK)).toEqual({ kind: "allow" })
  })

  test("blocklist takes precedence over allowlist (a source in BOTH is blocked)", () => {
    const policy: MarketplacePolicy = {
      strictKnownSources: ["https://github.com/acme/x"],
      blockedSources: ["https://github.com/acme/x"],
    }
    const r = checkMarketplaceSource("https://github.com/acme/x", policy)
    expect(r.kind).toBe("block")
    if (r.kind === "block") expect(r.reason).toBe("blocklisted")
  })

  test("source comparison is EXACT (a prefix of an allowlisted source is NOT allowed)", () => {
    const r = checkMarketplaceSource("https://github.com/acme/official-evil", STRICT)
    expect(r.kind).toBe("block")
  })

  test("source comparison trims surrounding whitespace before matching", () => {
    expect(checkMarketplaceSource("  https://github.com/acme/official  ", STRICT)).toEqual({
      kind: "allow",
    })
  })
})

describe("§2.5 enforceMarketplacePolicy — default-OFF gate", () => {
  test("BYTE-IDENTITY: gate OFF ⇒ allow everything (policy ignored)", () => {
    const orig = process.env.QUANTA_MARKETPLACE_POLICY
    delete process.env.QUANTA_MARKETPLACE_POLICY
    try {
      // even a source on the blocklist is allowed when the gate is off.
      expect(enforceMarketplacePolicy("https://evil.example.com/m", BLOCK)).toEqual({
        kind: "allow",
      })
    } finally {
      if (orig !== undefined) process.env.QUANTA_MARKETPLACE_POLICY = orig
    }
  })

  test("RED-ON-INJECTION: gate ON ⇒ a blocked source is blocked BEFORE any download", () => {
    process.env.QUANTA_MARKETPLACE_POLICY = "1"
    try {
      const r = enforceMarketplacePolicy("https://evil.example.com/m", BLOCK)
      expect(r.kind).toBe("block")
      if (r.kind === "block") expect(r.reason).toBe("blocklisted")
    } finally {
      delete process.env.QUANTA_MARKETPLACE_POLICY
    }
  })

  test("gate ON ⇒ a non-allowlisted source is blocked under a strict allowlist", () => {
    process.env.QUANTA_MARKETPLACE_POLICY = "1"
    try {
      expect(enforceMarketplacePolicy("https://github.com/rando/x", STRICT).kind).toBe("block")
      expect(enforceMarketplacePolicy("https://github.com/acme/official", STRICT).kind).toBe(
        "allow",
      )
    } finally {
      delete process.env.QUANTA_MARKETPLACE_POLICY
    }
  })
})
