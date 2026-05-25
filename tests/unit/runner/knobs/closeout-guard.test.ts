/**
 * Knob: `closeout-guard` — parse/apply/surface/exactOptional invariants.
 *
 * Covers:
 *   1. parse — TRUTHY ("1"/"on"/"true") ⇒ {fourRule:false}; "4rule" ⇒
 *      {fourRule:true}.
 *   2. parse — undefined / empty / garbage ⇒ undefined.
 *   3. apply (truthy variant) sets cfg.closeoutGuard = {enabled:true} ONLY
 *      (no `fourRule` key — exactOptionalPropertyTypes-friendly).
 *   4. apply (4rule variant) sets {enabled:true, fourRule:true}.
 *   5. surface filter — `bench` excluded; identity preserved.
 *   6. exactOptionalPropertyTypes — when value.fourRule is false the key is
 *      OMITTED from the resulting closeoutGuard object (not set to false).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { closeoutGuardKnob } from "@/runner/knobs/knobs/closeout-guard"

const baseCfg = (): AgentConfig => ({ cwd: "/repo" }) as AgentConfig

describe("knob: closeout-guard", () => {
  test("parse — truthy tokens → fourRule:false; '4rule' → fourRule:true", () => {
    expect(closeoutGuardKnob.parse("1")).toEqual({ fourRule: false })
    expect(closeoutGuardKnob.parse("on")).toEqual({ fourRule: false })
    expect(closeoutGuardKnob.parse("true")).toEqual({ fourRule: false })
    expect(closeoutGuardKnob.parse("4rule")).toEqual({ fourRule: true })
  })

  test("parse — empty / garbage / case-variant ⇒ undefined", () => {
    expect(closeoutGuardKnob.parse(undefined)).toBeUndefined()
    expect(closeoutGuardKnob.parse("")).toBeUndefined()
    expect(closeoutGuardKnob.parse("0")).toBeUndefined()
    expect(closeoutGuardKnob.parse("off")).toBeUndefined()
    expect(closeoutGuardKnob.parse("4Rule")).toBeUndefined()
    expect(closeoutGuardKnob.parse(" 4rule ")).toBeUndefined()
  })

  test("apply (truthy) — enabled:true, NO fourRule key", () => {
    const out = closeoutGuardKnob.apply(baseCfg(), { fourRule: false }, { surface: "cli" })
    expect(out.closeoutGuard).toEqual({ enabled: true })
    // ExactOptional discipline: a host that distinguishes "absent" vs "false"
    // (decideCloseoutGuard does — it checks `=== true`) must see the key
    // absent, not present-and-false.
    expect("fourRule" in (out.closeoutGuard as object)).toBe(false)
  })

  test("apply (4rule) — enabled:true + fourRule:true", () => {
    const out = closeoutGuardKnob.apply(baseCfg(), { fourRule: true }, { surface: "agent-batch" })
    expect(out.closeoutGuard).toEqual({ enabled: true, fourRule: true })
  })

  test("surface filter — bench excluded; identity preserved", () => {
    const cfg = baseCfg()
    const out = closeoutGuardKnob.apply(cfg, { fourRule: true }, { surface: "bench" })
    expect(out).toBe(cfg)
    expect(out.closeoutGuard).toBeUndefined()
  })

  test("exactOptional — applied result shape contains only added key", () => {
    const cfg = baseCfg()
    const out = closeoutGuardKnob.apply(cfg, { fourRule: false }, { surface: "agent-interactive" })
    expect(Object.keys(out).sort()).toEqual(["closeoutGuard", "cwd"].sort())
    expect(out).not.toBe(cfg)
  })
})
