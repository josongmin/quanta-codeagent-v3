/**
 * Hellgate — canonical SSRF host classifier (ADR-0427 R1 audit [15][26]).
 *
 * Proves the STRUCTURAL classifier closes the prefix-match bypasses: IPv4-mapped
 * IPv6 (`::ffff:127.0.0.1` → `::ffff:7f00:1`), bare `::1`, link-local, ULA, and
 * decimal/hex IPv4 (which WHATWG URL normalizes). Control = public IPs/names
 * pass (null); adversarial = every private/loopback form denied. Without a
 * matching public control each deny is vacuous, so both halves are asserted.
 */

import { describe, expect, test } from "bun:test"
import { classifyHost, isIpLiteral } from "@/shared/net/ssrf"

const hostOf = (url: string): string => new URL(url).hostname

describe("HELLGATE ssrf — private/loopback DENIED across all forms", () => {
  const DENY: ReadonlyArray<[string, string]> = [
    ["localhost", "localhost"],
    ["sub.localhost", "sub.localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.1", "http://127.1/"], // URL-normalized → 127.0.0.1
    ["decimal 2130706433", "http://2130706433/"], // → 127.0.0.1
    ["hex 0x7f000001", "http://0x7f000001/"], // → 127.0.0.1
    ["10.0.0.5", "10.0.0.5"],
    ["172.16.0.1", "172.16.0.1"],
    ["172.31.255.255", "172.31.255.255"],
    ["192.168.1.1", "192.168.1.1"],
    ["169.254.169.254", "169.254.169.254"], // cloud metadata
    ["0.0.0.0", "0.0.0.0"],
    ["100.64.0.1", "100.64.0.1"], // CGNAT
    ["[::1]", "[::1]"],
    ["[::]", "[::]"],
    ["[::ffff:127.0.0.1]", "http://[::ffff:127.0.0.1]/"], // IPv4-mapped → hex form
    ["[::ffff:169.254.169.254]", "http://[::ffff:169.254.169.254]/"],
    ["[fe80::1]", "[fe80::1]"], // link-local
    ["[fc00::1]", "[fc00::1]"], // ULA
    ["[fd12:3456::1]", "[fd12:3456::1]"], // ULA
  ]
  for (const [label, input] of DENY) {
    test(`DENY: ${label}`, () => {
      const host = input.startsWith("http") ? hostOf(input) : input
      expect(classifyHost(host)).not.toBeNull()
    })
  }
})

describe("HELLGATE ssrf — public hosts ALLOWED (control / discriminator)", () => {
  const ALLOW = [
    "93.184.216.34", // example.com
    "8.8.8.8",
    "172.32.0.1", // just outside 172.16/12
    "192.169.0.1", // just outside 192.168/16
    "169.253.0.1", // just outside 169.254/16
    "100.128.0.1", // just outside 100.64/10
    "[2606:2800:220:1::1]", // public IPv6
    "[::ffff:93.184.216.34]", // IPv4-mapped PUBLIC ⇒ allowed
    "example.com", // DNS name — null (resolved separately)
    "internal-but-public.example", // DNS name — null
  ]
  for (const host of ALLOW) {
    test(`ALLOW: ${host}`, () => {
      expect(classifyHost(host)).toBeNull()
    })
  }
})

describe("HELLGATE ssrf — IPv4-compat + zone-id (R2 [13][15])", () => {
  // ::a.b.c.d (IPv4-compat) embedded private addresses — was an unexercised branch
  for (const h of ["[::127.0.0.1]", "[::169.254.169.254]", "[::10.0.0.1]"]) {
    test(`DENY compat: ${h}`, () => {
      expect(classifyHost(new URL(`http://${h}/`).hostname)).not.toBeNull()
    })
  }
  test("IPv6 zone-id does not bypass (fe80::1%eth0 still link-local)", () => {
    expect(classifyHost("fe80::1%eth0")).not.toBeNull()
    expect(classifyHost("[::1%lo0]")).not.toBeNull()
  })
})

describe("HELLGATE ssrf — isIpLiteral discriminates names from literals", () => {
  test("IP literals", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true)
    expect(isIpLiteral("[::1]")).toBe(true)
    expect(isIpLiteral("8.8.8.8")).toBe(true)
  })
  test("DNS names are not literals", () => {
    expect(isIpLiteral("example.com")).toBe(false)
    expect(isIpLiteral("localhost")).toBe(false)
    expect(isIpLiteral("1.2.3")).toBe(false) // not 4 octets
  })
})
