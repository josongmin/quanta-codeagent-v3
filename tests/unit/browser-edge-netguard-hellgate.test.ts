/**
 * Hellgate — browser net-guard `guardNavigationUrl` (async) + DNS EXTREME
 * (ADR-0427).
 *
 * Dimension: protocol gating, port/auth/fragment/query on private hosts, the
 * async DNS resolver seam (mixed public/private → any-private DENIED, empty,
 * IPv6/mapped/malformed/name-like resolver outputs, throwing = fail-closed),
 * IP-literal hosts skipping DNS (spy resolver asserts 0 calls), and url object
 * fidelity (path/query preserved).
 *
 * Every deny/error case carries a matching control (a valid case that MUST pass)
 * so a constant-return mutation (always-deny / always-allow) is caught.
 */

import { describe, expect, test } from "bun:test"
import { type DnsResolver, guardNavigationUrl } from "@/tool/browser/net-guard"

// A resolver that always returns a fixed address list, recording call count.
const fixedResolver = (
  addrs: readonly string[],
): DnsResolver & { calls: () => number; lastHost: () => string | undefined } => {
  let count = 0
  let last: string | undefined
  return {
    async lookup(hostname: string): Promise<readonly string[]> {
      count++
      last = hostname
      return addrs
    },
    calls: () => count,
    lastHost: () => last,
  }
}

const throwingResolver: DnsResolver = {
  async lookup(): Promise<readonly string[]> {
    throw new Error("EAI_AGAIN")
  },
}

describe("HELLGATE net-guard — protocol gating", () => {
  const DENY_PROTO: ReadonlyArray<[string, string]> = [
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<h1>x</h1>"],
    ["file:", "file:///etc/passwd"],
    ["blob:", "blob:https://example.com/uuid"],
    ["ftp:", "ftp://example.com/file"],
    ["ws:", "ws://example.com/socket"],
    ["wss:", "wss://example.com/socket"],
    ["gopher:", "gopher://example.com/"],
    ["chrome:", "chrome://settings"],
  ]
  for (const [label, raw] of DENY_PROTO) {
    test(`DENY protocol ${label}`, async () => {
      const r = await guardNavigationUrl(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("protocol not allowed")
    })
  }

  test("ALLOW control: plain http", async () => {
    const r = await guardNavigationUrl("http://example.com/")
    expect(r.ok).toBe(true)
  })

  test("ALLOW control: plain https", async () => {
    const r = await guardNavigationUrl("https://example.com/")
    expect(r.ok).toBe(true)
  })

  test("ALLOW: uppercase HTTPS:// scheme — URL lowercases the scheme", async () => {
    const r = await guardNavigationUrl("HTTPS://example.com/")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.protocol).toBe("https:")
  })

  test("ALLOW: mixed-case HtTp:// scheme", async () => {
    const r = await guardNavigationUrl("HtTp://example.com/")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.protocol).toBe("http:")
  })

  test("DENY: unparseable garbage url", async () => {
    const r = await guardNavigationUrl("::::not a url::::")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("invalid url")
  })

  test("DENY: empty string", async () => {
    const r = await guardNavigationUrl("")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("invalid url")
  })
})

describe("HELLGATE net-guard — private LITERAL with port/auth/fragment/query still DENIED", () => {
  const DENY_DECORATED: ReadonlyArray<[string, string]> = [
    ["port", "http://127.0.0.1:8080/"],
    ["auth", "http://user:pass@127.0.0.1/"],
    ["fragment", "http://127.0.0.1/page#frag"],
    ["query", "http://127.0.0.1/api?x=1&y=2"],
    ["everything", "http://u:p@10.0.0.5:9000/a/b?q=1#z"],
    ["ipv6 loopback w/ port", "http://[::1]:7000/"],
    ["192.168 w/ query", "https://192.168.1.1/admin?secret=1"],
    ["169.254 metadata w/ path", "http://169.254.169.254/latest/meta-data/"],
    ["mapped v4 w/ port", "http://[::ffff:127.0.0.1]:8080/"],
    ["localhost w/ auth+port", "http://admin:admin@localhost:3000/x"],
  ]
  for (const [label, raw] of DENY_DECORATED) {
    test(`DENY decorated private ${label}`, async () => {
      const r = await guardNavigationUrl(raw)
      expect(r.ok).toBe(false)
    })
  }

  test("ALLOW control: public host with the SAME decorations (port/auth/query/frag)", async () => {
    const r = await guardNavigationUrl("http://u:p@example.com:9000/a/b?q=1#z")
    expect(r.ok).toBe(true)
  })

  test("ALLOW control: public IP literal with port + query", async () => {
    const r = await guardNavigationUrl("http://8.8.8.8:8080/dns?x=1")
    expect(r.ok).toBe(true)
  })
})

describe("HELLGATE net-guard — async DNS resolver: any-private = DENIED", () => {
  test("DENY: resolver returns [public, private] mixed (any-private)", async () => {
    const resolver = fixedResolver(["8.8.8.8", "127.0.0.1"])
    const r = await guardNavigationUrl("https://evil.example.com/", resolver)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("127.0.0.1")
    expect(resolver.calls()).toBe(1)
  })

  test("DENY: resolver returns [private, public] reversed order", async () => {
    const resolver = fixedResolver(["10.0.0.1", "8.8.8.8"])
    const r = await guardNavigationUrl("https://evil.example.com/", resolver)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("10.0.0.1")
  })

  test("ALLOW control: resolver returns [public, public] — nothing private", async () => {
    const resolver = fixedResolver(["8.8.8.8", "1.1.1.1"])
    const r = await guardNavigationUrl("https://safe.example.com/", resolver)
    expect(r.ok).toBe(true)
    expect(resolver.calls()).toBe(1)
  })

  test("ALLOW control: resolver returns [] empty — nothing private to reject", async () => {
    const resolver = fixedResolver([])
    const r = await guardNavigationUrl("https://noaddr.example.com/", resolver)
    expect(r.ok).toBe(true)
    expect(resolver.calls()).toBe(1)
  })

  test("DENY: resolver returns single private link-local (cloud metadata)", async () => {
    const resolver = fixedResolver(["169.254.169.254"])
    const r = await guardNavigationUrl("https://metadata.example.com/", resolver)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("169.254.169.254")
  })

  test("ALLOW control: resolver returns single public address", async () => {
    const resolver = fixedResolver(["93.184.216.34"])
    const r = await guardNavigationUrl("https://example.com/", resolver)
    expect(r.ok).toBe(true)
  })
})

describe("HELLGATE net-guard — async DNS resolver: exotic string outputs", () => {
  test("DENY: resolver returns IPv6 loopback string `::1`", async () => {
    const resolver = fixedResolver(["::1"])
    const r = await guardNavigationUrl("https://v6.example.com/", resolver)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("::1")
  })

  test("DENY: resolver returns IPv4-mapped IPv6 form `::ffff:127.0.0.1`", async () => {
    const resolver = fixedResolver(["::ffff:127.0.0.1"])
    const r = await guardNavigationUrl("https://mapped.example.com/", resolver)
    expect(r.ok).toBe(false)
  })

  test("DENY: resolver returns ULA `fc00::1`", async () => {
    const resolver = fixedResolver(["fc00::1"])
    const r = await guardNavigationUrl("https://ula.example.com/", resolver)
    expect(r.ok).toBe(false)
  })

  test("ALLOW control: resolver returns public IPv6 `2001:4860:4860::8888`", async () => {
    const resolver = fixedResolver(["2001:4860:4860::8888"])
    const r = await guardNavigationUrl("https://v6pub.example.com/", resolver)
    expect(r.ok).toBe(true)
  })

  test("ALLOW: resolver returns a malformed/garbage string — classifyHost treats it as a name (null), not private", async () => {
    // classifyHost on a non-IP, non-localhost string returns null (it's a "name");
    // so a garbage record does NOT trigger a private verdict. Allowed.
    const resolver = fixedResolver(["not-an-ip-at-all"])
    const r = await guardNavigationUrl("https://garbage.example.com/", resolver)
    expect(r.ok).toBe(true)
  })

  test("ALLOW: resolver returns a name-like string — treated as name (null verdict)", async () => {
    const resolver = fixedResolver(["some.cdn.edge.net"])
    const r = await guardNavigationUrl("https://named.example.com/", resolver)
    expect(r.ok).toBe(true)
  })

  test("DENY: resolver returns `localhost` literal string", async () => {
    const resolver = fixedResolver(["localhost"])
    const r = await guardNavigationUrl("https://lh.example.com/", resolver)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("localhost")
  })

  test("DENY: mixed exotic — [public IPv6, private mapped v4]", async () => {
    const resolver = fixedResolver(["2001:4860:4860::8888", "::ffff:10.0.0.1"])
    const r = await guardNavigationUrl("https://mix.example.com/", resolver)
    expect(r.ok).toBe(false)
  })
})

describe("HELLGATE net-guard — resolver fail-closed", () => {
  test("DENY: resolver throws → fail-closed", async () => {
    const r = await guardNavigationUrl("https://flaky.example.com/", throwingResolver)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("dns resolution failed")
  })

  test("ALLOW control: same host with a working public resolver", async () => {
    const resolver = fixedResolver(["8.8.8.8"])
    const r = await guardNavigationUrl("https://flaky.example.com/", resolver)
    expect(r.ok).toBe(true)
  })
})

describe("HELLGATE net-guard — NO resolver: name allowed, literal still denied", () => {
  test("ALLOW: public-looking NAME with no resolver (literal classifier only)", async () => {
    const r = await guardNavigationUrl("https://internal.corp.example.com/")
    expect(r.ok).toBe(true)
  })

  test("DENY: private LITERAL with no resolver (literal classifier always runs)", async () => {
    const r = await guardNavigationUrl("https://127.0.0.1/")
    expect(r.ok).toBe(false)
  })

  test("DENY: ipv6 loopback literal with no resolver", async () => {
    const r = await guardNavigationUrl("https://[::1]/")
    expect(r.ok).toBe(false)
  })

  test("DENY: decimal-encoded loopback literal with no resolver (URL normalizes 2130706433)", async () => {
    const r = await guardNavigationUrl("http://2130706433/")
    expect(r.ok).toBe(false)
  })
})

describe("HELLGATE net-guard — IP literal host SKIPS DNS (resolver NOT called)", () => {
  test("public IPv4 literal: resolver spy gets 0 calls", async () => {
    const resolver = fixedResolver(["127.0.0.1"]) // would deny if (wrongly) called
    const r = await guardNavigationUrl("https://8.8.8.8/", resolver)
    expect(r.ok).toBe(true)
    expect(resolver.calls()).toBe(0)
  })

  test("public IPv6 literal: resolver spy gets 0 calls", async () => {
    const resolver = fixedResolver(["::1"]) // would deny if (wrongly) called
    const r = await guardNavigationUrl("https://[2001:4860:4860::8888]/", resolver)
    expect(r.ok).toBe(true)
    expect(resolver.calls()).toBe(0)
  })

  test("CONTROL: a NAME host DOES call the resolver (spy gets 1 call)", async () => {
    const resolver = fixedResolver(["8.8.8.8"])
    const r = await guardNavigationUrl("https://name.example.com/", resolver)
    expect(r.ok).toBe(true)
    expect(resolver.calls()).toBe(1)
    expect(resolver.lastHost()).toBe("name.example.com")
  })

  test("private IPv4 literal: denied by literal classifier BEFORE any DNS (0 calls)", async () => {
    const resolver = fixedResolver(["8.8.8.8"]) // would allow if (wrongly) consulted
    const r = await guardNavigationUrl("https://10.0.0.5/", resolver)
    expect(r.ok).toBe(false)
    expect(resolver.calls()).toBe(0)
  })
})

describe("HELLGATE net-guard — returned url object preserves path/query/fragment", () => {
  test("path + query preserved on allowed public name", async () => {
    const r = await guardNavigationUrl("https://example.com/a/b/c?x=1&y=two#frag")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.url.pathname).toBe("/a/b/c")
      expect(r.url.search).toBe("?x=1&y=two")
      expect(r.url.hash).toBe("#frag")
      expect(r.url.hostname).toBe("example.com")
    }
  })

  test("path + query preserved through the DNS-resolver path too", async () => {
    const resolver = fixedResolver(["8.8.8.8"])
    const r = await guardNavigationUrl("https://example.com/deep/path?token=abc", resolver)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.url.pathname).toBe("/deep/path")
      expect(r.url.search).toBe("?token=abc")
    }
  })

  test("path preserved on allowed public IP literal", async () => {
    const r = await guardNavigationUrl("http://8.8.8.8:8080/resolve?name=foo")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.url.port).toBe("8080")
      expect(r.url.pathname).toBe("/resolve")
      expect(r.url.search).toBe("?name=foo")
    }
  })
})
