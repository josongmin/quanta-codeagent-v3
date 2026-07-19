/**
 * Unified knob-override store + runtimeConfig live-control (ADR-0503 P4 R0/R1).
 *
 * The structural win: making the ONE `runtimeConfig()` accessor session-aware
 * makes ALL ~145 runtime-config knobs live-toggleable via `/knobs set` — with
 * ZERO read-site edits — while staying byte-identical when no override is set.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetKnobOverrides,
  filterSessionForbidden,
  getKnobOverride,
  knobOverrideCount,
  knobOverrides,
  knobOverridesVersion,
  setKnobOverride,
} from "@/shared"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"

afterEach(() => {
  __resetKnobOverrides()
  __resetRuntimeConfig()
})

describe("knob-overrides store (ADR-0503 P4 R0)", () => {
  test("set / get / clear / snapshot", () => {
    setKnobOverride("QUANTA_X", "1")
    expect(getKnobOverride("QUANTA_X")).toBe("1")
    expect(knobOverrides()).toEqual({ QUANTA_X: "1" })
    expect(knobOverrideCount()).toBe(1)
    setKnobOverride("QUANTA_X", undefined)
    expect(getKnobOverride("QUANTA_X")).toBeUndefined()
    expect(knobOverrideCount()).toBe(0)
  })

  test("version bumps only on EFFECTIVE change (cache-key integrity)", () => {
    const v0 = knobOverridesVersion()
    setKnobOverride("QUANTA_X", "1")
    const v1 = knobOverridesVersion()
    expect(v1).toBeGreaterThan(v0)
    setKnobOverride("QUANTA_X", "1") // same value → no bump
    expect(knobOverridesVersion()).toBe(v1)
    setKnobOverride("QUANTA_X", "2") // changed → bump
    expect(knobOverridesVersion()).toBeGreaterThan(v1)
  })
})

describe("runtimeConfig() is session-aware (ADR-0503 P4 R1 — 145 knobs, 0 read-site edits)", () => {
  test("a /knobs set override is LIVE on the next runtimeConfig() read", () => {
    const before = runtimeConfig().logLevel
    expect(before).not.toBe("debug") // (test env isn't pinned to debug)
    setKnobOverride("QUANTA_LOG_LEVEL", "debug")
    // no __resetRuntimeConfig — the version-keyed cache rebuilds itself
    expect(runtimeConfig().logLevel).toBe("debug")
    // clearing reverts live
    setKnobOverride("QUANTA_LOG_LEVEL", undefined)
    expect(runtimeConfig().logLevel).toBe(before)
  })

  test("byte-identical when NO overrides (merged bag === process.env)", () => {
    __resetKnobOverrides()
    __resetRuntimeConfig()
    const a = runtimeConfig()
    const b = runtimeConfig() // cached, same object
    expect(a).toBe(b)
    expect(knobOverrideCount()).toBe(0)
  })

  test("override reflects across MULTIPLE knobs at once (one accessor, many knobs)", () => {
    setKnobOverride("QUANTA_LOG_LEVEL", "warn")
    setKnobOverride("QUANTA_BG_COMPACTION", "1")
    const cfg = runtimeConfig()
    expect(cfg.logLevel).toBe("warn")
    expect(cfg.bgCompaction).toBe(true)
  })
})

describe("SECURITY carve-out — strict knobs are NOT session-settable (RFC §4.3)", () => {
  test("setKnobOverride REFUSES security-boundary knobs (returns false, no store)", () => {
    for (const k of [
      "QUANTA_CODE_MODE",
      "QUANTA_CODE_MODE_ONLY",
      "QUANTA_FS_JAIL",
      "QUANTA_TLS_MITM",
      "QUANTA_CENTRAL_CONFIG",
      "QUANTA_LLM_CREDENTIAL_TRUSTED",
    ]) {
      expect(setKnobOverride(k, "1")).toBe(false)
      expect(getKnobOverride(k)).toBeUndefined()
    }
  })

  test("a session set CANNOT enable code-mode via runtimeConfig (the R1 regression guard)", () => {
    expect(runtimeConfig().codeMode).toBe(false)
    setKnobOverride("QUANTA_CODE_MODE", "1") // refused
    expect(runtimeConfig().codeMode).toBe(false) // still off — override never landed
  })

  test("a benign gateOnStrict knob (bgCompaction) IS still session-settable", () => {
    expect(setKnobOverride("QUANTA_BG_COMPACTION", "1")).toBe(true)
    expect(runtimeConfig().bgCompaction).toBe(true)
  })

  // D2 (AUDIT-2026-07-14, INV-G6 / RFC jul-13 §6.1 rule 5) — the sub-agent nesting
  // POLICY CEILING must be session-pinned: a mid-session widen must NOT raise the cap.
  test("the nesting-policy knobs are session-FORBIDDEN (refused, not stored)", () => {
    for (const k of [
      "QUANTA_MAX_DESCENDANT_DEPTH",
      "QUANTA_MAX_SPAWN_DEPTH",
      "QUANTA_SUBAGENT_MAX_DEPTH",
    ]) {
      expect(setKnobOverride(k, "5")).toBe(false)
      expect(getKnobOverride(k)).toBeUndefined()
    }
  })

  test("a session set CANNOT widen maxDescendantDepth via runtimeConfig (kill-switch cannot be lifted)", () => {
    // Default policy = 1 (root-only). A forged widen to 5 must NOT land.
    expect(runtimeConfig().maxDescendantDepth).toBe(1)
    // RED-ON-INJECTION: remove "QUANTA_MAX_DESCENDANT_DEPTH" from
    // SESSION_FORBIDDEN_KNOBS and this override lands ⇒ cap becomes 5 ⇒ RED.
    expect(setKnobOverride("QUANTA_MAX_DESCENDANT_DEPTH", "5")).toBe(false)
    expect(runtimeConfig().maxDescendantDepth).toBe(1) // still pinned to policy
  })

  // Reader-side defense-in-depth (C1): `filterSessionForbidden` is what
  // `runtimeConfig()` merges instead of raw `knobOverrides()`. The store can never
  // hold a forbidden key (writer gate), so testing it through the store is vacuous —
  // the PURE filter is tested with a forbidden key PRESENT to prove it drops it even
  // if a future writer bypassed the gate.
  test("filterSessionForbidden DROPS forbidden keys, KEEPS allowed (reader backstop)", () => {
    const filtered = filterSessionForbidden({
      QUANTA_CODE_MODE: "1", // security-forbidden ⇒ dropped
      QUANTA_MAX_DESCENDANT_DEPTH: "5", // nesting-policy forbidden ⇒ dropped
      QUANTA_LOG_LEVEL: "debug", // allowed ⇒ survives
      QUANTA_MICROCOMPACT: "1", // allowed ⇒ survives
    })
    // RED-ON-INJECTION: if the filter returned the record as-is (drop neutralized),
    // the two forbidden keys would be present and these go RED.
    expect("QUANTA_CODE_MODE" in filtered).toBe(false)
    expect("QUANTA_MAX_DESCENDANT_DEPTH" in filtered).toBe(false)
    expect(filtered).toEqual({ QUANTA_LOG_LEVEL: "debug", QUANTA_MICROCOMPACT: "1" })
  })

  // Paired control: an all-allowed record passes through UNCHANGED (no over-drop).
  test("filterSessionForbidden is byte-identical for an all-allowed record (no over-drop)", () => {
    const allowed = { QUANTA_LOG_LEVEL: "info", QUANTA_MICROCOMPACT: "1" }
    expect(filterSessionForbidden(allowed)).toEqual(allowed)
  })
})
