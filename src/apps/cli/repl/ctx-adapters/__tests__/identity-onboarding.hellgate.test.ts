/**
 * B1 (jul-03) hellgate — onboarding identity reachability.
 *
 * `onboarding` is an identity-only virtual mode (NOT a `ModeVariantKey`), so it
 * cannot ride the mode-variant registry. The adapter routes it through a
 * dedicated `onOnboarding` hook. These pin:
 *   - with the hook wired, `set("onboarding")` succeeds, fires the hook exactly
 *     once, and `list()` offers onboarding as a target;
 *   - WITHOUT the hook, `onboarding` is rejected as unknown (byte-identical to the
 *     pre-B1 ship) and `list()` does NOT offer it;
 *   - the mode-cycle onboarding rung is a DISTINCT export, deliberately kept OUT
 *     of the 4-rung permission MODE_CYCLE (shift+tab must never land on it).
 */

import { describe, expect, test } from "bun:test"
import { MODE_VARIANT_KEYS } from "@/agent/system-prompt"
import { MODE_CYCLE, ONBOARDING_RUNG } from "../../../mode-cycle"
import { buildIdentityModeAdapter } from "../identity-mode-adapter"

describe("identity adapter — onboarding virtual mode (B1)", () => {
  const registry = { variantFor: () => ({ mode: "default" as const, identity: [] }) }

  test("with onOnboarding wired: set('onboarding') → 'ok', fires the hook once, listed", () => {
    let fired = 0
    const adapter = buildIdentityModeAdapter({
      registry,
      onOnboarding: () => {
        fired += 1
      },
    })
    expect(adapter.list()).toContain("onboarding")
    expect(adapter.set("onboarding")).toBe("ok")
    expect(fired).toBe(1)
    expect(adapter.get()).toBe("onboarding")
    // a normal ModeVariantKey still works and does NOT fire the onboarding hook
    expect(adapter.set("plan")).toBe("ok")
    expect(fired).toBe(1)
  })

  test("WITHOUT onOnboarding: onboarding is rejected as unknown + NOT listed (byte-identical)", () => {
    const adapter = buildIdentityModeAdapter({ registry })
    expect(adapter.list()).not.toContain("onboarding")
    expect(adapter.list()).toEqual([...MODE_VARIANT_KEYS])
    const res = adapter.set("onboarding")
    expect(res).not.toBe("ok")
    if (res !== "ok") expect(res.kind).toBe("unknown")
  })
})

describe("mode-cycle onboarding rung (B1)", () => {
  test("ONBOARDING_RUNG exists and is an identity rung (key='onboarding')", () => {
    expect(ONBOARDING_RUNG.key).toBe("onboarding")
    expect(ONBOARDING_RUNG.label).toContain("ONBOARD")
  })

  test("onboarding is DELIBERATELY not part of the 4-rung permission MODE_CYCLE", () => {
    // shift+tab cycles permission postures — onboarding has no permission meaning,
    // so it must never appear in this array (it would break the cycle invariant).
    expect(MODE_CYCLE.map((p) => p.key)).not.toContain("onboarding")
    expect(MODE_CYCLE).toHaveLength(4)
  })
})
