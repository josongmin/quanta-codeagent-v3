/**
 * SSRF guard + amendment + decision — pure-logic unit coverage (ADR-0428).
 * Hellgate-style adversarial inputs for the security boundary.
 */

import { describe, expect, test } from "bun:test"
import { decideEgress, NetworkPolicyAmendment } from "@/../src/runtime/network-proxy"

// SSRF coverage is asserted THROUGH `decideEgress` (the real proxy surface):
// every blocked literal is ALSO put in the allowlist, proving the SSRF guard
// fires BEFORE the allow check — an allowlisted address can never reach an
// internal target. Structural classification itself is owned + unit-tested by
// the canonical `@/shared/net/ssrf` module (de-triplicated in ADR-0427).
const amendments = new NetworkPolicyAmendment()
const isDenied = (host: string): boolean =>
  decideEgress({ host, allowlist: [host], amendments }).decision === "deny"
const isAllowed = (host: string): boolean =>
  decideEgress({ host, allowlist: [host], amendments }).decision === "allow"

describe("decideEgress SSRF — blocked even when allowlisted by literal (IPv4)", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "169.254.0.1",
    "0.0.0.0",
    "100.64.0.1",
  ]
  for (const ip of blocked) {
    test(`blocks ${ip}`, () => expect(isDenied(ip)).toBe(true))
  }

  const routable = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "100.63.0.1"]
  for (const ip of routable) {
    test(`permits routable ${ip}`, () => expect(isAllowed(ip)).toBe(true))
  }
})

describe("decideEgress SSRF — IPv6 + edge cases", () => {
  test("loopback ::1", () => expect(isDenied("::1")).toBe(true))
  test("unspecified ::", () => expect(isDenied("::")).toBe(true))
  test("link-local fe80::", () => expect(isDenied("fe80::1")).toBe(true))
  test("unique-local fd00::", () => expect(isDenied("fd00::1")).toBe(true))
  test("ipv4-mapped metadata", () => expect(isDenied("::ffff:169.254.169.254")).toBe(true))
  test("localhost name denied", () => expect(isDenied("localhost")).toBe(true))
  test("routable v6 permitted", () => expect(isAllowed("2606:4700::1")).toBe(true))
})

describe("NetworkPolicyAmendment — scoped + revocable", () => {
  test("amend then lookup hit", () => {
    const a = new NetworkPolicyAmendment(() => 100)
    a.amend({ host: "X.Example.com", scope: "s1" })
    expect(a.isAmended("x.example.com")).toBe(true)
    expect(a.lookup("x.example.com")?.at).toBe(100)
  })

  test("wildcard amendment covers subdomains, not apex", () => {
    const a = new NetworkPolicyAmendment()
    a.amend({ host: "*.corp.test", scope: "s1" })
    expect(a.isAmended("api.corp.test")).toBe(true)
    expect(a.isAmended("corp.test")).toBe(false)
  })

  test("revoke single", () => {
    const a = new NetworkPolicyAmendment()
    a.amend({ host: "h.test", scope: "s1" })
    expect(a.revoke("h.test")).toBe(true)
    expect(a.isAmended("h.test")).toBe(false)
  })

  test("revokeScope batch", () => {
    const a = new NetworkPolicyAmendment()
    a.amend({ host: "a.test", scope: "s1" })
    a.amend({ host: "b.test", scope: "s1" })
    a.amend({ host: "c.test", scope: "s2" })
    expect(a.revokeScope("s1")).toBe(2)
    expect(a.isAmended("a.test")).toBe(false)
    expect(a.isAmended("c.test")).toBe(true)
  })
})

describe("decideEgress — order is SSRF → base → amend → deny", () => {
  test("SSRF beats allowlist (allowlisted name pointing at IMDS literal)", () => {
    const d = decideEgress({ host: "169.254.169.254", allowlist: ["169.254.169.254"], amendments })
    expect(d.decision).toBe("deny")
    expect(d.reason.toLowerCase()).toContain("metadata")
  })

  test("base allowlist allow", () => {
    const d = decideEgress({ host: "api.github.com", allowlist: ["api.github.com"], amendments })
    expect(d.decision).toBe("allow")
  })

  test("amended-allow when not in base", () => {
    const a = new NetworkPolicyAmendment()
    a.amend({ host: "late.test", scope: "s1" })
    const d = decideEgress({ host: "late.test", allowlist: [], amendments: a })
    expect(d.decision).toBe("amended-allow")
  })

  test("deny fail-closed", () => {
    const d = decideEgress({ host: "evil.test", allowlist: [], amendments })
    expect(d.decision).toBe("deny")
  })

  test("loopback literal blocked even if allowlisted", () => {
    const d = decideEgress({ host: "127.0.0.1", allowlist: ["127.0.0.1"], amendments })
    expect(d.decision).toBe("deny")
    expect(d.reason.toLowerCase()).toContain("ssrf")
  })
})
