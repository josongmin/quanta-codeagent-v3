/**
 * Knob: `network-proxy` — parse + apply (ADR-0428).
 *
 * Locks the env-source domain (`1` ⇒ default allowlist, `host,host` ⇒ explicit
 * allow-set, `0`/empty/whitespace ⇒ inactive) and the apply contract (sets
 * `cfg.networkProxy = { enabled: true, allowlist }`, byte-identical when
 * inactive — the resolver never calls apply for an undefined parse).
 *
 * NO heuristics asserted: the proxy DECISION lives in `isHostAllowed` /
 * `classifyHost` (proven by the e2e); this suite only locks the carrier knob.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { networkProxyKnob } from "@/runner/knobs/knobs/network-proxy"
import { CI_BOT_DEFAULT_ALLOWLIST } from "@/runtime/network-allowlist"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("network-proxy knob — parse", () => {
  test('"1" ⇒ active over the ci-bot default allowlist', () => {
    const v = networkProxyKnob.parse("1")
    expect(v?.allowlist).toEqual(CI_BOT_DEFAULT_ALLOWLIST)
  })

  test("explicit comma list ⇒ trimmed, lowercased, non-empty tokens", () => {
    const v = networkProxyKnob.parse(" API.GitHub.com , registry.npmjs.org ,, *.example.com ")
    expect(v?.allowlist).toEqual(["api.github.com", "registry.npmjs.org", "*.example.com"])
  })

  test("single host ⇒ one-entry allowlist", () => {
    expect(networkProxyKnob.parse("internal.corp")?.allowlist).toEqual(["internal.corp"])
  })

  test('"0" / empty / whitespace ⇒ undefined (inactive, fall through)', () => {
    expect(networkProxyKnob.parse("0")).toBeUndefined()
    expect(networkProxyKnob.parse(undefined)).toBeUndefined()
    expect(networkProxyKnob.parse("")).toBeUndefined()
    expect(networkProxyKnob.parse("   ")).toBeUndefined()
  })

  test("a source that reduces to ZERO tokens ⇒ undefined (no silent deny-all)", () => {
    expect(networkProxyKnob.parse(",")).toBeUndefined()
    expect(networkProxyKnob.parse("  ,  , ")).toBeUndefined()
  })
})

describe("network-proxy knob — apply", () => {
  test("active value ⇒ cfg.networkProxy = { enabled: true, allowlist }", () => {
    const v = networkProxyKnob.parse("api.github.com,*.githubusercontent.com")
    if (v === undefined) throw new Error("parse should have returned a value")
    const out = networkProxyKnob.apply(baseCfg(), v, { surface: "cli" })
    expect(out.networkProxy).toEqual({
      enabled: true,
      allowlist: ["api.github.com", "*.githubusercontent.com"],
    })
  })

  test("apply is pure — base cfg not mutated", () => {
    const v = networkProxyKnob.parse("1")
    if (v === undefined) throw new Error("parse should have returned a value")
    const cfg = baseCfg()
    const out = networkProxyKnob.apply(cfg, v, { surface: "cli" })
    expect(out).not.toBe(cfg)
    expect(cfg.networkProxy).toBeUndefined()
  })
})

describe("network-proxy knob — metadata", () => {
  test("id / envKey / category / surfaces / source", () => {
    expect(networkProxyKnob.id).toBe("network-proxy")
    expect(networkProxyKnob.envKey).toBe("QUANTA_NETWORK_PROXY")
    expect(networkProxyKnob.category).toBe("tool")
    expect(networkProxyKnob.surfaces).toContain("cli")
    expect(networkProxyKnob.surfaces).toContain("bench")
    expect(networkProxyKnob.source).toContain("ADR-0428")
  })
})
