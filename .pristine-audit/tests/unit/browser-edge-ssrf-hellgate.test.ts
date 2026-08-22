/**
 * Hellgate — SSRF/IP-classifier EXTREME forms (ADR-0427).
 *
 * Pushes the structural classifier past the R1/R2 hellgate: octal/hex IPv4
 * (URL-normalized), every IPv6 loopback spelling, IPv4-mapped (dotted AND hex)
 * + IPv4-compat, link-local fe80::/10 and ULA fc00::/7 boundaries, zone-ids,
 * unspecified, CGNAT/172/192/169 CIDR fences, URL forms with port/userinfo,
 * uppercase hex, and name-vs-literal discrimination (punycode/empty/3-octet).
 *
 * Discipline: EVERY deny family ships a paired public/name CONTROL just outside
 * the boundary, so a `classifyHost` mutated to a constant (`return "deny"` or
 * `return null`) fails at least one half. Without the control each deny is
 * vacuous.
 */

import { describe, expect, test } from "bun:test"
import { classifyHost, isIpLiteral } from "@/shared/net/ssrf"

/** Pass a URL string through WHATWG normalization (what the nav-guard sees). */
const hostOf = (url: string): string => new URL(url).hostname

// ───────────────────────── octal / hex / decimal IPv4 (URL-normalized) ──────

describe("HELLGATE ssrf-edge — octal/hex/decimal IPv4 normalize then DENY", () => {
  // WHATWG URL collapses these to 127.0.0.1 BEFORE classifyHost ever sees them;
  // we assert the contract end-to-end (the normalization is load-bearing).
  const NORM_LOOPBACK: ReadonlyArray<[string, string]> = [
    ["octal 0177.0.0.1", "http://0177.0.0.1/"],
    ["mixed-octal/hex 0x7f.0.0.1", "http://0x7f.0.0.1/"],
    ["hex 0x7f000001", "http://0x7f000001/"],
    ["decimal 2130706433", "http://2130706433/"],
    ["short 127.1", "http://127.1/"],
  ]
  for (const [label, url] of NORM_LOOPBACK) {
    test(`DENY (normalized): ${label}`, () => {
      const h = hostOf(url)
      expect(h).toBe("127.0.0.1") // normalization is the precondition
      expect(classifyHost(h)).not.toBeNull()
    })
  }

  // CONTROL: octal/decimal that normalizes to a PUBLIC address must pass.
  test("ALLOW (normalized): octal 010.010.010.010 → 8.8.8.8 public", () => {
    const h = hostOf("http://0010.0010.0010.0010/")
    expect(h).toBe("8.8.8.8")
    expect(classifyHost(h)).toBeNull()
  })
  test("ALLOW (normalized): decimal 134744072 → 8.8.8.8 public", () => {
    const h = hostOf("http://134744072/")
    expect(h).toBe("8.8.8.8")
    expect(classifyHost(h)).toBeNull()
  })
})

// ───────────────────────── every IPv6 loopback spelling ─────────────────────

describe("HELLGATE ssrf-edge — IPv6 loopback every spelling DENIED", () => {
  const LOOPBACK = [
    "::1",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "[::1]", // bracketed (raw, defensive strip)
    hostOf("http://[0:0:0:0:0:0:0:1]/"), // → [::1] via URL
  ]
  for (const h of LOOPBACK) {
    test(`DENY loopback: ${JSON.stringify(h)}`, () => {
      expect(classifyHost(h)).not.toBeNull()
    })
  }
  // CONTROL: a full address ending in 1 but with a non-zero high hextet is NOT
  // ::1 loopback (the loopback check requires the leading seven hextets be 0).
  test("ALLOW: 2:0:0:0:0:0:0:1 is not ::1 loopback (public)", () => {
    expect(classifyHost("2:0:0:0:0:0:0:1")).toBeNull()
  })
})

// ───────────────────────── IPv4-mapped (dotted AND hex) + compat ────────────

describe("HELLGATE ssrf-edge — IPv4-mapped/compat embedded private DENIED", () => {
  const MAPPED_DENY: ReadonlyArray<[string, string]> = [
    ["mapped dotted ::ffff:127.0.0.1", "::ffff:127.0.0.1"],
    ["mapped hex ::ffff:7f00:1", "::ffff:7f00:1"],
    ["mapped UPPER ::FFFF:7F00:1", "::FFFF:7F00:1"],
    ["mapped metadata ::ffff:169.254.169.254", "::ffff:169.254.169.254"],
    ["compat ::127.0.0.1", "::127.0.0.1"],
    ["compat ::10.0.0.1", "::10.0.0.1"],
    ["compat ::169.254.169.254", "::169.254.169.254"],
  ]
  for (const [label, h] of MAPPED_DENY) {
    test(`DENY ${label}`, () => {
      expect(classifyHost(h)).not.toBeNull()
    })
  }

  // CONTROL: PUBLIC mapped address must pass in BOTH dotted and hex form.
  test("ALLOW mapped PUBLIC ::ffff:8.8.8.8 (dotted)", () => {
    expect(classifyHost("::ffff:8.8.8.8")).toBeNull()
  })
  test("ALLOW mapped PUBLIC ::ffff:808:808 (hex, URL-normalized 8.8.8.8)", () => {
    const h = hostOf("http://[::ffff:8.8.8.8]/")
    expect(h).toBe("[::ffff:808:808]")
    expect(classifyHost(h)).toBeNull()
  })
  test("ALLOW compat PUBLIC ::8.8.8.8", () => {
    expect(classifyHost("::8.8.8.8")).toBeNull()
  })
})

// ───────────────────────── link-local fe80::/10 boundaries ──────────────────

describe("HELLGATE ssrf-edge — link-local fe80::/10 DENY with fence controls", () => {
  // hostnames passed raw to classifyHost (it strips brackets/zone defensively);
  // WHATWG URL rejects a bracketed zone-id, so the nav-guard relies on this path.
  for (const h of ["fe80::1", "fe80::1234", "fe80::", "febf::1", "[fe80::1%eth0]"]) {
    test(`DENY link-local: ${h}`, () => {
      expect(classifyHost(h)).not.toBeNull()
    })
  }
  // fec0::/10 (deprecated site-local, RFC 3879) is DENIED, not public: it is
  // distinct from link-local fe80::/10 but the SSRF guard blocks it anyway
  // because it STILL routes internally on some networks (ssrf.ts hardening —
  // deny-more is the safe SSRF posture for an internal-ish deprecated range).
  test("DENY deprecated site-local — fec0::1 (RFC 3879, routes internally)", () => {
    expect(classifyHost("fec0::1")).not.toBeNull()
  })
  // CONTROL: fe00:: is just BELOW fe80::/10 and is NOT a special internal range —
  // it stays public (the guard does not over-block the boundary).
  test("ALLOW just-below fe80::/10 — fe00::1 public", () => {
    expect(classifyHost("fe00::1")).toBeNull()
  })
})

// ───────────────────────── ULA fc00::/7 (fc.. and fd..) ─────────────────────

describe("HELLGATE ssrf-edge — ULA fc00::/7 DENY with fence controls", () => {
  for (const h of ["fc00::1", "fd00::1", "fd12:3456::1", "fcff::1", "fdff:ffff::1"]) {
    test(`DENY ULA: ${h}`, () => {
      expect(classifyHost(h)).not.toBeNull()
    })
  }
  // CONTROL: fbff:: (just below) and fe00:: (just above fc00::/7) are public.
  test("ALLOW just-below fc00::/7 — fbff::1 public", () => {
    expect(classifyHost("fbff::1")).toBeNull()
  })
  test("ALLOW just-above fc00::/7 — fe00::1 public", () => {
    expect(classifyHost("fe00::1")).toBeNull()
  })
})

// ───────────────────────── zone-id / scope-id stripping ─────────────────────

describe("HELLGATE ssrf-edge — zone-id does not bypass", () => {
  test("fe80::1%eth0 still link-local", () => {
    expect(classifyHost("fe80::1%eth0")).not.toBeNull()
  })
  test("[::1%lo0] still loopback", () => {
    expect(classifyHost("[::1%lo0]")).not.toBeNull()
  })
  // CONTROL: a public address with a zone id must STILL be allowed (the strip
  // is not a blanket deny).
  test("ALLOW: 2606:2800::1%eth0 public with zone", () => {
    expect(classifyHost("2606:2800::1%eth0")).toBeNull()
  })
})

// ───────────────────────── unspecified ──────────────────────────────────────

describe("HELLGATE ssrf-edge — unspecified DENIED", () => {
  for (const h of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"]) {
    test(`DENY unspecified: ${JSON.stringify(h)}`, () => {
      expect(classifyHost(h)).not.toBeNull()
    })
  }
  // CONTROL: 0.0.0.1 is 0/8 (still denied) — but 1.0.0.0 is public.
  test("ALLOW: 1.0.0.0 public (not 0/8)", () => {
    expect(classifyHost("1.0.0.0")).toBeNull()
  })
})

// ───────────────────────── CGNAT 100.64/10 boundary trio ────────────────────

describe("HELLGATE ssrf-edge — CGNAT 100.64/10 exact boundaries", () => {
  test("ALLOW 100.63.x public (just below)", () => {
    expect(classifyHost("100.63.255.255")).toBeNull()
  })
  test("DENY 100.64.x CGNAT (lower bound)", () => {
    expect(classifyHost("100.64.0.0")).not.toBeNull()
  })
  test("DENY 100.127.x CGNAT (upper bound)", () => {
    expect(classifyHost("100.127.255.255")).not.toBeNull()
  })
  test("ALLOW 100.128.x public (just above)", () => {
    expect(classifyHost("100.128.0.0")).toBeNull()
  })
})

// ───────────────────────── 172.16/12 boundary trio ──────────────────────────

describe("HELLGATE ssrf-edge — 172.16/12 exact boundaries", () => {
  test("ALLOW 172.15.x public (just below)", () => {
    expect(classifyHost("172.15.255.255")).toBeNull()
  })
  test("DENY 172.16.x private (lower)", () => {
    expect(classifyHost("172.16.0.0")).not.toBeNull()
  })
  test("DENY 172.31.x private (upper)", () => {
    expect(classifyHost("172.31.255.255")).not.toBeNull()
  })
  test("ALLOW 172.32.x public (just above)", () => {
    expect(classifyHost("172.32.0.0")).toBeNull()
  })
})

// ───────────────────────── 192.168/16 + 169.254/16 fences ───────────────────

describe("HELLGATE ssrf-edge — 192.168 and 169.254 fences", () => {
  test("ALLOW 192.167.x public", () => {
    expect(classifyHost("192.167.255.255")).toBeNull()
  })
  test("DENY 192.168.x private", () => {
    expect(classifyHost("192.168.0.0")).not.toBeNull()
  })
  test("ALLOW 169.253.x public", () => {
    expect(classifyHost("169.253.255.255")).toBeNull()
  })
  test("DENY 169.254.x link-local (incl metadata 169.254.169.254)", () => {
    expect(classifyHost("169.254.169.254")).not.toBeNull()
  })
})

// ───────────────────────── URL forms: port / userinfo / brackets ────────────

describe("HELLGATE ssrf-edge — URL port/userinfo do not change the verdict", () => {
  test("DENY https://127.0.0.1:8080/ (port stripped from hostname)", () => {
    expect(classifyHost(hostOf("https://127.0.0.1:8080/"))).not.toBeNull()
  })
  test("DENY https://user@10.0.0.1/ (userinfo stripped)", () => {
    expect(classifyHost(hostOf("https://user:pw@10.0.0.1/"))).not.toBeNull()
  })
  // CONTROL: public IP with port + userinfo still allowed.
  test("ALLOW https://user@8.8.8.8:443/ public", () => {
    expect(classifyHost(hostOf("https://user@8.8.8.8:443/"))).toBeNull()
  })
})

// ───────────────────────── uppercase hex IPv6 normalization ─────────────────

describe("HELLGATE ssrf-edge — uppercase hex IPv6 is case-folded", () => {
  test("DENY [FE80::1] (upper) link-local", () => {
    expect(classifyHost("[FE80::1]")).not.toBeNull()
  })
  test("DENY ::FFFF:7F00:1 (upper) mapped loopback", () => {
    expect(classifyHost("::FFFF:7F00:1")).not.toBeNull()
  })
  // CONTROL: uppercase public IPv6 stays allowed.
  test("ALLOW [2606:2800:220:1::1] public (any case)", () => {
    expect(classifyHost("[2606:2800:220:1::1]")).toBeNull()
  })
})

// ───────────────────────── names vs literals (allowed=null) ─────────────────

describe("HELLGATE ssrf-edge — DNS names classify as null (need resolution)", () => {
  const NAMES = [
    "example.com",
    "internal-but-public.example",
    "xn--fsq.com", // punycode (例え) — a NAME, not a literal
    hostOf("http://例え.com/"), // unicode host → xn-- punycode name
    "", // empty host — a degenerate name, not a literal
    "1.2.3", // 3 octets — NOT a v4 literal, treated as a name
    "1.2.3.4.5", // 5 octets — not a literal
    "999.1.1.1", // octet > 255 — not a literal
    "2606:2800:220:1::1", // PUBLIC literal — also null (allowed)
  ]
  for (const h of NAMES) {
    test(`ALLOW/null: ${JSON.stringify(h)}`, () => {
      expect(classifyHost(h)).toBeNull()
    })
  }
  // DISCRIMINATOR: localhost (a NAME) is the one name that IS denied — proves
  // the null-for-names path is not a blanket "names always pass" constant.
  test("DENY: localhost name is special-cased", () => {
    expect(classifyHost("localhost")).not.toBeNull()
    expect(classifyHost("sub.localhost")).not.toBeNull()
  })

  // BUG: trailing-dot `localhost.` is a real loopback alias (the DNS root form
  // resolves to 127.0.0.1 on every resolver) but classifyHost normalizes only
  // case/brackets/zone and matches `=== "localhost"` / `.endsWith(".localhost")`,
  // neither of which the FQDN-dotted "localhost." satisfies — so it is ALLOWED.
  // src/shared/net/ssrf.ts:137. The fence should strip a single trailing dot
  // before the localhost check (and ".localhost." likewise).
  test("DENY: trailing-dot localhost. (loopback alias) — currently bypasses", () => {
    expect(classifyHost("localhost.")).not.toBeNull()
  })
})

// ───────────────────────── isIpLiteral name/literal discrimination ──────────

describe("HELLGATE ssrf-edge — isIpLiteral discriminator", () => {
  test("literals are literals", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true)
    expect(isIpLiteral("8.8.8.8")).toBe(true)
    expect(isIpLiteral("[::1]")).toBe(true)
    expect(isIpLiteral("fe80::1%eth0")).toBe(true)
    expect(isIpLiteral("::ffff:7f00:1")).toBe(true)
  })
  test("names are not literals", () => {
    expect(isIpLiteral("example.com")).toBe(false)
    expect(isIpLiteral("localhost")).toBe(false)
    expect(isIpLiteral("xn--fsq.com")).toBe(false)
    expect(isIpLiteral("1.2.3")).toBe(false) // 3 octets
    expect(isIpLiteral("")).toBe(false)
  })
})
