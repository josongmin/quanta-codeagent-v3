/**
 * HELLGATE — C5059-05 (prompt half): the system-prompt tool-routing atom's
 * fan-out ENCOURAGEMENT line must be gated by the same `hasDelegationSuppress`
 * facet as the spawn tool descriptions. Otherwise the prompt tells the model to
 * "fan out ... parallel_worker:true" while the tools suppress it — a confound
 * that pollutes the knob-ON A/B.
 *
 * INVARIANTS:
 *  1. OFF (default, facet false) ⇒ BYTE-IDENTICAL — the unconditional fan-out
 *     line renders exactly as before (measurement-arm requirement).
 *  2. ON ⇒ the fan-out line is authorization-conditioned; no unconditional
 *     `parallel_worker:true` encouragement; the rest of the routing table intact.
 *
 * MUTATION (red-on-injection): removing the facet gate (atom renders
 * unconditionally) makes the ON test RED; a base-atom edit that drops the
 * fan-out line makes the OFF test RED.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"
import {
  BODY_AFTER_PERSONA_TOOL_ROUTING,
  BODY_AFTER_PERSONA_TOOL_ROUTING_SUPPRESSED,
  FANOUT_ANCHOR,
} from "@/agent/prompt-body"
import { BODY_AFTER_PERSONA_ATOMS } from "@/agent/prompt-graph/atoms-body"
import { reachableBodyContexts } from "@/agent/prompt-graph/contexts"
import { renderAtoms, selectAtoms } from "@/agent/prompt-graph/render"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

const ctx0 = reachableBodyContexts()[0]
if (ctx0 === undefined) throw new Error("no reachable body context")
const render = (suppress: boolean): string =>
  renderAtoms(BODY_AFTER_PERSONA_ATOMS, { ...ctx0, hasDelegationSuppress: suppress }).join("\n")

describe("C5059-05 — prompt tool-routing fan-out line is knob-gated", () => {
  test("OFF (default) ⇒ unconditional fan-out guidance renders (byte-identical)", () => {
    const off = render(false)
    expect(off).toContain("Need to fan out independent exploration subagents")
    expect(off).toContain("parallel_worker:true")
    expect(off).toContain("Tool routing (the truth condition picks the tool")
  })

  test("ON ⇒ fan-out is authorization-conditioned, not unconditional", () => {
    const on = render(true)
    expect(on).not.toContain("parallel_worker:true")
    expect(on).toContain("EXPLICITLY authorized")
    // The rest of the routing table is intact (only the fan-out line changed).
    expect(on).toContain("search_codebase")
    expect(on).toContain("Tool routing (the truth condition picks the tool")
  })

  test("OFF and ON differ, both keep the routing table body", () => {
    const off = render(false)
    const on = render(true)
    expect(off).not.toBe(on)
    for (const shared of ["search_codebase", "→ grep", "ToolSearch"]) {
      expect(off).toContain(shared)
      expect(on).toContain(shared)
    }
  })
})

// WIRING PROOF — the synthetic render above passes even if the knob never
// reaches the real `buildSystemPrompt` (bodyRenderCtx is a cached static prefix).
// This pins the ACTUAL runtime path so the gate can never regress to inert.
describe("C5059-05 — knob reaches the real buildSystemPrompt (not inert)", () => {
  const KNOB = "QUANTA_SUBAGENT_DELEGATE_SUPPRESS"
  afterEach(() => {
    delete process.env[KNOB]
    __resetRuntimeConfig()
  })
  const build = (on: boolean): string => {
    if (on) process.env[KNOB] = "1"
    else delete process.env[KNOB]
    __resetRuntimeConfig()
    return buildSystemPrompt()
  }

  test("OFF ⇒ unconditional fan-out present (byte-stable default)", () => {
    const off = build(false)
    expect(off).toContain("parallel_worker:true")
    expect(off).not.toContain("EXPLICITLY authorized")
  })

  test("ON ⇒ fan-out authorization-conditioned in the actual system prompt", () => {
    const on = build(true)
    expect(on).not.toContain("parallel_worker:true")
    expect(on).toContain("EXPLICITLY authorized")
  })

  test("the knob genuinely changes the built prompt", () => {
    expect(build(false)).not.toBe(build(true))
  })
})

// STRUCTURAL GUARDS (adversarial test-audit gaps): the `contains` assertions let
// several mutations survive — a variant rendering in ZERO/BOTH contexts, an OFF
// byte-drift, or the derived SUPPRESSED block dropping/keeping a stray line.
describe("C5059-05 — tool-routing variant structural invariants", () => {
  const TR = new Set(["BODY-TOOL-ROUTING", "BODY-TOOL-ROUTING-SUPPRESS"])

  test("EVERY reachable ctx renders EXACTLY ONE tool-routing variant (never zero, never both)", () => {
    // Load-bearing mutual-exclusivity: the two variants share atomId and gate on
    // opposite facet values. Removing a `when`, or setting both to the same
    // condition, breaks this — and the prompt-graph verifier (conflictsWith-only)
    // does NOT catch it. This does.
    for (const ctx of reachableBodyContexts()) {
      const fired = selectAtoms(BODY_AFTER_PERSONA_ATOMS, ctx)
        .map((a) => a.variantId)
        .filter((v) => TR.has(v))
      expect(fired.length, JSON.stringify({ suppress: ctx.hasDelegationSuppress })).toBe(1)
    }
  })

  test("OFF render EXACTLY equals the frozen base tool-routing (byte-identical pin)", () => {
    const offLines = selectAtoms(BODY_AFTER_PERSONA_ATOMS, { ...ctx0, hasDelegationSuppress: false })
      .filter((a) => a.atomId === "BODY-TOOL-ROUTING")
      .flatMap((a) => a.lines)
    expect(offLines).toEqual([...BODY_AFTER_PERSONA_TOOL_ROUTING])
  })

  test("SUPPRESSED == base with ONLY the 3-line fan-out block swapped (no other line dropped/dup)", () => {
    const i = BODY_AFTER_PERSONA_TOOL_ROUTING.indexOf(FANOUT_ANCHOR)
    expect(i).toBeGreaterThanOrEqual(0)
    const head = BODY_AFTER_PERSONA_TOOL_ROUTING.slice(0, i)
    const tail = BODY_AFTER_PERSONA_TOOL_ROUTING.slice(i + 3)
    // head + tail must be byte-identical in the suppressed variant — only the
    // middle (3 fan-out lines → N authorization lines) differs.
    expect(BODY_AFTER_PERSONA_TOOL_ROUTING_SUPPRESSED.slice(0, i)).toEqual([...head])
    expect(
      BODY_AFTER_PERSONA_TOOL_ROUTING_SUPPRESSED.slice(
        BODY_AFTER_PERSONA_TOOL_ROUTING_SUPPRESSED.length - tail.length,
      ),
    ).toEqual([...tail])
    // and the swap actually removed the unconditional fan-out encouragement
    expect(BODY_AFTER_PERSONA_TOOL_ROUTING_SUPPRESSED).not.toContain(FANOUT_ANCHOR)
  })
})
