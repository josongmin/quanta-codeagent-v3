/**
 * Repair-seed receipt→fact mappers for the selection executor. These project a
 * candidate's typed proof receipts (MWE / public-regression / repro-consensus)
 * and its hard-reject reasons into the {@link ProofReceiptFact} shape the
 * repair-seed LLM evidence packet consumes. Pure, candidate-local: no dependency
 * on runSelection state. Imported back by the executor's repair cascade.
 *
 * NOTE: the higher-level repair-seed PROMPT builders (oracleFailureRepairSeed,
 * familyRepairSeed, staticSanityRepairSeed, reproFailureTraceSeed,
 * repairPacketText) remain closures inside runSelection — they capture the live
 * selection args/contract-bundle/mode, so moving them is not a pure mechanical
 * lift. The receipt→fact mappers below are the cleanly-extractable slice.
 */

import {
  candidatePatchHash,
  type ProofReceiptFact,
  type ProofReceiptState,
} from "./llm-evidence-packet"
import type { Candidate } from "./selection-types"

/** Tail-bound a string to its last `n` chars (repair-packet size guard). */
export const bounded = (s: string | undefined, n = 1800): string => {
  const v = s ?? ""
  return v.length > n ? v.slice(-n) : v
}

export const mweProofReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
  const receipt = candidate.mweReceipt
  if (receipt === undefined) return []
  const patchHash = candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
  const state: ProofReceiptState =
    receipt.state === "base_red"
      ? "base_red"
      : receipt.state === "base_not_red"
        ? "base_green"
        : receipt.state === "patched_green"
          ? "candidate_green"
          : receipt.state === "candidate_red"
            ? "candidate_red"
            : receipt.state === "execution_failed"
              ? "execution_failed"
              : "not_run"
  return [
    {
      source: "public_mwe",
      state,
      ...(receipt.command !== undefined ? { command: receipt.command } : {}),
      ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
    },
  ]
}

export const publicRegressionReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
  const receipt = candidate.publicRegressionReceipt
  if (receipt === undefined) return []
  const patchHash = candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
  const state: ProofReceiptState =
    receipt.state === "candidate_red"
      ? "candidate_red"
      : receipt.state === "safety_green"
        ? "candidate_green"
        : receipt.state === "execution_failed"
          ? "execution_failed"
          : "not_run"
  return [
    {
      source: "discovered_regression",
      state,
      ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
    },
  ]
}

export const reproConsensusReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
  const receipt = candidate.reproConsensusReceipt
  if (receipt === undefined) return []
  const patchHash = candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
  const sample = receipt.reproTrace.samples.find((trace) => trace.outcome !== "resolved")
  const state: ProofReceiptState =
    receipt.state === "base_red_candidate_green"
      ? "candidate_green"
      : receipt.state === "base_red_candidate_red"
        ? "candidate_red"
        : receipt.state === "execution_failed"
          ? "execution_failed"
          : "not_run"
  return [
    {
      source: "repro_consensus",
      state,
      ...(receipt.state.startsWith("base_red") ? { baseValidatedRed: true } : {}),
      ...(sample?.stdoutTail !== undefined && sample.stdoutTail.trim() !== ""
        ? { stdoutTail: bounded(sample.stdoutTail, 600) }
        : {}),
      ...(sample?.stderrTail !== undefined && sample.stderrTail.trim() !== ""
        ? { stderrTail: bounded(sample.stderrTail, 600) }
        : {}),
      ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
    },
  ]
}

export const hardReasonState = (reason: string): ProofReceiptState =>
  reason.includes("proofInfraBlocked")
    ? "execution_failed"
    : reason.includes("proofRequiredMissing")
      ? "not_run"
      : /candidate_red|=false|red\b/.test(reason)
        ? "candidate_red"
        : reason.includes("staticSanity")
          ? "static_only"
          : "not_run"
