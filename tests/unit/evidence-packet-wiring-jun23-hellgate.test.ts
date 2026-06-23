import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ReproExecPort, ReproWriteFilePort } from "@/agent/repro-test/execute"
import {
  ADAPTIVE_ACTIONS,
  type AdaptiveAction,
} from "@/runner/batch/eval/adaptive-escalation"
import { attachReproVoteOutcomes } from "@/runner/batch/eval/driver"
import type { ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"
import type { InstanceResult } from "@/runner/batch/types"
import {
  assertPacketBlind,
  buildSelectionExplanationPacket,
  type LlmEvidencePacket,
  PHASE_ROUTING_QUESTION,
  renderLlmEvidencePacket,
  type SelectionExplanationLlmEvidenceInput,
  toPhaseRoutingContract,
} from "@/runner/batch/eval/llm-evidence-packet"
import {
  makeReproVoteValidate,
  resetReproVoteOutcomes,
  type ReproVoteOutcomeRecord,
  summarizeReproVoteOutcomes,
} from "@/runner/batch/eval/repair/repro-vote"

/**
 * jun-23 implementation-completeness wiring hellgate — A5 (summarize), B5
 * (owner-test/module-smoke RESULT receipt reaches the rendered packet), A10
 * (router-input packet carries a COHERENT phase-decision stage contract).
 *
 * Each block states its RED-WITHOUT-FIX: the assertion was unsatisfiable before
 * the consumer/wiring was added (the builders existed but were never called /
 * the stage contract was the stale "explain" one).
 */

const PROBLEM = "Fix the regression in widget.render so the output column wraps."

const baseSelectionInput = (
  over: Partial<SelectionExplanationLlmEvidenceInput> = {},
): SelectionExplanationLlmEvidenceInput => ({
  problemStatement: PROBLEM,
  ownerFiles: ["src/widget.py"],
  winnerId: "cand-1",
  candidates: [
    { id: "cand-1", files: ["src/widget.py"], admissible: true, reasons: ["hard:smokeGreen=true"] },
  ],
  ...over,
})

describe("A5 — summarizeReproVoteOutcomes (drain projection)", () => {
  test("empty drain ⇒ undefined (so the driver omits the report field, byte-identical)", () => {
    // RED-WITHOUT-FIX: `summarizeReproVoteOutcomes` did not exist; the driver had
    // no projection to attach drained outcomes to the result.
    expect(summarizeReproVoteOutcomes([])).toBeUndefined()
  })

  describe("ATTACH chain: validator records into the module sink → driver consumer (attachReproVoteOutcomes) carries it onto the result", () => {
    beforeEach(() => {
      // Clear the module sink so this test's record is the only one drained.
      resetReproVoteOutcomes()
    })
    afterEach(() => {
      resetReproVoteOutcomes()
    })

    test("a real vote-decided round surfaces on the result via the EXPORTED driver consumer (not vacuous)", async () => {
      // Drive the SHARED module sink through the real validator (the same sink the
      // production `buildReproVoteValidate` validator writes to — `makeReproVoteValidate`
      // records by construction). Every reproducing script flips to "Issue resolved"
      // ⇒ vote_resolved.
      const writeFile: ReproWriteFilePort = async () => {}
      const exec: ReproExecPort = async () => ({
        code: 0,
        stdout: "Issue resolved\n1 passed in 0.1s",
        stderr: "",
      })
      const fallback = async (): Promise<ValidatorResult> => ({ ok: false, failTail: "legacy" })
      const validate = makeReproVoteValidate({
        sources: ["r1", "r2", "r3"],
        exec,
        writeFile,
        fallback,
      })
      // `args.exec` (an `ExecFn`) is only used by the fallback; the vote runs on
      // the injected `deps.exec` above, so this round never touches it.
      const args: ValidateArgs = {
        sandbox: "/sbx",
        exec: async () => ({ code: 1, stdout: "LEGACY", stderr: "" }),
        timeoutMs: 1000,
      }
      const voteResult = await validate(args)
      expect(voteResult).toEqual({ ok: true })

      // The DRIVER's exported consumer drains the sink onto the result — the wiring
      // the campaign report reads. RED-WITHOUT-FIX: no production code drained the
      // sink, so the outcome was silently dropped and never reached the result.
      const base: InstanceResult = { id: "inst-1", passed: true, patch: "x", turns: 3 }
      const attached = attachReproVoteOutcomes(base)
      expect(attached.reproVoteOutcomes).toBeDefined()
      expect(attached.reproVoteOutcomes?.tally.vote_resolved).toBe(1)
      expect(attached.reproVoteOutcomes?.rounds[0]?.outcome).toBe("vote_resolved")
      expect(attached.reproVoteOutcomes?.rounds[0]?.detail).toEqual({
        resolved: 3,
        reproduced: 0,
        inconclusive: 0,
      })

      // CONSUMING drain — a second attach carries nothing (no double-count / no leak).
      const second = attachReproVoteOutcomes({ id: "inst-2", passed: false, patch: "", turns: 0 })
      expect(second.reproVoteOutcomes).toBeUndefined()
    })
  })

  test("tally counts each outcome AND keeps the per-round detail (vote-decided vs deferred stay distinguishable)", () => {
    const records: ReproVoteOutcomeRecord[] = [
      { outcome: "vote_resolved", detail: { resolved: 3, reproduced: 1, inconclusive: 0 } },
      { outcome: "vote_unresolved", detail: { resolved: 1, reproduced: 2, inconclusive: 0 } },
      { outcome: "empty_sources" },
      { outcome: "vote_resolved", detail: { resolved: 2, reproduced: 0, inconclusive: 0 } },
    ]
    const summary = summarizeReproVoteOutcomes(records)
    expect(summary).toBeDefined()
    // The CONFOUND must be readable: vote-decided rounds separable from deferred.
    expect(summary?.tally).toEqual({
      empty_sources: 1,
      exec_failed: 0,
      vote_resolved: 2,
      vote_unresolved: 1,
      vote_inconclusive: 0,
    })
    // Per-round detail preserved verbatim (not collapsed to counts only).
    expect(summary?.rounds).toEqual(records)
    const voteDecided = new Set(["vote_resolved", "vote_unresolved", "vote_inconclusive"])
    const decided = summary?.rounds.filter((r) => voteDecided.has(r.outcome)).length
    const deferred = (summary?.rounds.length ?? 0) - (decided ?? 0)
    expect(decided).toBe(3)
    expect(deferred).toBe(1)
  })
})

describe("B5 — module-smoke RESULT receipt reaches the rendered packet (command absent, blindness holds)", () => {
  test("moduleSmokeState 'green' ⇒ a module_smoke candidate_green receipt the model sees, with NO command", () => {
    // RED-WITHOUT-FIX: `proofSummaryReceipts` never emitted a module_smoke
    // receipt; the executed smoke result lived only as a gate signal, invisible
    // to the model.
    const packet = buildSelectionExplanationPacket(
      baseSelectionInput({
        proofSummary: {
          proofState: "proof_positive",
          proofSource: "repro_consensus",
          proofRequiredMissing: false,
          contractOnlySubmitted: false,
          contractOnlyBlocked: false,
          moduleSmokeState: "green",
          repairOnlyCandidates: 0,
          submittedCandidateProof: true,
        },
      }),
    )
    const smoke = packet.proofReceipts.find((r) => r.source === "module_smoke")
    expect(smoke).toBeDefined()
    expect(smoke?.state).toBe("candidate_green")
    expect(smoke?.sourcePolicy).toBe("official_hidden_withheld")
    // C3 fence — RESULT ONLY, command structurally withheld.
    expect(smoke?.command).toBeUndefined()
    expect(smoke?.cmdWithheld).toBe(true)
    // ENGAGE: it survives into the EXACT bytes the model is shown.
    const rendered = renderLlmEvidencePacket(packet)
    expect(rendered).toContain("module_smoke")
    expect(rendered).toContain("candidate_green")
    // Blindness invariant still passes on this packet.
    expect(() => assertPacketBlind(packet)).not.toThrow()
  })

  test("moduleSmokeState 'red' ⇒ candidate_red receipt; absent ⇒ no module_smoke receipt (FAIL-OPEN, paired control)", () => {
    const red = buildSelectionExplanationPacket(
      baseSelectionInput({
        proofSummary: {
          proofState: "candidate_red",
          proofSource: "none",
          proofRequiredMissing: false,
          contractOnlySubmitted: false,
          contractOnlyBlocked: false,
          moduleSmokeState: "red",
          repairOnlyCandidates: 0,
          submittedCandidateProof: false,
        },
      }),
    )
    expect(red.proofReceipts.find((r) => r.source === "module_smoke")?.state).toBe("candidate_red")

    // PAIRED CONTROL: flip the one field off → the receipt disappears.
    const absent = buildSelectionExplanationPacket(
      baseSelectionInput({
        proofSummary: {
          proofState: "candidate_red",
          proofSource: "none",
          proofRequiredMissing: false,
          contractOnlySubmitted: false,
          contractOnlyBlocked: false,
          repairOnlyCandidates: 0,
          submittedCandidateProof: false,
        },
      }),
    )
    expect(absent.proofReceipts.find((r) => r.source === "module_smoke")).toBeUndefined()
  })
})

describe("A10 — router-input packet has a COHERENT phase-decision stage contract (not 'explain')", () => {
  const selectionPacket = (): LlmEvidencePacket =>
    buildSelectionExplanationPacket(baseSelectionInput())

  test("the source selection_explanation packet is 'explain'-shaped (the stale contract being fixed)", () => {
    const packet = selectionPacket()
    expect(packet.stage).toBe("selection_explanation")
    expect(packet.question).toContain("Explain")
    expect(packet.allowedActions).toContain("explain_selection_outcome")
  })

  test("toPhaseRoutingContract rewrites stage/question/action-menu to routing; preserves all evidence + blindness", () => {
    // RED-WITHOUT-FIX: there was no re-contract; the router saw a packet whose
    // stage said "selection_explanation" and whose allowedActions said
    // "explain_*", contradicting the router instruction ("choose the next PHASE").
    const source = selectionPacket()
    const routing = toPhaseRoutingContract(source, [...ADAPTIVE_ACTIONS])

    // ONE coherent stage + question + action menu matching the real consumer.
    expect(routing.stage).toBe("phase_routing")
    expect(routing.question).toBe(PHASE_ROUTING_QUESTION)
    expect(routing.question.toLowerCase()).toContain("phase")
    expect(routing.allowedActions).not.toContain("explain_selection_outcome")
    // The action menu is exactly the router's closed action set.
    expect(new Set(routing.allowedActions)).toEqual(
      new Set([...ADAPTIVE_ACTIONS] as AdaptiveAction[]),
    )

    // Evidence BODY preserved byte-for-byte (only the contract changed).
    expect(routing.publicIssueFacts).toEqual(source.publicIssueFacts)
    expect(routing.ownerEvidence).toEqual(source.ownerEvidence)
    expect(routing.proofReceipts).toEqual(source.proofReceipts)
    expect(routing.staticFacts).toEqual(source.staticFacts)

    // The exact bytes the router-model sees carry the routing contract, NOT the
    // stale explain one.
    const rendered = renderLlmEvidencePacket(routing)
    expect(rendered).toContain("phase_routing")
    expect(rendered).not.toContain("explain_selection_outcome")
    expect(() => assertPacketBlind(routing)).not.toThrow()
  })

  test("B5×A10 chain: a module_smoke RESULT receipt survives the routing re-contract into the router-visible bytes", () => {
    // The router path packet for a selection phase carries the module-smoke
    // RESULT (B5) AND the coherent routing contract (A10) together — the receipt
    // is not lost when the contract is rewritten, so the ROUTER (not just the
    // report) sees the executed smoke result. Command still withheld.
    const source = buildSelectionExplanationPacket(
      baseSelectionInput({
        proofSummary: {
          proofState: "proof_positive",
          proofSource: "repro_consensus",
          proofRequiredMissing: false,
          contractOnlySubmitted: false,
          contractOnlyBlocked: false,
          moduleSmokeState: "green",
          repairOnlyCandidates: 0,
          submittedCandidateProof: true,
        },
      }),
    )
    const routing = toPhaseRoutingContract(source, [...ADAPTIVE_ACTIONS])
    const smoke = routing.proofReceipts.find((r) => r.source === "module_smoke")
    expect(smoke?.state).toBe("candidate_green")
    expect(smoke?.command).toBeUndefined()
    expect(smoke?.cmdWithheld).toBe(true)
    const rendered = renderLlmEvidencePacket(routing)
    expect(rendered).toContain("phase_routing")
    expect(rendered).toContain("module_smoke")
    expect(rendered).not.toContain("explain_selection_outcome")
  })
})
