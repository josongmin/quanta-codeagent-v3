/**
 * ALBB-14 double-arm fix — the REPL owns a PERSISTENT session-scoped automation
 * ticker (armed once, alive across active turns AND idle prompt windows). The
 * per-turn `runAgent` config path would ALSO arm the shared-lifecycle bootstrap
 * ticker (`maybeStartAutomationTicker` / `startAutomationEngineTicker`) on the
 * SAME engine — a SECOND `setInterval` during every turn (double-tick).
 *
 * `stripAutomationTickerHandler` drops the `handler` from the config-path slot
 * so the bootstrap ticker short-circuits (returns `undefined` when `handler` is
 * absent), leaving the REPL ticker the SINGLE owner — while `engine` survives
 * for the `automation_update` tool.
 *
 * MUTATION GUARD: if `stripAutomationTickerHandler` is reverted to return the
 * slot UNCHANGED (handler intact), §2 goes RED — the bootstrap ticker arms a
 * second timer on the config-path slot (the double-arm the audit flagged).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import { inMemoryAutomationEngine } from "@/scheduler/automation-engine"
import { nth } from "../../../../../tests/_helpers/expect-present"
import { stripAutomationTickerHandler } from "../session-loop"

const fakeIntervalDeps = () => {
  const arms: Array<{ cleared: boolean }> = []
  return {
    arms,
    deps: {
      setInterval: (_cb: () => void, _ms: number): unknown => {
        const arm = { cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (h: unknown): void => {
        ;(h as { cleared: boolean }).cleared = true
      },
    },
  }
}

const liveSlot = (): NonNullable<AgentConfig["automationEngine"]> => ({
  engine: inMemoryAutomationEngine(),
  handler: async () => {},
  tickIntervalMs: 25,
  now: () => 0,
})

const cfgWith = (slot: NonNullable<AgentConfig["automationEngine"]> | undefined): AgentConfig =>
  ({ automationEngine: slot }) as unknown as AgentConfig

describe("ALBB-14 automation ticker — single owner (no double-arm)", () => {
  // §1 CONTROL — the REPL's OWN slot (handler intact) MUST arm a ticker; this is
  // the persistent owner. If this failed the whole delivery would be dead, so it
  // proves the interval deps + slot shape actually arm.
  test("§1 REPL-owned slot (handler intact) arms the persistent ticker", () => {
    const { arms, deps } = fakeIntervalDeps()
    const slot = liveSlot()
    const handle = startAutomationEngineTicker(cfgWith(slot), deps)
    expect(handle).toBeDefined()
    expect(arms.length).toBe(1)
    handle?.stop()
    expect(nth(arms, 0, "arms").cleared).toBe(true)
  })

  // §2 RED-ON-INJECTION — the config-path slot (handler stripped) MUST NOT arm a
  // second ticker. Reverting `stripAutomationTickerHandler` to pass the slot
  // through unchanged makes `startAutomationEngineTicker` arm here ⇒ RED.
  test("§2 config-path slot (handler stripped) does NOT arm — single owner", () => {
    const { arms, deps } = fakeIntervalDeps()
    const original = liveSlot()
    const stripped = stripAutomationTickerHandler(original)
    // `engine` must survive so the `automation_update` tool still registers.
    expect(stripped?.engine).toBe(original.engine)
    // The ORIGINAL still has its handler (REPL ticker owner is untouched).
    expect(original.handler).toBeDefined()
    const handle = startAutomationEngineTicker(cfgWith(stripped), deps)
    expect(handle).toBeUndefined()
    expect(arms.length).toBe(0)
  })

  // §3 undefined passthrough — no slot ⇒ no compose entry (byte-identical off).
  test("§3 undefined slot ⇒ undefined (no compose entry)", () => {
    expect(stripAutomationTickerHandler(undefined)).toBeUndefined()
  })
})
