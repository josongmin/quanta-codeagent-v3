/**
 * Knob: `persona` — parse/apply/surface/exactOptional invariants.
 *
 * Covers:
 *   1. parse — valid closed-enum members → that exact value (3 sub-cases).
 *   2. parse — undefined / empty / garbage / case-variant ⇒ undefined.
 *   3. apply on an allowed surface rebuilds cfg.system from buildSystemPrompt.
 *   4. apply on `default` rebuilds the prompt to the no-persona baseline
 *      (byte-identical to `buildSystemPrompt(cwd)`).
 *   5. surface filter — `bench` surface ⇒ cfg untouched (measurement integrity).
 *   6. exactOptionalPropertyTypes — apply does NOT set persona-related fields
 *      that don't exist on AgentConfig; it only mutates the existing `system`
 *      field, and a no-op surface returns the SAME cfg reference.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildSystemPrompt } from "@/agent"
import { personaKnob } from "@/runner/knobs/knobs/persona"

const baseCfg = (): AgentConfig =>
  ({
    cwd: "/repo",
    system: "STALE_SYSTEM_PROMPT",
  }) as AgentConfig

describe("knob: persona", () => {
  test("parse accepts each closed-enum kind", () => {
    expect(personaKnob.parse("default")).toBe("default")
    expect(personaKnob.parse("friendly")).toBe("friendly")
    expect(personaKnob.parse("pragmatic")).toBe("pragmatic")
  })

  test("parse rejects undefined / empty / garbage / case-variant", () => {
    expect(personaKnob.parse(undefined)).toBeUndefined()
    expect(personaKnob.parse("")).toBeUndefined()
    expect(personaKnob.parse(" friendly ")).toBeUndefined()
    expect(personaKnob.parse("FRIENDLY")).toBeUndefined()
    expect(personaKnob.parse("Pragmatic")).toBeUndefined()
    expect(personaKnob.parse("strict")).toBeUndefined()
  })

  test("apply rebuilds cfg.system on an allowed surface (friendly)", () => {
    const out = personaKnob.apply(baseCfg(), "friendly", { surface: "cli" })
    expect(out.system).toBe(buildSystemPrompt("/repo", { persona: "friendly" }))
    expect(out.system).not.toBe("STALE_SYSTEM_PROMPT")
  })

  test("apply with persona=default yields the no-persona baseline (byte-identical)", () => {
    const out = personaKnob.apply(baseCfg(), "default", { surface: "agent-batch" })
    expect(out.system).toBe(buildSystemPrompt("/repo"))
  })

  test("surface filter — bench is excluded, cfg returned unchanged", () => {
    const cfg = baseCfg()
    const out = personaKnob.apply(cfg, "friendly", { surface: "bench" })
    expect(out).toBe(cfg)
    expect(out.system).toBe("STALE_SYSTEM_PROMPT")
  })

  test("exactOptional — apply only writes `system`; identity preserved when filtered out", () => {
    const cfg = baseCfg()
    const ide = personaKnob.apply(cfg, "pragmatic", { surface: "ide" })
    // `ide` is NOT in the SURFACES set → cfg returned unchanged (same ref).
    expect(ide).toBe(cfg)
    // Allowed surface: new object, but ONLY `system` differs from the input.
    const allowed = personaKnob.apply(cfg, "pragmatic", { surface: "agent-interactive" })
    expect(allowed).not.toBe(cfg)
    expect(allowed.cwd).toBe(cfg.cwd)
    expect(Object.keys(allowed).sort()).toEqual(["cwd", "system"].sort())
  })
})
