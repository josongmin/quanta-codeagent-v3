/**
 * HELLGATE — v5 adaptive-escalation LLM router PORT FACTORY (jun-22 Wave-3).
 *
 * `makeLlmRouter(deps)` produces the controller's `router` port:
 *   (input: AdaptiveRouterInput<RouterEvidence>) => Promise<unknown>
 * It is the ONLY seam that turns a projected evidence packet into a forced
 * StructuredOutput model call and hands the RAW tool input back to the
 * controller (which validates it fail-closed via `parseAdaptiveDecision`).
 *
 * The model call is an INJECTED dependency so the factory is hermetic — no
 * network. The teeth below pin the contract the controller relies on:
 *
 *  (1) PROMPT-FAITHFUL: the model receives `buildRouterPrompt(packet.rendered)`,
 *      so the prompt CONTAINS the rendered packet body AND the closed action
 *      menu (the model cannot route blind).
 *  (2) RAW PASSTHROUGH: the router returns the model's object verbatim —
 *      identity, no re-shaping — so a downstream `parseAdaptiveDecision` sees
 *      exactly what the model said.
 *  (3) RED-ON-INJECTION: if the model returns junk (or null/garbage), the
 *      router STILL returns it raw and does NOT throw/swallow. Fail-closed is
 *      the controller's job, not the port's.
 *  (4) SCHEMA PINNED: the schema handed to the model IS
 *      `ADAPTIVE_DECISION_JSON_SCHEMA` (same reference), so the forced tool /
 *      structured output is the closed adaptive-decision schema.
 *  (5) MODEL/MAXTOKENS: surfaced via deps with sane defaults (latest Claude
 *      model id), and an explicit override is forwarded to the call.
 */

import { describe, expect, it } from "bun:test"
import { ADAPTIVE_DECISION_JSON_SCHEMA } from "@/runner/batch/eval/adaptive-escalation/decision-schema"
import {
  type AdaptiveModelCall,
  type AdaptiveModelCallArgs,
  DEFAULT_ROUTER_MODEL,
  makeLlmRouter,
} from "@/runner/batch/eval/adaptive-escalation/llm-router"
import type { RouterEvidence } from "@/runner/batch/eval/adaptive-escalation/router-evidence"
import { buildRouterPrompt } from "@/runner/batch/eval/adaptive-escalation/router-prompt"

/** A RouterEvidence double — only `rendered` is load-bearing for the prompt; the
 *  rendered body carries a UNIQUE sentinel so we can prove it reached the call. */
const RENDERED_SENTINEL = "SENTINEL-PACKET-BODY-7f3a (declared condition unevidenced)"
const fakeEvidence = (rendered = RENDERED_SENTINEL): RouterEvidence => ({
  facts: {
    issueId: "issue",
    candidateId: "candidate",
    ownersId: "owners",
    proofId: "proof",
    localizationCertain: false,
    declaredConditionEvidenced: null,
    positiveProof: false,
    multiOwnerLikely: false,
    baseReproEstablished: false,
    regressionSignal: false,
    infraBlocked: false,
  },
  rendered,
  origin: { evidenceRevision: "rev-1", instanceIdHash: "hash-1" },
})

const citableIds = new Set<string>(["issue", "candidate", "owners", "proof"])

/** A fake model-call that RECORDS every arg it received and returns a fixed
 *  reply, so the test can assert exactly what the router sent + got back. */
const recordingCall = (
  reply: unknown,
): { call: AdaptiveModelCall; seen: AdaptiveModelCallArgs[] } => {
  const seen: AdaptiveModelCallArgs[] = []
  const call: AdaptiveModelCall = async (args) => {
    seen.push(args)
    return reply
  }
  return { call, seen }
}

describe("makeLlmRouter — adaptive-escalation router port factory (hellgate)", () => {
  it("TOOTH 1 — sends buildRouterPrompt(packet.rendered): prompt CONTAINS the rendered body AND the action menu", async () => {
    const { call, seen } = recordingCall({ action: "accept_thin" })
    const router = makeLlmRouter({ call })

    await router({ packet: fakeEvidence(), citableIds })

    expect(seen.length).toBe(1)
    const sentPrompt = seen[0]?.prompt
    // The prompt is EXACTLY buildRouterPrompt over the packet's rendered body.
    expect(sentPrompt).toBe(buildRouterPrompt(RENDERED_SENTINEL))
    // ...and that is not vacuous: it contains the packet body verbatim AND the
    // closed action menu, so the model is not routing blind.
    expect(sentPrompt).toContain(RENDERED_SENTINEL)
    expect(sentPrompt).toContain("accept_thin")
    expect(sentPrompt).toContain("stop_infra_or_budget")
    expect(sentPrompt).toContain("EVIDENCE PACKET:")
  })

  it("TOOTH 1b — a DIFFERENT rendered body flows through (paired-control: not a hard-coded prompt)", async () => {
    const other = "WHOLLY-DIFFERENT-BODY-c91b"
    const { call, seen } = recordingCall({ action: "accept_thin" })
    const router = makeLlmRouter({ call })

    await router({ packet: fakeEvidence(other), citableIds })

    expect(seen[0]?.prompt).toBe(buildRouterPrompt(other))
    expect(seen[0]?.prompt).toContain(other)
    expect(seen[0]?.prompt).not.toContain(RENDERED_SENTINEL)
  })

  it("TOOTH 2 — returns the model's raw object VERBATIM (identity, no re-shaping)", async () => {
    const raw = {
      action: "run_proof_clean",
      evidenceGaps: ["candidate_no_positive_proof"],
      citedEvidenceIds: ["proof"],
      why: "needs executed proof",
    }
    const { call } = recordingCall(raw)
    const router = makeLlmRouter({ call })

    const out = await router({ packet: fakeEvidence(), citableIds })
    // Same reference — the controller's parseAdaptiveDecision must see EXACTLY
    // what the model produced.
    expect(out).toBe(raw)
  })

  it("TOOTH 3 — RED-ON-INJECTION: junk model output is returned RAW, never thrown/swallowed", async () => {
    const junk = { action: "totally-made-up", citedEvidenceIds: ["ghost-id"] }
    const { call } = recordingCall(junk)
    const router = makeLlmRouter({ call })

    // The port does NOT throw on garbage, and does NOT coerce/repair it.
    const out = await router({ packet: fakeEvidence(), citableIds })
    expect(out).toBe(junk)
  })

  it("TOOTH 3b — null/non-object model output is also returned raw (fail-closed is the controller's job)", async () => {
    const router = makeLlmRouter({ call: async () => null })
    await expect(router({ packet: fakeEvidence(), citableIds })).resolves.toBeNull()

    const stringRouter = makeLlmRouter({ call: async () => "not json" })
    await expect(stringRouter({ packet: fakeEvidence(), citableIds })).resolves.toBe("not json")
  })

  it("TOOTH 4 — the schema handed to the model IS ADAPTIVE_DECISION_JSON_SCHEMA (same reference)", async () => {
    const { call, seen } = recordingCall({ action: "accept_thin" })
    const router = makeLlmRouter({ call })

    await router({ packet: fakeEvidence(), citableIds })

    expect(seen[0]?.schema).toBe(ADAPTIVE_DECISION_JSON_SCHEMA)
  })

  it("TOOTH 5 — default model is the latest Claude id; overridable via deps; maxTokens forwarded", async () => {
    // Default model is surfaced and is the latest Claude id.
    expect(DEFAULT_ROUTER_MODEL).toBe("claude-opus-4-8")

    const { call, seen } = recordingCall({ action: "accept_thin" })
    const defaulted = makeLlmRouter({ call })
    await defaulted({ packet: fakeEvidence(), citableIds })
    expect(seen[0]?.model).toBe("claude-opus-4-8")
    // sane positive default token budget
    expect(typeof seen[0]?.maxTokens).toBe("number")
    expect((seen[0]?.maxTokens ?? 0) > 0).toBe(true)

    // explicit overrides are forwarded.
    const seen2: AdaptiveModelCallArgs[] = []
    const overridden = makeLlmRouter({
      call: async (a) => {
        seen2.push(a)
        return { action: "accept_thin" }
      },
      model: "claude-sonnet-4-6",
      maxTokens: 256,
    })
    await overridden({ packet: fakeEvidence(), citableIds })
    expect(seen2[0]?.model).toBe("claude-sonnet-4-6")
    expect(seen2[0]?.maxTokens).toBe(256)
  })

  it("TOOTH 6 — propagates the injected call's rejection (does not swallow a real transport error)", async () => {
    const boom = new Error("transport exploded")
    const router = makeLlmRouter({
      call: async () => {
        throw boom
      },
    })
    // A genuine call FAILURE (network/transport) must surface so the controller
    // can classify it — distinct from a junk-but-returned model reply.
    await expect(router({ packet: fakeEvidence(), citableIds })).rejects.toBe(boom)
  })
})
