/**
 * PMX-03 — the gold sentinel contract (pure part).
 *
 * A gold preflight asks ONE question: does the REFERENCE patch pass in every
 * selected image? It must not accidentally answer "did the model pass?".
 *
 * WHY NOT JUST SEND THE GOLDEN PATCH AS `model_patch`: upstream's
 * `_process_one_instance` compares the two runs and, when stdout, stderr, and
 * reason all match with no timeout and no model apply error, promotes BOTH to
 * SUCCESS. Feeding gold in as the model prediction is precisely the input that
 * triggers it, so a "100% preflight" could mean nothing at all.
 *
 * The sentinel instead is a deterministic, campaign-unique, syntactically
 * valid-looking patch that is GUARANTEED not to apply: a deletion hunk against
 * a path derived from the campaign id, which therefore exists in no repository.
 * Model and golden then differ on `reason`, so the promotion cannot fire, and
 * the gate reads the two nested verdicts directly:
 *
 *   model = `apply_failed`, golden = `success`, and top-level `passed` IGNORED.
 *
 * Proving the sentinel path absent inside every selected IMAGE is a live
 * concern and belongs to PMX-04.
 */
import { sha256Hex } from "@/apps/bench/promax/provenance"
import type { OfficialGradeReceipt } from "@/runner/batch/eval/official-grade"

/**
 * 16 hex chars derived from the campaign id. Deterministic (the same campaign
 * always produces the same preflight bytes) and unique (two campaigns cannot
 * share a sentinel path, so a leftover directory from one cannot make another's
 * sentinel accidentally APPLY and silently invert the gate).
 */
export const goldSentinelPathToken = (campaignId: string): string =>
  sha256Hex(`quanta-gold-sentinel/v1/${campaignId}`).slice(0, 16)

/** The sentinel's repository-relative path. Never present in a real checkout. */
export const goldSentinelPath = (campaignId: string): string =>
  `.quanta-gold-sentinel-${goldSentinelPathToken(campaignId)}/absent.txt`

/**
 * A well-formed deletion hunk against a path that does not exist. Both arms of
 * upstream's apply command fail on it: `git apply -v` reports the missing file,
 * and the `patch -p1` fallback finds nothing to reverse.
 *
 * It is deliberately NON-EMPTY — an empty patch applies cleanly, which would
 * turn the preflight green while proving nothing.
 */
export const buildGoldSentinelPatch = (campaignId: string): string => {
  const token = goldSentinelPathToken(campaignId)
  const path = goldSentinelPath(campaignId)
  const blob = token.slice(0, 7)
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `index ${blob}..0000000`,
    `--- a/${path}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    `-quanta gold sentinel ${token}`,
    "",
  ].join("\n")
}

export type GoldSentinelGateFailureCode =
  | "sentinel_missing"
  | "golden_not_success"
  | "model_not_apply_failed"

export interface GoldSentinelGateFailure {
  readonly instanceId: string
  readonly code: GoldSentinelGateFailureCode
  readonly message: string
}

export interface GoldSentinelGateResult {
  readonly ok: boolean
  readonly failures: readonly GoldSentinelGateFailure[]
}

/**
 * The preflight gate. Reads the two NESTED verdicts and never `passed`.
 *
 * Failures accumulate across instances: an operator re-freezing a 170-image
 * campaign needs the whole list, not the first bad image.
 */
export const evaluateGoldSentinelGate = (receipt: OfficialGradeReceipt): GoldSentinelGateResult => {
  const failures: GoldSentinelGateFailure[] = []
  for (const instanceId of receipt.assignedInstanceIds) {
    const d = receipt.dispositionsByInstanceId.get(instanceId)
    if (d === undefined) {
      failures.push({
        instanceId,
        code: "sentinel_missing",
        message: `"${instanceId}" was assigned but the evaluator reported nothing for it`,
      })
      continue
    }
    const golden = d.evaluator.golden?.finalResult ?? ""
    if (golden !== "success") {
      failures.push({
        instanceId,
        code: "golden_not_success",
        message: `"${instanceId}" golden verdict is "${golden}", not "success" — the reference patch does not pass in this image`,
      })
      continue
    }
    const model = d.evaluator.model?.finalResult ?? ""
    if (model !== "apply_failed") {
      failures.push({
        instanceId,
        code: "model_not_apply_failed",
        message:
          `"${instanceId}" sentinel model verdict is "${model}", not "apply_failed" — a sentinel ` +
          "that applied (or was promoted) makes this preflight vacuous",
      })
    }
  }
  return { ok: failures.length === 0, failures }
}
