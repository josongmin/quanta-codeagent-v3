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
import { BODY_AFTER_PERSONA_ATOMS } from "@/agent/prompt-graph/atoms-body"
import { reachableBodyContexts } from "@/agent/prompt-graph/contexts"
import { renderAtoms } from "@/agent/prompt-graph/render"
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
