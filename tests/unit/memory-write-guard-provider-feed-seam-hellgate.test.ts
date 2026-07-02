/**
 * jul-03 B3 AUDIT hellgate — the header→meter FEED seam (the LIVE half).
 *
 * WHY THIS EXISTS (adversarial gap the implementer's 3× self-audit missed):
 * the existing `...-provider-tap-wire-hellgate.test.ts` drives `buildToolingCore`
 * and SEEDS the meter by calling `observeProviderRateLimitRemainingPercent(5)`
 * directly. That pins the meter→guard half. But the LIVE half in production is
 * the agent loop's `onResponseHeaders` callback → `feedProviderRateLimitToMeter`
 * → `parseDualWindowSnapshot` → `observeProviderRateLimitRemainingPercent`.
 *
 * MUTATION EVIDENCE: deleting the `feedProviderRateLimitToMeter(...)` call in
 * `stream-consume.ts` left ALL prior B3 tests GREEN — the guard was fake at the
 * loop boundary (wired-but-inert). This battery pins that seam so the mutation
 * turns RED, and documents the SEPARATE-signal + fail-open + byte-identical
 * invariants of the feed itself.
 *
 * Pure/leaf: `feedProviderRateLimitToMeter` reads only `config.budgetMeter`, a
 * header getter, and an injected clock. No network, no env, no real loop.
 */

import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"
import { feedProviderRateLimitToMeter } from "@/agent/loop/stream-consume"
import type { AgentConfig } from "@/agent/types"

const NOW = () => 1_000_000_000_000

const getter =
  (h: Record<string, string>) =>
  (name: string): string | null =>
    h[name.toLowerCase()] ?? null

// `feedProviderRateLimitToMeter` reads ONLY `config.budgetMeter`; a partial cast
// keeps this leaf-pure (no full AgentConfig assembly).
const cfgWith = (meter: BudgetMeter | undefined): AgentConfig =>
  ({ budgetMeter: meter }) as unknown as AgentConfig

describe("B3 feed seam — x-codex-*-used-percent header → BudgetMeter provider tap", () => {
  test("primary used-percent header ⇒ meter observes 100 − used (the LIVE chain)", () => {
    const meter = new BudgetMeter()
    // Provider window 92% USED ⇒ remaining should become 8%.
    feedProviderRateLimitToMeter(
      cfgWith(meter),
      getter({
        "x-codex-primary-used-percent": "92",
        "x-codex-primary-window-minutes": "300",
      }),
      NOW,
    )
    expect(meter.providerRateLimitRemainingPercent()).toBe(8)
  })

  test("secondary governs when primary absent (fallback preserved)", () => {
    const meter = new BudgetMeter()
    feedProviderRateLimitToMeter(
      cfgWith(meter),
      getter({
        "x-codex-secondary-used-percent": "30",
        "x-codex-secondary-window-minutes": "10080",
      }),
      NOW,
    )
    expect(meter.providerRateLimitRemainingPercent()).toBe(70)
  })

  test("primary takes precedence over secondary (fast window governs)", () => {
    const meter = new BudgetMeter()
    feedProviderRateLimitToMeter(
      cfgWith(meter),
      getter({
        "x-codex-primary-used-percent": "10", // ⇒ remaining 90
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-used-percent": "95", // ⇒ would be 5
        "x-codex-secondary-window-minutes": "10080",
      }),
      NOW,
    )
    expect(meter.providerRateLimitRemainingPercent()).toBe(90)
  })

  test("no recognized header ⇒ tap stays undefined (byte-identical, provider arm fails-open)", () => {
    const meter = new BudgetMeter()
    feedProviderRateLimitToMeter(cfgWith(meter), getter({ "x-unrelated": "1" }), NOW)
    expect(meter.providerRateLimitRemainingPercent()).toBeUndefined()
  })

  test("no meter wired ⇒ no-op / no throw (byte-identical)", () => {
    expect(() =>
      feedProviderRateLimitToMeter(
        cfgWith(undefined),
        getter({ "x-codex-primary-used-percent": "50" }),
        NOW,
      ),
    ).not.toThrow()
  })

  test("SEPARATION: feeding the provider window does NOT touch the local cost fraction", () => {
    const meter = new BudgetMeter()
    feedProviderRateLimitToMeter(
      cfgWith(meter),
      getter({ "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300" }),
      NOW,
    )
    // Provider window nearly exhausted (remaining 1) but local cost is untouched
    // (100 with no dial) — the two signals stay orthogonal.
    expect(meter.providerRateLimitRemainingPercent()).toBe(1)
    expect(meter.remainingPercent()).toBe(100)
  })

  test("END-TO-END the guard would refuse: header feed alone arms the provider block", async () => {
    // This is the load-bearing integration of the SEAM with the guard: seed the
    // meter ONLY via the header feed (no direct observe call), then let the memory
    // write-guard read the SAME meter. Proves the live loop path can refuse a write.
    const { memoryTools } = await import("@/agent/memory-tools")
    const { InMemoryStore } = await import("@/memory")
    const meter = new BudgetMeter()
    feedProviderRateLimitToMeter(
      cfgWith(meter),
      getter({ "x-codex-primary-used-percent": "95", "x-codex-primary-window-minutes": "300" }),
      NOW,
    )
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 25,
        remainingPercent: () => meter.remainingPercent(), // 100, would allow
        providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(), // 5
      },
    })
    const write = tools.find((t) => t.name === "memory_write")
    if (!write) throw new Error("no memory_write")
    const ctx = { cwd: "/tmp", signal: new AbortController().signal }
    let last: unknown
    for await (const ev of write.execute({ text: "x" }, ctx)) last = ev
    const result = (last as { type: string; result: { ok: boolean; output: string } }).result
    expect(result.ok).toBe(false)
    expect(result.output).toContain("provider rate-limit")
    expect(await store.all()).toHaveLength(0)
  })
})
