/**
 * Hellgate — SSRF / network-egress DEEP security audit (ROUND 6).
 *
 * The NETWORK foundation: every tool that fetches an attacker/model-influenced
 * URL (`web_fetch`, `read_image_url`) and the shared egress guard
 * (`@/shared/net/ssrf`, which the network-proxy slice also delegates to) MUST
 * block SSRF to private / loopback / link-local / cloud-metadata endpoints.
 *
 * This battery adversarially exercises the SIX SSRF attack classes end to end.
 * Every assertion is hermetic: an injected fetcher + injected DNS resolver mean
 * NO real network is touched. Each "must block" case is paired with a control
 * proving a LEGITIMATE public fetch still succeeds (the deny is not vacuous).
 *
 * R6 REAL BUG FOUND + FIXED (see classifyV6 / embeddedV4Verdict in ssrf.ts):
 *   IPv6→IPv4 *transition wrappers* that embed a private IPv4 address were
 *   classified ALLOWED — `[64:ff9b::a9fe:a9fe]` (NAT64 → 169.254.169.254
 *   metadata), `[2002:7f00:1::]` (6to4 → 127.0.0.0/8), `[::ffff:0:7f00:1]`
 *   (IPv4-translated → loopback), and deprecated site-local `[fec0::1]`. On a
 *   NAT64/6to4-enabled host (and an attacker-controlled AAAA record) these route
 *   straight to an internal service. Now each transition wrapper is decoded to
 *   its embedded v4 octets and run through the SAME private/loopback/link-local
 *   classifier. Class-1/2 (mapped/compat/decimal/hex/octal) and redirect/rebind
 *   were sealed by prior rounds — re-pinned here so a regression cannot land
 *   silently while this surface is being extended.
 */

import { describe, expect, test } from "bun:test"
import {
  classifyHost,
  fetchWithSsrfGuard,
  type HostResolver,
  isIpLiteral,
  SSRF_MAX_REDIRECTS,
  SsrfGuardError,
  ssrfDeny,
} from "@/shared/net/ssrf"
import { readImageUrlTool } from "@/tool/image/from-url"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import { webFetchTool } from "@/tool/web"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })
const sig = new AbortController().signal

/** Public address every benign NAME resolves to — keeps the DNS-rebinding layer
 *  a no-op for control cases so they never touch real DNS. */
const PUBLIC_RESOLVE: HostResolver = async () => ["93.184.216.34"]

/** A fetcher driven by a url→Response map. An UNMAPPED url means the guard let a
 *  request through that it should have blocked → we throw loudly so the test
 *  fails as "internal service reached" rather than passing vacuously. */
const scriptedFetch = (script: Record<string, () => Response>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const make = script[url]
    if (make === undefined) throw new Error(`UNEXPECTED FETCH (SSRF bypass!): ${url}`)
    return make()
  }) as unknown as typeof fetch

/** A fetcher that fails the test the instant it is invoked — used when the
 *  pre-flight host check alone must reject (the request must never leave). */
const neverFetch: typeof fetch = (async (input: string | URL | Request) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  throw new Error(`UNEXPECTED FETCH (pre-flight should have blocked): ${url}`)
}) as unknown as typeof fetch

const redirectTo =
  (location: string, status = 302): (() => Response) =>
  () =>
    new Response(null, { status, headers: { location } })

const okText =
  (body = "ok"): (() => Response) =>
  () =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain" } })

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const okPng = (): Response =>
  new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } })

const collect = async (
  // biome-ignore lint/suspicious/noExplicitAny: tool input is contravariant
  tool: { execute: (i: any, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

const isDenied = (r: ToolResult): boolean =>
  !r.ok &&
  (r.failure?.mode === "permission_denied" || /SSRF|denied|private|loopback/i.test(r.output))

/* ================================================================== */
/* Class 1 — private / loopback / link-local IP literals               */
/* ================================================================== */

describe("Class 1 — private/loopback/link-local/metadata IP literals are denied", () => {
  const LITERALS: ReadonlyArray<[string, string]> = [
    ["loopback v4", "127.0.0.1"],
    ["loopback v4 alt", "127.255.255.254"],
    ["localhost name", "localhost"],
    ["subdomain.localhost", "api.localhost"],
    ["unspecified 0.0.0.0", "0.0.0.0"],
    ["10/8 private", "10.1.2.3"],
    ["192.168/16 private", "192.168.0.1"],
    ["172.16/12 low", "172.16.0.1"],
    ["172.16/12 high", "172.31.255.255"],
    ["169.254/16 link-local", "169.254.0.1"],
    ["AWS/GCP metadata 169.254.169.254", "169.254.169.254"],
    ["CGNAT 100.64/10", "100.64.0.1"],
    ["IPv6 loopback ::1", "[::1]"],
    ["IPv6 ULA fd00::", "[fd00::1]"],
    ["IPv6 link-local fe80::", "[fe80::1]"],
  ]

  for (const [label, host] of LITERALS) {
    test(`${label} (${host}) → classifyHost denies`, () => {
      const bare = host.replace(/^\[|\]$/g, "")
      expect(classifyHost(bare)).not.toBeNull()
      // back-compat alias must agree
      expect(ssrfDeny(bare)).not.toBeNull()
    })
  }

  test("control: public IP + public name + public v6 are ALLOWED", () => {
    expect(classifyHost("8.8.8.8")).toBeNull()
    expect(classifyHost("93.184.216.34")).toBeNull()
    expect(classifyHost("example.com")).toBeNull()
    expect(classifyHost("[2606:4700:4700::1111]".replace(/^\[|\]$/g, ""))).toBeNull()
    // RFC1918-adjacent but PUBLIC ranges must not over-block
    expect(classifyHost("172.15.0.1")).toBeNull()
    expect(classifyHost("172.32.0.1")).toBeNull()
    expect(classifyHost("100.63.0.1")).toBeNull()
    expect(classifyHost("100.128.0.1")).toBeNull()
  })

  test("end-to-end: web_fetch on https://169.254.169.254 → typed permission_denied, fetcher never called", async () => {
    const tool = webFetchTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
    const r = await collect(tool, { url: "https://169.254.169.254/latest/meta-data/" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })

  test("end-to-end: read_image_url on https://[::1] → denied, fetcher never called", async () => {
    const tool = readImageUrlTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
    const r = await collect(tool, { url: "https://[::1]/img.png" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })
})

/* ================================================================== */
/* Class 2 — IP-encoding evasions (the classic SSRF arsenal)           */
/* ================================================================== */

describe("Class 2 — IP-encoding evasions resolve to canonical IP before denylist", () => {
  // The guard reads url.hostname; WHATWG URL canonicalises decimal/hex/octal/
  // short/unicode IPv4 to dotted-quad. We assert the FULL https://… string
  // (the real attack vector) is denied at the tool boundary — proving the guard
  // is NOT a string-prefix match on the raw user input.
  const ENCODED: ReadonlyArray<[string, string]> = [
    ["decimal 2130706433 = 127.0.0.1", "https://2130706433/"],
    ["hex 0x7f000001 = 127.0.0.1", "https://0x7f000001/"],
    ["hex metadata 0xa9fea9fe = 169.254.169.254", "https://0xa9fea9fe/"],
    ["octal 0177.0.0.1 = 127.0.0.1", "https://0177.0.0.1/"],
    ["zero-padded 127.0.0.01", "https://127.0.0.01/"],
    ["short form 127.1 = 127.0.0.1", "https://127.1/"],
    ["short form 192.168.1 = 192.168.0.1", "https://192.168.1/"],
    ["mixed 0x7f.1 = 127.0.0.1", "https://0x7f.1/"],
    ["unicode digits ①②⑦.0.0.1", "https://①②⑦.0.0.1/"],
    ["ideographic dots 127。0。0。1", "https://127。0。0。1/"],
    ["IPv4-mapped IPv6 [::ffff:127.0.0.1]", "https://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped metadata [::ffff:169.254.169.254]", "https://[::ffff:169.254.169.254]/"],
    ["IPv6 zone-id [fe80::1%eth0]", "https://[fe80::1%25eth0]/"],
    ["trailing FQDN dot 127.0.0.1.", "https://127.0.0.1./"],
  ]

  for (const [label, url] of ENCODED) {
    test(`${label} → web_fetch denied (no internal request leaves)`, async () => {
      const tool = webFetchTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
      const r = await collect(tool, { url })
      expect(r.ok).toBe(false)
      // Either pre-flight host deny or a URL/parse rejection — but never a fetch.
      expect(r.ok === false).toBe(true)
    })
  }

  test("control: a public decimal-free dotted IP still fetches", async () => {
    const url = "https://93.184.216.34/"
    const tool = webFetchTool({
      fetcher: scriptedFetch({ [url]: okText("hello") }),
      resolveHost: PUBLIC_RESOLVE,
    })
    const r = await collect(tool, { url })
    expect(r.ok).toBe(true)
  })
})

/* ================================================================== */
/* Class 2b — REAL BUG (R6): IPv6→IPv4 embedded transition wrappers     */
/* ================================================================== */

describe("Class 2b — embedded-IPv4 IPv6 transition wrappers (R6 fix)", () => {
  // BEFORE the R6 fix every one of these classified as null (ALLOWED) while its
  // embedded address routes internally on a NAT64/6to4-enabled host.
  const EMBEDDED_PRIVATE: ReadonlyArray<[string, string]> = [
    ["IPv4-translated ::ffff:0:0/96 → loopback", "[::ffff:0:7f00:1]"],
    ["IPv4-translated → metadata", "[::ffff:0:a9fe:a9fe]"],
    ["NAT64 64:ff9b::/96 → loopback", "[64:ff9b::7f00:1]"],
    ["NAT64 → metadata 169.254.169.254", "[64:ff9b::a9fe:a9fe]"],
    ["NAT64 → 10/8 private", "[64:ff9b::a00:1]"],
    ["6to4 2002::/16 → loopback", "[2002:7f00:1::1]"],
    ["6to4 → metadata", "[2002:a9fe:a9fe::1]"],
    ["6to4 → 192.168/16", "[2002:c0a8:1::1]"],
    ["deprecated site-local fec0::/10", "[fec0::1]"],
    ["site-local high feff::", "[feff::1]"],
  ]

  for (const [label, host] of EMBEDDED_PRIVATE) {
    test(`${label} (${host}) → classifyHost denies`, () => {
      const bare = host.replace(/^\[|\]$/g, "")
      expect(isIpLiteral(bare)).toBe(true)
      const verdict = classifyHost(bare)
      expect(verdict).not.toBeNull()
    })
  }

  // Controls: the SAME transition wrappers carrying a PUBLIC v4 (8.8.8.8) MUST
  // still be allowed — the fix decodes the embedded address, it does not blanket
  // ban the prefix.
  const EMBEDDED_PUBLIC: ReadonlyArray<[string, string]> = [
    ["NAT64 → public 8.8.8.8", "[64:ff9b::808:808]"],
    ["6to4 → public 8.8.8.8", "[2002:808:808::1]"],
    ["IPv4-translated → public 8.8.8.8", "[::ffff:0:808:808]"],
    ["IPv4-mapped → public 8.8.8.8", "[::ffff:808:808]"],
  ]
  for (const [label, host] of EMBEDDED_PUBLIC) {
    test(`control: ${label} (${host}) → allowed`, () => {
      expect(classifyHost(host.replace(/^\[|\]$/g, ""))).toBeNull()
    })
  }

  test("end-to-end: web_fetch on NAT64-wrapped metadata → denied, fetcher never called", async () => {
    const tool = webFetchTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
    const r = await collect(tool, { url: "https://[64:ff9b::a9fe:a9fe]/latest/meta-data/" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })

  test("end-to-end: read_image_url on 6to4-wrapped loopback → denied", async () => {
    const tool = readImageUrlTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
    const r = await collect(tool, { url: "https://[2002:7f00:1::1]/x.png" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })
})

/* ================================================================== */
/* Class 3 — DNS rebinding / resolve-then-check (injected resolver)     */
/* ================================================================== */

describe("Class 3 — DNS rebinding: resolved private IP is rejected", () => {
  // A name that passes the literal-host check (it's a name) but whose A/AAAA
  // record points at an internal address. The guard resolves via the injected
  // resolver and re-classifies every returned address.
  const rebind =
    (addr: string): HostResolver =>
    async () => [addr]

  const REBIND_TARGETS: ReadonlyArray<[string, string]> = [
    ["→ AWS metadata", "169.254.169.254"],
    ["→ loopback", "127.0.0.1"],
    ["→ 10/8", "10.0.0.5"],
    ["→ 192.168/16", "192.168.1.1"],
    ["→ IPv6 loopback", "::1"],
    ["→ IPv6 ULA", "fd00::1"],
    ["→ NAT64 metadata (resolved AAAA)", "64:ff9b::a9fe:a9fe"],
  ]

  for (const [label, addr] of REBIND_TARGETS) {
    test(`evil.example.com ${label} (${addr}) → guard rejects`, async () => {
      const url = "https://evil.example.com/"
      await expect(
        fetchWithSsrfGuard(neverFetch, url, { signal: sig }, { resolveHost: rebind(addr) }),
      ).rejects.toBeInstanceOf(SsrfGuardError)
    })
  }

  test("multi-record: one public + one private A record → still rejected (any-private-denies)", async () => {
    const url = "https://evil.example.com/"
    const resolveHost: HostResolver = async () => ["93.184.216.34", "169.254.169.254"]
    await expect(
      fetchWithSsrfGuard(neverFetch, url, { signal: sig }, { resolveHost }),
    ).rejects.toBeInstanceOf(SsrfGuardError)
  })

  test("end-to-end: web_fetch with a rebinding resolver → typed deny", async () => {
    const tool = webFetchTool({
      fetcher: neverFetch,
      resolveHost: async () => ["169.254.169.254"],
    })
    const r = await collect(tool, { url: "https://evil.example.com/" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })

  test("control: a name resolving ONLY to a public IP fetches successfully", async () => {
    const url = "https://good.example.com/"
    const tool = webFetchTool({
      fetcher: scriptedFetch({ [url]: okText("safe") }),
      resolveHost: async () => ["93.184.216.34"],
    })
    const r = await collect(tool, { url })
    expect(r.ok).toBe(true)
  })

  test("resolver throwing (transient DNS failure) fails OPEN — the literal check already ran", async () => {
    const url = "https://good.example.com/"
    const throwing: HostResolver = async () => {
      throw new Error("ENOTFOUND")
    }
    const res = await fetchWithSsrfGuard(
      scriptedFetch({ [url]: okText("ok") }),
      url,
      { signal: sig },
      { resolveHost: throwing },
    )
    expect(res.status).toBe(200)
  })
})

/* ================================================================== */
/* Class 4 — redirect-based escape (every hop re-validated)            */
/* ================================================================== */

describe("Class 4 — 30x redirect targets re-checked on every hop", () => {
  const INTERNAL: ReadonlyArray<[string, string]> = [
    ["AWS IMDS", "https://169.254.169.254/latest/meta-data/"],
    ["loopback", "https://127.0.0.1/"],
    ["10/8", "https://10.0.0.1/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["NAT64 metadata (R6)", "https://[64:ff9b::a9fe:a9fe]/"],
    ["decimal-encoded loopback", "https://2130706433/"],
  ]

  for (const [label, internalUrl] of INTERNAL) {
    test(`public → 302 → ${label} is rejected, internal never fetched`, async () => {
      const start = "https://public.example.com/"
      const fetcher = scriptedFetch({ [start]: redirectTo(internalUrl) })
      await expect(
        fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: PUBLIC_RESOLVE }),
      ).rejects.toBeInstanceOf(SsrfGuardError)
    })
  }

  test("https→http downgrade redirect is rejected (must not escape TLS)", async () => {
    const start = "https://public.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo("http://public.example.com/plain") })
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: PUBLIC_RESOLVE }),
    ).rejects.toBeInstanceOf(SsrfGuardError)
  })

  test("redirect chain that rebinds to a private NAME target is rejected", async () => {
    const start = "https://a.example.com/"
    const mid = "https://b.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo(mid) })
    const resolveHost: HostResolver = async (h) =>
      h === "b.example.com" ? ["127.0.0.1"] : ["93.184.216.34"]
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost }),
    ).rejects.toBeInstanceOf(SsrfGuardError)
  })

  test("redirect loop is bounded (> SSRF_MAX_REDIRECTS throws)", async () => {
    const start = "https://loop.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo(start) })
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: PUBLIC_RESOLVE }),
    ).rejects.toMatchObject({ reason: "too_many_redirects" })
    expect(SSRF_MAX_REDIRECTS).toBeGreaterThan(0)
  })

  test("end-to-end: web_fetch follows a benign public→public redirect (control)", async () => {
    const start = "https://public.example.com/"
    const dest = "https://cdn.example.com/page"
    const tool = webFetchTool({
      fetcher: scriptedFetch({ [start]: redirectTo(dest), [dest]: okText("final") }),
      resolveHost: PUBLIC_RESOLVE,
    })
    const r = await collect(tool, { url: start })
    expect(r.ok).toBe(true)
  })

  test("end-to-end: read_image_url public→public image redirect (control)", async () => {
    const start = "https://public.example.com/a"
    const dest = "https://cdn.example.com/a.png"
    const tool = readImageUrlTool({
      fetcher: scriptedFetch({ [start]: redirectTo(dest), [dest]: okPng }),
      resolveHost: PUBLIC_RESOLVE,
    })
    const r = await collect(tool, { url: start })
    expect(r.ok).toBe(true)
    expect(r.ok && r.images?.length).toBe(1)
  })

  test("end-to-end: read_image_url image-redirect-to-metadata → denied", async () => {
    const start = "https://public.example.com/a"
    const tool = readImageUrlTool({
      fetcher: scriptedFetch({ [start]: redirectTo("https://169.254.169.254/a.png") }),
      resolveHost: PUBLIC_RESOLVE,
    })
    const r = await collect(tool, { url: start })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })
})

/* ================================================================== */
/* Class 5 — scheme abuse                                              */
/* ================================================================== */

describe("Class 5 — non-https schemes + credentials are rejected", () => {
  const BAD_SCHEMES: ReadonlyArray<[string, string]> = [
    ["http (no TLS)", "http://example.com/"],
    ["file://", "file:///etc/passwd"],
    ["ftp://", "ftp://internal/file"],
    ["gopher:// (classic SSRF)", "gopher://127.0.0.1:6379/_INFO"],
    ["data:", "data:text/plain,hi"],
  ]

  for (const [label, url] of BAD_SCHEMES) {
    test(`web_fetch rejects ${label}`, async () => {
      const tool = webFetchTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
      const r = await collect(tool, { url })
      expect(r.ok).toBe(false)
    })
    test(`read_image_url rejects ${label}`, async () => {
      const tool = readImageUrlTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
      const r = await collect(tool, { url })
      expect(r.ok).toBe(false)
    })
  }

  test("credentialed URL to an internal host is still denied (creds do not bypass host check)", async () => {
    const tool = webFetchTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
    const r = await collect(tool, { url: "https://user:pass@127.0.0.1/" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })

  test("internal host on an unusual port (Redis 6379) is denied by host classification", async () => {
    // The host is what matters; the port rides along. 127.0.0.1:6379 → loopback.
    const tool = webFetchTool({ fetcher: neverFetch, resolveHost: PUBLIC_RESOLVE })
    const r = await collect(tool, { url: "https://127.0.0.1:6379/" })
    expect(r.ok).toBe(false)
    expect(isDenied(r)).toBe(true)
  })

  test("redirect to a non-https scheme (gopher) is rejected", async () => {
    const start = "https://public.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo("gopher://127.0.0.1:6379/_") })
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: PUBLIC_RESOLVE }),
    ).rejects.toBeInstanceOf(SsrfGuardError)
  })
})

/* ================================================================== */
/* Class 6 — guard is the SSOT (literal + resolved + redirect)         */
/* ================================================================== */

describe("Class 6 — guard re-checks the RESOLVED IP and the FINAL redirect target", () => {
  test("a public host that 302s to a name which rebinds private is fully rejected", async () => {
    const start = "https://entry.example.com/"
    const hop = "https://cdn.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo(hop) })
    const resolveHost: HostResolver = async (h) =>
      h === "cdn.example.com" ? ["169.254.169.254"] : ["93.184.216.34"]
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost }),
    ).rejects.toMatchObject({ name: "SsrfGuardError" })
  })

  test("the deny reason carries the offending hostname for the audit layer", async () => {
    const url = "https://169.254.169.254/"
    try {
      await fetchWithSsrfGuard(neverFetch, url, { signal: sig }, { resolveHost: PUBLIC_RESOLVE })
      throw new Error("expected rejection")
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfGuardError)
      expect((e as SsrfGuardError).hostname).toBe("169.254.169.254")
    }
  })

  test("end-to-end positive: a wholly legitimate public fetch still succeeds", async () => {
    const url = "https://docs.example.com/rfc"
    const tool = webFetchTool({
      fetcher: scriptedFetch({ [url]: okText("# Title\n\nbody") }),
      resolveHost: PUBLIC_RESOLVE,
    })
    const r = await collect(tool, { url })
    expect(r.ok).toBe(true)
    expect(r.ok && r.output).toContain("Title")
  })
})
