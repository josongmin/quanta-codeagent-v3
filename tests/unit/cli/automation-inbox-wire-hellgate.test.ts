import { describe, expect, test } from "bun:test"
import type { InboxBanner, InboxBannerOpts } from "@/apps/cli/repl/automation-banner"
import { wireInboxBannerOntoSlot } from "@/apps/cli/repl/automation-banner"
import type { AutomationEnginePort, TickOutcome } from "@/scheduler/automation-engine"

/**
 * #22 — `createInboxBanner` was an ORPHAN (prod caller 0). This proves it is
 * now WIRED via `wireInboxBannerOntoSlot`: the helper composes the banner's
 * `onTick` ONTO the slot's existing `onTick` (errored-telemetry) WITHOUT
 * clobbering it, and is a no-op (byte-identical, same slot reference) when the
 * opt-in gate is OFF.
 */

const fakeEngine = (): AutomationEnginePort => ({}) as AutomationEnginePort

const firedOutcome: TickOutcome = { kind: "fired", automationId: "a1" } as TickOutcome

/** A recording banner double so the test observes that the slot's composed
 *  `onTick` actually reaches `banner.onTick`. */
const recordingBanner = (): InboxBanner & { ticks: TickOutcome[] } => {
  const ticks: TickOutcome[] = []
  return {
    ticks,
    paint: async () => undefined,
    onTick: (o) => {
      ticks.push(o)
    },
    lastCount: null,
  }
}

describe("#22 — wireInboxBannerOntoSlot composes the inbox banner onto the slot", () => {
  test("enabled ⇒ slot.onTick reaches BOTH the prior onTick AND the banner", () => {
    const priorTicks: TickOutcome[] = []
    const banner = recordingBanner()
    const slot = {
      engine: fakeEngine(),
      onTick: (o: TickOutcome): void => {
        priorTicks.push(o)
      },
    }
    const { slot: wired, banner: returned } = wireInboxBannerOntoSlot(slot, {
      enabled: true,
      createBanner: (_opts: InboxBannerOpts) => banner,
    })
    expect(returned).toBe(banner)
    // Drive the composed onTick — both observers must see the outcome.
    wired.onTick?.(firedOutcome)
    expect(priorTicks).toEqual([firedOutcome]) // prior NOT clobbered
    expect(banner.ticks).toEqual([firedOutcome]) // banner now reached
  })

  test("enabled with NO prior onTick ⇒ banner still reached (no throw)", () => {
    const banner = recordingBanner()
    const slot = { engine: fakeEngine() }
    const { slot: wired } = wireInboxBannerOntoSlot(slot, {
      enabled: true,
      createBanner: () => banner,
    })
    wired.onTick?.(firedOutcome)
    expect(banner.ticks).toEqual([firedOutcome])
  })

  test("disabled (gate OFF) ⇒ SAME slot reference, no banner (byte-identical)", () => {
    let bannerBuilt = false
    const slot = {
      engine: fakeEngine(),
      onTick: (): void => undefined,
    }
    const { slot: wired, banner } = wireInboxBannerOntoSlot(slot, {
      enabled: false,
      createBanner: () => {
        bannerBuilt = true
        return recordingBanner()
      },
    })
    expect(wired).toBe(slot) // untouched — same object
    expect(banner).toBeUndefined()
    expect(bannerBuilt).toBe(false) // no banner constructed when gated off
  })
})
