/**
 * OPC-07 — proof-receipt source-policy classification + typed receipt
 * constructors. Pure classification of already-blind identifiers (ANSWER-KEY
 * SAFE) plus the C3-fenced owner-test/module-smoke RESULT receipt builder.
 */

import {
  type ProofReceiptFact,
  type ProofReceiptSourcePolicy,
  ProofReceiptSourcePolicyError,
  type ProofReceiptState,
} from "./types"

/**
 * B8: map a known free-string receipt `source` identifier to its typed policy
 * class. Unknown identifiers (including dynamic `hard:*` deterministic reasons)
 * return undefined — producers that KNOW the provenance should set `sourcePolicy`
 * explicitly rather than rely on inference. ANSWER-KEY SAFE: pure classification
 * of an already-blind identifier, no test/command text.
 */
export const sourcePolicyOf = (source: string): ProofReceiptSourcePolicy | undefined => {
  if (source.startsWith("hard:")) return "static"
  switch (source) {
    case "public_mwe":
    case "public_repro":
      return "public_repro"
    case "repro_consensus":
      return "public_repro"
    case "discovered_regression":
    case "public_discovered_test":
      return "public_discovered_test"
    case "owner_test":
    case "module_smoke":
      return "official_hidden_withheld"
    case "verify_cmd":
    case "primary_rail":
    case "validation_gate":
      return "public_repro"
    case "selection":
      return "static"
    default:
      return undefined
  }
}

/**
 * B5: an owner-test / module-smoke RESULT receipt — RESULT ONLY, command always
 * WITHHELD (C3 anti-gaming fence). The LLM/router learns whether the owner test
 * or module smoke went green/red and from which source policy, but NEVER the
 * executable selector (which can encode a hidden-test path the content scanner
 * cannot catch). `command` is structurally impossible to set here; `cmdWithheld`
 * is always true.
 *
 *  - kind `owner_test`   ⇒ source `owner_test`,   policy `official_hidden_withheld`
 *  - kind `module_smoke` ⇒ source `module_smoke`, policy `official_hidden_withheld`
 *
 * `result` maps to a correctness/infra STATE: green/red are candidate verdicts,
 * `infra_failed` is a non-correctness execution outcome, `not_run` is absence.
 */
export const ownerTestResultReceipt = (args: {
  readonly kind: "owner_test" | "module_smoke"
  readonly result: "green" | "red" | "infra_failed" | "not_run"
}): ProofReceiptFact => {
  const state: ProofReceiptState =
    args.result === "green"
      ? "candidate_green"
      : args.result === "red"
        ? "candidate_red"
        : args.result === "infra_failed"
          ? "execution_failed"
          : "not_run"
  return {
    source: args.kind,
    sourcePolicy: "official_hidden_withheld",
    state,
    cmdWithheld: true,
  }
}

/** Normalize a receipt's typed source policy, throwing when it cannot be derived. */
export const normalizeProofReceipt = (receipt: ProofReceiptFact): ProofReceiptFact => {
  if (receipt.sourcePolicy !== undefined) return receipt
  const sourcePolicy = sourcePolicyOf(receipt.source)
  if (sourcePolicy === undefined) throw new ProofReceiptSourcePolicyError(receipt.source)
  return { ...receipt, sourcePolicy }
}
