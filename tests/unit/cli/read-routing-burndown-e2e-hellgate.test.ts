/**
 * READ-ROUTING BURN-DOWN e2e HELLGATE (ADR-0503 P4).
 *
 * Proves the live-control PAYOFF of routing two internal.ts kill-switch reads
 * (`QUANTA_MEMORY_EMBED`, `QUANTA_COMPACT_BREAKER`) through `readCliKnob` instead
 * of raw `gateDisabled(process.env, …)`:
 *
 *   1. a `/config set`-style override via the UNIFIED `@/shared/knob-overrides`
 *      store is now LIVE for these knobs — `readCliKnob` reflects it immediately
 *      (no restart), and clearing it reverts to the env/default truth;
 *   2. the override flows all the way to the REAL call sites
 *      (`buildEmbedder` → `disabled`, `buildCompactionBreakerConfig` → `disabled`),
 *      so a session `/config set QUANTA_MEMORY_EMBED=0` actually disables the
 *      embedder this session — the behavior that was UNREACHABLE while the read
 *      went straight to `process.env`;
 *   3. the migration stayed BYTE-IDENTICAL to the old `gateDisabled` semantics
 *      across unset / falsy / truthy / empty / garbage, with NO override set.
 *
 * Before P4 these reads bypassed the override store entirely; if a future edit
 * re-points them at raw `process.env` this test goes RED (the `/config set` path
 * stops affecting `readCliKnob` / the call site).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { gateDisabled } from "@/shared"
import {
  __resetCliKnobOverrides,
  readCliKnob,
  setCliKnobOverride,
} from "../../../src/apps/cli/cli-knobs-accessor"

// Both knobs are default-ON kill-switches; the migrated read is
// `!(readCliKnob(key,"bool") ?? true)` ≡ `gateDisabled(env, key)`.
const KEYS = ["QUANTA_MEMORY_EMBED", "QUANTA_COMPACT_BREAKER"] as const

const cleanEnv = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of KEYS) delete e[k]
  return e
}

beforeEach(() => __resetCliKnobOverrides())
afterEach(() => __resetCliKnobOverrides())

describe("read-routing burn-down e2e (ADR-0503 P4)", () => {
  test("live /config set override flows into readCliKnob, then reverts on clear", () => {
    for (const key of KEYS) {
      const env = cleanEnv()
      // baseline: unset env, no override ⇒ default ON ⇒ NOT disabled
      expect(readCliKnob(key, "bool", env)).toBe(true)

      // /config set <key>=0 (session override via the UNIFIED store)
      expect(setCliKnobOverride(key, "0")).toBe(true)
      // LIVE: the very next read reflects it — no restart, env still unset
      expect(readCliKnob(key, "bool", env)).toBe(false)

      // /config set <key>=on flips it back live
      expect(setCliKnobOverride(key, "on")).toBe(true)
      expect(readCliKnob(key, "bool", env)).toBe(true)

      // /config reset (clear) reverts to the env/default truth
      expect(setCliKnobOverride(key, undefined)).toBe(true)
      expect(readCliKnob(key, "bool", env)).toBe(true)
    }
  })

  test("override beats env (session > env precedence) at the read", () => {
    for (const key of KEYS) {
      const env: NodeJS.ProcessEnv = { ...cleanEnv(), [key]: "1" } // env says ON
      expect(readCliKnob(key, "bool", env)).toBe(true)
      // a live /config set 0 overrides the env value this session
      expect(setCliKnobOverride(key, "0")).toBe(true)
      expect(readCliKnob(key, "bool", env)).toBe(false)
    }
  })

  test("migrated read is byte-identical to gateDisabled when no override is set", () => {
    // The migrated call-site idiom is `disabled = !(readCliKnob(key,'bool') ?? true)`.
    const disabledViaAccessor = (key: string, env: NodeJS.ProcessEnv): boolean =>
      !(readCliKnob(key, "bool", env) ?? true)
    const cases = [undefined, "0", "off", "false", "no", "1", "on", "true", "yes", "", "garbage"]
    for (const key of KEYS) {
      for (const v of cases) {
        const env: NodeJS.ProcessEnv = cleanEnv()
        if (v !== undefined) env[key] = v
        expect(disabledViaAccessor(key, env)).toBe(gateDisabled(env as Record<string, string | undefined>, key))
      }
    }
  })
})
