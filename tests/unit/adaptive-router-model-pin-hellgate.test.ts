/**
 * HELLGATE — jun-23 A1: the adaptive-escalation router must run on the resolved
 * router model (`DEFAULT_ROUTER_MODEL` = claude-opus-4-8) + `max_tokens` 1024,
 * NOT the bench solver model it was previously injected.
 *
 * Root cause (Wave-1 trace, confirmed): `StreamInput` carries no model field;
 * a per-call model override in this codebase is done by SWAPPING the `LLMPort`
 * instance. `makeAdaptiveToolModelCall` was injected `deps.llm` (the bench
 * solver port) and streamed against it, so `llm-router.ts`'s resolved
 * `model`/`maxTokens` were inert. The fix builds an OPUS-PINNED port
 * (`buildModelPinnedPort`) and streams the router request against THAT.
 *
 * Teeth:
 *  (A) `buildModelPinnedPort` builds an anthropic adapter pinned to opus +
 *      maxTokens 1024 when an anthropic credential is available, and the model
 *      on the request the router actually streams is claude-opus-4-8 (observed
 *      on the PORT the call uses, not an intermediate default).
 *  (B) end-to-end: makeLlmRouter → pinned makeAdaptiveToolModelCall surfaces the
 *      resolved model via `onResolvedModel`, and `request.maxTokens` is 1024
 *      baked into the port (observable on the fake adapter the factory builds).
 *  (C) documented cross-check fallback: with NO anthropic credential the port
 *      degrades to the base solver port (pinned:false) rather than crashing.
 *
 * RED WITHOUT FIX: before the fix the router was handed `deps.llm` directly, so
 * the model on the request was the solver model (e.g. `claude-sonnet-4-6`) and
 * the opus pin never reached the wire — assertion (A) fails.
 */

import { describe, expect, it } from "bun:test"
import { buildModelPinnedPort, type LLMPort, type StreamEvent, type StreamInput } from "@/llm"
import { ADAPTIVE_DECISION_JSON_SCHEMA } from "@/runner/batch/eval/adaptive-escalation/decision-schema"
import {
  buildAdaptiveRouterModelCall,
  makeAdaptiveToolModelCall,
} from "@/runner/batch/eval/adaptive-escalation/live-model-call"
import {
  type AdaptiveModelCallArgs,
  DEFAULT_ROUTER_MAX_TOKENS,
  DEFAULT_ROUTER_MODEL,
  makeLlmRouter,
} from "@/runner/batch/eval/adaptive-escalation/llm-router"
import type { RouterEvidence } from "@/runner/batch/eval/adaptive-escalation/router-evidence"

const ROUTER_TOOL = "route_adaptive_phase"

/** A fake adapter that RECORDS its construction model + maxTokens and every
 *  StreamInput it receives. Stands in for a real anthropic adapter so the test
 *  can observe the model the router request runs on without a network call. */
class RecordingPort implements LLMPort {
  readonly model: string
  readonly provider = "anthropic"
  readonly bakedMaxTokens: number
  readonly inputs: StreamInput[] = []

  constructor(model: string, maxTokens: number) {
    this.model = model
    this.bakedMaxTokens = maxTokens
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    yield { type: "tool_use_start", id: "r1", name: ROUTER_TOOL }
    yield {
      type: "tool_use_end",
      id: "r1",
      input: { action: "accept_thin", evidenceGaps: [], citedEvidenceIds: [], why: "ok" },
    }
    yield { type: "message_stop", stop_reason: "tool_use" }
  }
}

const SOLVER = new RecordingPort("claude-sonnet-4-6", 8192)

const routerInput = (): { packet: RouterEvidence; citableIds: ReadonlySet<string> } => ({
  packet: { rendered: "RENDERED-EVIDENCE-BODY" } as unknown as RouterEvidence,
  citableIds: new Set<string>(),
})

describe("jun-23 A1 — adaptive router runs on opus + max_tokens 1024 (hellgate)", () => {
  it("A — buildModelPinnedPort pins opus+1024 when an anthropic credential is available", () => {
    let builtWith: { model: string; maxTokens: number } | undefined
    const built = buildModelPinnedPort({
      basePort: SOLVER,
      model: DEFAULT_ROUTER_MODEL,
      maxTokens: DEFAULT_ROUTER_MAX_TOKENS,
      buildAnthropicPort: (a) => {
        builtWith = a
        return new RecordingPort(a.model, a.maxTokens)
      },
    })
    expect(built.pinned).toBe(true)
    // The model the router request will actually run on — opus, not the solver.
    expect(built.model).toBe("claude-opus-4-8")
    expect(built.port.model).toBe("claude-opus-4-8")
    expect((built.port as RecordingPort).bakedMaxTokens).toBe(1024)
    expect(builtWith).toEqual({ model: "claude-opus-4-8", maxTokens: 1024 })
  })

  it("B — end-to-end: the router request streams on the opus-pinned port (observed on the port, not a default)", async () => {
    const { port, model } = buildModelPinnedPort({
      basePort: SOLVER,
      model: DEFAULT_ROUTER_MODEL,
      maxTokens: DEFAULT_ROUTER_MAX_TOKENS,
      buildAnthropicPort: (a) => new RecordingPort(a.model, a.maxTokens),
    })
    const resolved: { requested: string; actual: string | undefined }[] = []
    const call = makeAdaptiveToolModelCall({
      llm: port,
      onResolvedModel: (r) => resolved.push(r),
    })
    const router = makeLlmRouter({ call })
    const out = await router(routerInput())

    // The model on the ACTUAL request the router used is opus — observed on the
    // port the call streamed against (RecordingPort), the real engage receipt.
    const recorder = port as RecordingPort
    expect(recorder.inputs).toHaveLength(1)
    expect(recorder.model).toBe("claude-opus-4-8")
    expect(recorder.bakedMaxTokens).toBe(1024)
    expect(recorder.inputs[0]?.toolChoice).toEqual({ kind: "tool", name: ROUTER_TOOL })

    // The resolved model the router asked for is honored (not inert): the
    // cross-check observes requested=opus AND the port actually runs opus.
    expect(resolved).toEqual([{ requested: "claude-opus-4-8", actual: "claude-opus-4-8" }])
    expect(model).toBe("claude-opus-4-8")
    expect(out).toEqual({
      action: "accept_thin",
      evidenceGaps: [],
      citedEvidenceIds: [],
      why: "ok",
    })
    // schema pinned through (sanity the call still works as before)
    expect(ADAPTIVE_DECISION_JSON_SCHEMA).toBeDefined()
  })

  it("C — documented cross-check: degrades to the base solver port when no anthropic credential", () => {
    const built = buildModelPinnedPort({
      basePort: SOLVER,
      model: DEFAULT_ROUTER_MODEL,
      maxTokens: DEFAULT_ROUTER_MAX_TOKENS,
      buildAnthropicPort: () => null, // no anthropic credential ⇒ cannot serve opus
    })
    expect(built.pinned).toBe(false)
    expect(built.port).toBe(SOLVER)
    expect(built.model).toBe("claude-sonnet-4-6")
  })

  it("RED-ANCHOR — the OLD wiring (router handed the solver port) runs on the WRONG model", async () => {
    // This reproduces the pre-fix injection (`{ llm: deps.llm }`) and proves the
    // bug it caused: the request runs on the solver model, never opus. The fix
    // is to NOT inject the solver port — inject the opus pin.
    const resolved: { requested: string; actual: string | undefined }[] = []
    const call = makeAdaptiveToolModelCall({
      llm: SOLVER, // <-- the WRONG (pre-fix) port
      onResolvedModel: (r) => resolved.push(r),
    })
    await makeLlmRouter({ call })(routerInput())
    // requested is the opus pin, but the port the request actually ran on is the
    // solver model — the exact inert-field bug A1 fixes at the call site.
    expect(resolved).toEqual([{ requested: "claude-opus-4-8", actual: "claude-sonnet-4-6" }])
    expect(SOLVER.model).not.toBe("claude-opus-4-8")
  })

  it("guards the constants this ticket pins", () => {
    expect(DEFAULT_ROUTER_MODEL).toBe("claude-opus-4-8")
    expect(DEFAULT_ROUTER_MAX_TOKENS).toBe(1024)
  })
})

describe("jun-23 A1 — buildAdaptiveRouterModelCall (the driver injection seam)", () => {
  it("pins opus+1024 and runs the router request on it (the seam both drivers call)", async () => {
    const built: { model: string; maxTokens: number }[] = []
    let pinnedPort: RecordingPort | undefined
    const resolved: { requested: string; actual: string | undefined; pinned: boolean }[] = []
    const freshSolver = new RecordingPort("claude-sonnet-4-6", 8192)
    const call = buildAdaptiveRouterModelCall({
      basePort: freshSolver,
      env: {}, // env is unused because buildAnthropicPort is injected
      buildAnthropicPort: (a) => {
        built.push(a)
        pinnedPort = new RecordingPort(a.model, a.maxTokens)
        return pinnedPort
      },
      onResolvedModel: (r) => resolved.push(r),
    })
    await makeLlmRouter({ call })(routerInput())

    expect(built).toEqual([{ model: "claude-opus-4-8", maxTokens: 1024 }])
    // The actual wire request ran on the opus-pinned port, NOT the solver port.
    expect(pinnedPort?.inputs).toHaveLength(1)
    expect(freshSolver.inputs).toHaveLength(0)
    expect(resolved).toEqual([
      { requested: "claude-opus-4-8", actual: "claude-opus-4-8", pinned: true },
    ])
  })

  it("degrades to the solver port (documented cross-check) when no anthropic credential", async () => {
    const resolved: { requested: string; actual: string | undefined; pinned: boolean }[] = []
    const base = new RecordingPort("claude-sonnet-4-6", 8192)
    const call = buildAdaptiveRouterModelCall({
      basePort: base,
      env: {},
      buildAnthropicPort: () => null, // no anthropic credential available
      onResolvedModel: (r) => resolved.push(r),
    })
    await makeLlmRouter({ call })(routerInput())
    // The request ran on the base solver port and the degrade is OBSERVABLE
    // (pinned:false, actual=solver model) — not an inert field, not a crash.
    expect(base.inputs).toHaveLength(1)
    expect(resolved).toEqual([
      { requested: "claude-opus-4-8", actual: "claude-sonnet-4-6", pinned: false },
    ])
  })
})

// satisfy unused-import lint for the type referenced only in jsdoc/positions
export type _AdaptiveModelCallArgs = AdaptiveModelCallArgs
