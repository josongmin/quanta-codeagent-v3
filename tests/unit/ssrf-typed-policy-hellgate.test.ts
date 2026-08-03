/**
 * HELLGATE — RFC05-1 canonical typed network admission (aug-02 absorption).
 *
 * Evolves the ONE SSRF classifier to a typed IP class + a policy-based
 * admission (`public_https` / `loopback_local`) reused by the LLM transport.
 * NO second classifier, NO adapter-specific SSRF branch.
 *
 * Invariants pinned (each red-on-injection):
 *   - `classifyIpClass` returns the structural class for every literal form;
 *   - `public_https` admits ONLY https + public-resolved; refuses http, refuses
 *     private/loopback/link-local/metadata;
 *   - `loopback_local` admits http/https to loopback ONLY; refuses public and
 *     refuses arbitrary private LAN (v1 rejects RFC1918);
 *   - the SAME policy is applied on the initial URL AND every redirect hop
 *     (a loopback_local preset cannot be redirected out to a public/private
 *     host, and a public_https fetch cannot be redirected to loopback);
 *   - the legacy `ssrfDeny`/`classifyHost` wrappers are byte-identical.
 */

import { describe, expect, test } from "bun:test"
import {
  admitEndpointUrl,
  classifyHost,
  classifyIpClass,
  fetchWithSsrfGuard,
  type HostResolver,
  SsrfGuardError,
  ssrfDeny,
} from "@/shared/net/ssrf"

const hostOf = (u: string): string => new URL(u).hostname

describe("classifyIpClass — typed structural class", () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["fc00::1", "private"],
    ["169.254.169.254", "link_local"],
    ["fe80::1", "link_local"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
    ["2606:2800:220:1::1", "public"],
    ["::ffff:93.184.216.34", "public"],
  ]
  for (const [host, cls] of CASES) {
    test(`${host} ⇒ ${cls}`, () => {
      expect(classifyIpClass(host)).toBe(cls)
    })
  }
  test("a DNS name (not an IP literal) is not classifiable here ⇒ 'name'", () => {
    expect(classifyIpClass("example.com")).toBe("name")
  })
})

describe("admitEndpointUrl — public_https policy", () => {
  test("https + public-literal host ⇒ admitted (null)", () => {
    expect(admitEndpointUrl(new URL("https://93.184.216.34/v1"), "public_https")).toBeNull()
  })
  test("http (even to a public host) ⇒ refused (plaintext credential leak)", () => {
    // RED-ON-INJECTION: dropping the scheme check leaks a bearer over cleartext.
    expect(admitEndpointUrl(new URL("http://93.184.216.34/v1"), "public_https")).not.toBeNull()
  })
  test("https to loopback/private/metadata ⇒ refused", () => {
    for (const h of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "[fe80::1]"]) {
      expect(admitEndpointUrl(new URL(`https://${h}/v1`), "public_https")).not.toBeNull()
    }
  })
})

describe("admitEndpointUrl — loopback_local policy", () => {
  test("http://127.0.0.1 ⇒ admitted (the local-OSS profile)", () => {
    expect(admitEndpointUrl(new URL("http://127.0.0.1:11434/v1"), "loopback_local")).toBeNull()
  })
  test("http://localhost ⇒ admitted", () => {
    expect(admitEndpointUrl(new URL("http://localhost:1234/v1"), "loopback_local")).toBeNull()
  })
  test("https://[::1] ⇒ admitted", () => {
    expect(admitEndpointUrl(new URL("https://[::1]:1234/v1"), "loopback_local")).toBeNull()
  })
  test("a PUBLIC host under loopback_local ⇒ refused (preset cannot reach remote)", () => {
    // RED-ON-INJECTION: a loopback preset must never admit a remote host.
    expect(admitEndpointUrl(new URL("http://93.184.216.34/v1"), "loopback_local")).not.toBeNull()
  })
  test("arbitrary private LAN under loopback_local ⇒ refused (v1 rejects RFC1918)", () => {
    expect(admitEndpointUrl(new URL("http://10.0.0.5/v1"), "loopback_local")).not.toBeNull()
    expect(admitEndpointUrl(new URL("http://192.168.1.1/v1"), "loopback_local")).not.toBeNull()
  })
})

describe("fetchWithSsrfGuard — networkPolicy applied on initial + every redirect hop", () => {
  const sig = new AbortController().signal
  const RESOLVE_PUBLIC: HostResolver = async () => ["93.184.216.34"]
  const RESOLVE_LOOPBACK: HostResolver = async () => ["127.0.0.1"]

  const scriptedFetch = (script: Record<string, () => Response>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const make = script[url]
      if (make === undefined) throw new Error(`UNEXPECTED FETCH (bypass!): ${url}`)
      return make()
    }) as unknown as typeof fetch
  const redirectTo =
    (location: string): (() => Response) =>
    () =>
      new Response(null, { status: 302, headers: { location } })
  const ok = (): Response => new Response("ok", { status: 200 })

  test("loopback_local: http://127.0.0.1 direct ⇒ succeeds", async () => {
    const start = "http://127.0.0.1:11434/v1/chat"
    const fetcher = scriptedFetch({ [start]: ok })
    const res = await fetchWithSsrfGuard(
      fetcher,
      start,
      { signal: sig },
      { resolveHost: RESOLVE_LOOPBACK, networkPolicy: "loopback_local" },
    )
    expect(res.status).toBe(200)
  })

  test("loopback_local: a redirect OUT to a PUBLIC LITERAL ⇒ DENIED (per-hop policy)", async () => {
    // The redirect target is a public IP LITERAL. Under `loopback_local` the
    // literal classifies as `public` ⇒ refused at the class step. Under the
    // DEFAULT `public_https` it would be ADMITTED — so this discriminates: if
    // the per-hop `assertUrlSafe(next, resolveHost, policy)` loses its `policy`
    // arg (falls back to public_https), the exfil redirect is ALLOWED and this
    // test reddens. (A name-target would resolve to loopback under both and not
    // discriminate.)
    const start = "http://127.0.0.1:11434/v1/chat"
    const fetcher = scriptedFetch({ [start]: redirectTo("https://93.184.216.34/") })
    await expect(
      fetchWithSsrfGuard(
        fetcher,
        start,
        { signal: sig },
        { resolveHost: RESOLVE_LOOPBACK, networkPolicy: "loopback_local" },
      ),
    ).rejects.toThrow(SsrfGuardError)
  })

  test("public_https (default): a redirect to loopback ⇒ DENIED (existing contract preserved)", async () => {
    const start = "https://public.example.com/"
    const fetcher = scriptedFetch({ [start]: redirectTo("https://127.0.0.1/") })
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: RESOLVE_PUBLIC }),
    ).rejects.toThrow(SsrfGuardError)
  })

  test("public_https: http initial URL ⇒ DENIED", async () => {
    const start = "http://public.example.com/"
    const fetcher = scriptedFetch({ [start]: ok })
    await expect(
      fetchWithSsrfGuard(fetcher, start, { signal: sig }, { resolveHost: RESOLVE_PUBLIC }),
    ).rejects.toThrow(SsrfGuardError)
  })
})

describe("RFC05-1 adversarial residuals (R2)", () => {
  test("IPv4-mapped PUBLIC under loopback_local ⇒ refused (mapped is not loopback)", () => {
    expect(
      admitEndpointUrl(new URL("https://[::ffff:93.184.216.34]/v1"), "loopback_local"),
    ).not.toBeNull()
  })
  test("IPv4-mapped LOOPBACK under public_https ⇒ refused (still loopback)", () => {
    // RED-ON-INJECTION: the mapped form must not sneak a loopback past
    // public_https (this was a historical SSRF bypass class).
    expect(
      admitEndpointUrl(new URL("https://[::ffff:127.0.0.1]/v1"), "public_https"),
    ).not.toBeNull()
  })
  test("multicast literal ⇒ refused by both policies", () => {
    expect(classifyIpClass("224.0.0.1")).toBe("multicast")
    expect(admitEndpointUrl(new URL("https://224.0.0.1/"), "public_https")).not.toBeNull()
    expect(admitEndpointUrl(new URL("http://224.0.0.1/"), "loopback_local")).not.toBeNull()
  })
  test("loopback_local with a NAME that resolves to loopback ⇒ admitted end-to-end", async () => {
    // `localhost` classifies structurally to loopback; a custom name that
    // resolves to 127.0.0.1 is admitted by the resolve step.
    const start = "http://localhost:11434/v1/chat"
    const fetcher = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch
    const res = await fetchWithSsrfGuard(
      fetcher,
      start,
      { signal: new AbortController().signal },
      { resolveHost: async () => ["127.0.0.1"], networkPolicy: "loopback_local" },
    )
    expect(res.status).toBe(200)
  })
})

describe("legacy wrappers unchanged (byte-identical compat)", () => {
  test("ssrfDeny === classifyHost and both deny loopback, allow public/name", () => {
    expect(ssrfDeny).toBe(classifyHost)
    expect(classifyHost(hostOf("http://127.0.0.1/"))).not.toBeNull()
    expect(classifyHost("93.184.216.34")).toBeNull()
    expect(classifyHost("example.com")).toBeNull() // DNS name — resolved separately
  })
})
