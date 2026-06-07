/**
 * Hellgate — SSRF redirect / downgrade bypass (T1-ssrf audit, 3 HIGH).
 *
 * Proves the redirect-safe fetch helper closes the bypass where a PUBLIC URL
 * 30x-redirects to an internal address (169.254.169.254 / 127.0.0.1 / RFC1918)
 * or downgrades to http://. `web_fetch` and `read_image_url` are always-on
 * read-only tools that skip the permission gate, so a `redirect:"follow"`
 * would have reached the internal service before any host check ran.
 *
 * Each adversarial hop is paired with a control (the same machinery on a
 * benign public→public redirect MUST still succeed) so the deny is not vacuous.
 *
 * Driven at two levels:
 *   A. `fetchWithSsrfGuard` directly (unit) — every reason code.
 *   B. `web_fetch` + `read_image_url` end-to-end with an injected redirecting
 *      fetcher — proves the tools surface a typed permission_denied, not a
 *      followed internal fetch.
 */

import { describe, expect, test } from "bun:test"
import {
  fetchWithSsrfGuard,
  type HostResolver,
  SSRF_MAX_REDIRECTS,
  SsrfGuardError,
} from "@/shared/net/ssrf"
import { readImageUrlTool } from "@/tool/image/from-url"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import { webFetchTool } from "@/tool/web"

/** Deterministic resolver for the existing redirect/host cases: every NAME
 *  resolves to a fixed PUBLIC address so the DNS-rebinding layer is a no-op and
 *  these tests never touch real DNS (hermetic). The rebinding section below
 *  injects its own private-mapping resolver. */
const RESOLVE: HostResolver = async () => ["93.184.216.34"]

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })

/** A fetcher driven by a hop→Response map. Each requested URL yields the
 *  mapped Response; an unmapped URL means the guard let a request through it
 *  should have blocked, so we fail loudly (an internal service was reached). */
const scriptedFetch = (script: Record<string, () => Response>): typeof fetch => {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const make = script[url]
    if (make === undefined) {
      throw new Error(`UNEXPECTED FETCH (bypass!): ${url}`)
    }
    return make()
  }) as unknown as typeof fetch
}

const redirectTo = (location: string, status = 302): (() => Response) => {
  return () => new Response(null, { status, headers: { location } })
}

const ok = (body = "ok", contentType = "text/plain"): (() => Response) => {
  return () => new Response(body, { status: 200, headers: { "content-type": contentType } })
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const okPng = (): Response =>
  new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } })

const collect = async (
  // biome-ignore lint/suspicious/noExplicitAny: tool input is contravariant; a concrete Tool<I> is not assignable to a (i:unknown) param
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

/* ------------------------------------------------------------------ */
/* A. fetchWithSsrfGuard — direct                                      */
/* ------------------------------------------------------------------ */

describe("A. fetchWithSsrfGuard — redirect targets re-checked on every hop", () => {
  const sig = new AbortController().signal

  const INTERNAL_TARGETS: ReadonlyArray<[string, string]> = [
    ["AWS IMDS", "https://169.254.169.254/latest/meta-data/"],
    ["loopback", "https://127.0.0.1/"],
    ["RFC1918 10/8", "https://10.0.0.5/"],
    ["RFC1918 192.168", "https://192.168.1.1/"],
    ["localhost name", "https://localhost/"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/"],
    ["decimal-encoded loopback", "https://2130706433/"],
  ]

  for (const [label, target] of INTERNAL_TARGETS) {
    test(`DENY redirect to ${label}`, async () => {
      const start = "https://public.example.com/"
      const fetcher = scriptedFetch({ [start]: redirectTo(target) })
      await expect(
        fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: RESOLVE }),
      ).rejects.toThrow(SsrfGuardError)
    })
  }

  test("DENY https→http downgrade redirect", async () => {
    const start = "https://public.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo("http://public.example.com/insecure") })
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: RESOLVE }),
    ).rejects.toMatchObject({
      reason: "non_https_redirect",
    })
  })

  test("DENY redirect with no Location header", async () => {
    const start = "https://public.example.com/"
    const fetcher = scriptedFetch({
      [start]: () => new Response(null, { status: 302 }),
    })
    // 3xx without Location is NOT treated as a followable redirect — it returns
    // the response as-is (the caller sees a non-2xx). So this should NOT throw.
    const res = await fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: RESOLVE })
    expect(res.status).toBe(302)
  })

  test("DENY too many redirects (loop)", async () => {
    // A self-redirect chain longer than the hop ceiling. Each hop stays public
    // so the only failure mode is the hop-count guard.
    const script: Record<string, () => Response> = {}
    for (let i = 0; i <= SSRF_MAX_REDIRECTS + 2; i++) {
      script[`https://public.example.com/${i}`] = redirectTo(`https://public.example.com/${i + 1}`)
    }
    const fetcher = scriptedFetch(script)
    await expect(
      fetchWithSsrfGuard(
        fetcher,
        "https://public.example.com/0",
        { signal: sig },
        { resolveHost: RESOLVE },
      ),
    ).rejects.toMatchObject({ reason: "too_many_redirects" })
  })

  test("DENY when the INITIAL url is internal (helper safe in isolation)", async () => {
    const fetcher = scriptedFetch({ "https://127.0.0.1/": ok() })
    await expect(
      fetchWithSsrfGuard(fetcher, "https://127.0.0.1/", { signal: sig }, { resolveHost: RESOLVE }),
    ).rejects.toThrow(SsrfGuardError)
  })

  /* ---- controls: benign behaviour preserved ---- */

  test("ALLOW direct public 200 (happy path unchanged)", async () => {
    const fetcher = scriptedFetch({ "https://public.example.com/": ok("hello") })
    const res = await fetchWithSsrfGuard(
      fetcher,
      "https://public.example.com/",
      { signal: sig },
      { resolveHost: RESOLVE },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello")
  })

  test("ALLOW public→public redirect chain within hop budget", async () => {
    const fetcher = scriptedFetch({
      "https://a.example.com/": redirectTo("https://b.example.com/"),
      "https://b.example.com/": redirectTo("https://c.example.com/"),
      "https://c.example.com/": ok("final"),
    })
    const res = await fetchWithSsrfGuard(
      fetcher,
      "https://a.example.com/",
      { signal: sig },
      { resolveHost: RESOLVE },
    )
    expect(await res.text()).toBe("final")
  })

  test("ALLOW relative Location resolved against current public host", async () => {
    const fetcher = scriptedFetch({
      "https://a.example.com/start": redirectTo("/landing"),
      "https://a.example.com/landing": ok("landed"),
    })
    const res = await fetchWithSsrfGuard(
      fetcher,
      "https://a.example.com/start",
      { signal: sig },
      { resolveHost: RESOLVE },
    )
    expect(await res.text()).toBe("landed")
  })

  test("DENY relative Location that would resolve onto an internal host", async () => {
    // Adversary controls a public host that 302s to an absolute internal URL
    // expressed via a protocol-relative Location.
    const fetcher = scriptedFetch({
      "https://a.example.com/start": redirectTo("//169.254.169.254/meta"),
    })
    await expect(
      fetchWithSsrfGuard(
        fetcher,
        "https://a.example.com/start",
        { signal: sig },
        { resolveHost: RESOLVE },
      ),
    ).rejects.toThrow(SsrfGuardError)
  })
})

/* ------------------------------------------------------------------ */
/* B. tools end-to-end                                                 */
/* ------------------------------------------------------------------ */

describe("B. web_fetch — redirect to internal is a typed permission_denied", () => {
  test("public URL 302→169.254.169.254 is DENIED, IMDS never fetched", async () => {
    const fetcher = scriptedFetch({
      "https://public.example.com/": redirectTo("https://169.254.169.254/latest/meta-data/"),
      // NOTE: IMDS intentionally NOT in the script — reaching it throws "bypass".
    })
    const r = await collect(webFetchTool({ fetcher, resolveHost: RESOLVE }), {
      url: "https://public.example.com/",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.output.toLowerCase()).toContain("ssrf")
      expect(r.failure?.mode).toBe("permission_denied")
    }
  })

  test("public→public redirect still succeeds (control)", async () => {
    const fetcher = scriptedFetch({
      "https://public.example.com/": redirectTo("https://cdn.example.com/page"),
      "https://cdn.example.com/page": ok("<h1>Hi</h1>", "text/html"),
    })
    const r = await collect(webFetchTool({ fetcher, resolveHost: RESOLVE }), {
      url: "https://public.example.com/",
    })
    expect(r.ok).toBe(true)
  })
})

describe("B. read_image_url — redirect to internal is a typed permission_denied", () => {
  test("public image URL 302→127.0.0.1 is DENIED, internal never fetched", async () => {
    const fetcher = scriptedFetch({
      "https://img.example.com/pic.png": redirectTo("https://127.0.0.1/secret.png"),
      // 127.0.0.1 intentionally absent → reaching it throws "bypass".
    })
    const r = await collect(readImageUrlTool({ fetcher, resolveHost: RESOLVE }), {
      url: "https://img.example.com/pic.png",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.output.toLowerCase()).toContain("ssrf")
      expect(r.failure?.mode).toBe("permission_denied")
    }
  })

  test("public→public image redirect still succeeds (control)", async () => {
    const fetcher = scriptedFetch({
      "https://img.example.com/pic.png": redirectTo("https://cdn.example.com/real.png"),
      "https://cdn.example.com/real.png": okPng,
    })
    const r = await collect(readImageUrlTool({ fetcher, resolveHost: RESOLVE }), {
      url: "https://img.example.com/pic.png",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.images?.[0]?.mediaType).toBe("image/png")
  })
})

/* ------------------------------------------------------------------ */
/* C. DNS rebinding — a public NAME resolving to a private IP is DENIED */
/* ------------------------------------------------------------------ */

describe("C. DNS-rebinding — resolved-IP re-check", () => {
  // The fetcher would happily return 200 for the attacker domain (its hostname
  // is public, so the literal-host check passes) — the ONLY thing that can stop
  // it is resolving the name and re-checking the address.
  const sig = new AbortController().signal
  const evilFetcher = scriptedFetch({ "https://rebind.attacker.example/": ok("internal-secret") })

  test("name resolving to 169.254.169.254 (IMDS) is denied (dns_rebind_*)", async () => {
    const resolveHost: HostResolver = async () => ["169.254.169.254"]
    await expect(
      fetchWithSsrfGuard(
        evilFetcher,
        "https://rebind.attacker.example/",
        { signal: sig },
        { resolveHost },
      ),
    ).rejects.toMatchObject({ name: "SsrfGuardError" })
  })

  test("name resolving to an RFC1918 address is denied", async () => {
    const resolveHost: HostResolver = async () => ["10.0.0.5"]
    await expect(
      fetchWithSsrfGuard(
        evilFetcher,
        "https://rebind.attacker.example/",
        { signal: sig },
        { resolveHost },
      ),
    ).rejects.toMatchObject({ name: "SsrfGuardError" })
  })

  test("name resolving to a public address still succeeds (control)", async () => {
    const resolveHost: HostResolver = async () => ["93.184.216.34"]
    const res = await fetchWithSsrfGuard(
      scriptedFetch({ "https://good.example.com/": ok("hi") }),
      "https://good.example.com/",
      { signal: sig },
      { resolveHost },
    )
    expect(res.status).toBe(200)
  })

  test("resolver ERROR fails OPEN (transient DNS must not break a legit fetch)", async () => {
    const resolveHost: HostResolver = async () => {
      throw new Error("ENOTFOUND")
    }
    const res = await fetchWithSsrfGuard(
      scriptedFetch({ "https://good.example.com/": ok("hi") }),
      "https://good.example.com/",
      { signal: sig },
      { resolveHost },
    )
    expect(res.status).toBe(200)
  })

  test("web_fetch surfaces the rebind as a typed permission_denied", async () => {
    const resolveHost: HostResolver = async () => ["127.0.0.1"]
    const r = await collect(webFetchTool({ fetcher: evilFetcher, resolveHost }), {
      url: "https://rebind.attacker.example/",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure?.mode).toBe("permission_denied")
  })
})
