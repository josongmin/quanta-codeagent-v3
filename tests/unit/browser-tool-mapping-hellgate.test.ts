/**
 * Hellgate — tool-layer mapping + tiers + DNS guard (ADR-0427 R1 audit
 * [12][16][20][26]).
 *
 *  every BrowserError kind → a typed ToolResult.failure (no silent passthrough);
 *  each tool's HITL tier matches the strengthen-#5 spec;
 *  guardNavigationUrl's DNS step denies a public NAME resolving to a private IP;
 *  net-guard has a real allowed-control (not an all-deny sweep).
 */

import { describe, expect, test } from "bun:test"
import type { BrowserError } from "@/browser"
import { createHeadlessBrowser } from "@/browser"
import type { Tool } from "@/tool"
import { createBrowserToolset } from "@/tool/browser"
import { type DnsResolver, guardNavigationUrl } from "@/tool/browser/net-guard"
import { mapBrowserError } from "@/tool/browser/result-map"

describe("HELLGATE map — every BrowserError kind → typed failure [20]", () => {
  const CASES: ReadonlyArray<[BrowserError, string]> = [
    [{ kind: "backend-missing" }, "spawn_error"],
    [{ kind: "spawn-failed", detail: "x" }, "spawn_error"],
    [{ kind: "navigation-denied", reason: "x" }, "permission_denied"],
    [{ kind: "element-not-found", ref: "e1" }, "not_found"],
    [{ kind: "cdp-method-denied", method: "Input.x" }, "permission_denied"],
    [{ kind: "cdp-error", detail: "x" }, "error"],
    [{ kind: "timeout", ms: 1000 }, "timeout"],
    [{ kind: "cancelled" }, "error"],
    [{ kind: "closed" }, "error"],
  ]
  for (const [err, mode] of CASES) {
    test(`${err.kind} ⇒ ${mode}`, () => {
      const r = mapBrowserError(err)
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe(mode as never)
    })
  }
  test("timeout carries timeoutMs; spawn-failed carries detail", () => {
    const t = mapBrowserError({ kind: "timeout", ms: 4242 })
    expect(t.failure?.mode === "timeout" && t.failure.timeoutMs).toBe(4242)
    const s = mapBrowserError({ kind: "spawn-failed", detail: "boom" })
    expect(s.failure?.mode === "spawn_error" && s.failure.error).toBe("boom")
  })
})

describe("HELLGATE tiers — verb HITL tiers match strengthen #5 [12]", () => {
  const ts = createBrowserToolset(createHeadlessBrowser())
  const tier = (name: string): string | undefined => {
    const t = ts.tools.find((x) => x.name === name) as Tool | undefined
    return t?.hitlTier?.({} as never)
  }
  test("read-only perception ⇒ pre-approval-ok", () => {
    expect(tier("browser_navigate")).toBe("pre-approval-ok")
    expect(tier("browser_snapshot")).toBe("pre-approval-ok")
    expect(tier("browser_screenshot")).toBe("pre-approval-ok")
  })
  test("mutating verbs ⇒ always-confirm", () => {
    expect(tier("browser_click")).toBe("always-confirm")
    expect(tier("browser_type")).toBe("always-confirm")
    expect(tier("browser_cdp")).toBe("always-confirm")
  })
})

describe("HELLGATE guard — DNS step + control [16][26]", () => {
  const resolver = (addrs: readonly string[]): DnsResolver => ({ lookup: async () => addrs })

  test("public name resolving to a private IP ⇒ denied", async () => {
    const r = await guardNavigationUrl("https://rebind.evil.test/", resolver(["10.0.0.5"]))
    expect(r.ok).toBe(false)
  })
  test("public name resolving to a public IP ⇒ allowed", async () => {
    const r = await guardNavigationUrl("https://example.com/", resolver(["93.184.216.34"]))
    expect(r.ok).toBe(true)
  })
  test("resolver throwing ⇒ denied (fail-closed)", async () => {
    const r = await guardNavigationUrl("https://example.com/", {
      lookup: async () => {
        throw new Error("nxdomain")
      },
    })
    expect(r.ok).toBe(false)
  })
  test("no resolver ⇒ literal-only (name allowed, private literal still denied)", async () => {
    expect((await guardNavigationUrl("https://example.com/")).ok).toBe(true)
    expect((await guardNavigationUrl("http://10.0.0.1/")).ok).toBe(false)
  })
  test("control: public IP literal allowed, parsed URL returned", async () => {
    const r = await guardNavigationUrl("https://93.184.216.34/path")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.pathname).toBe("/path")
  })
  test("IPv4-mapped IPv6 loopback denied even via the tool guard", async () => {
    const r = await guardNavigationUrl("http://[::ffff:127.0.0.1]/")
    expect(r.ok).toBe(false)
  })
})
