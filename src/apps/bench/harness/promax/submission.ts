/**
 * PMX-04 — WHAT A GATE SUBMITS TO THE PINNED EVALUATOR, as a typed choice.
 *
 * `runProMaxGate` used to build its payload inline and unconditionally: one
 * synthetic non-applying patch, broadcast to every assigned instance. That is
 * precisely right for Gate 1 (the gold sentinel), and it was also the ONLY thing
 * the runner could do — there was no way to submit real model patches, so Gate 2
 * (the PMX-7 model smoke) had no runner at all.
 *
 * This module owns the payload decision so the runner does not have to know the
 * difference, and so the model path gets its own fail-closed rules instead of
 * inheriting the sentinel's "broadcast one patch to everyone" shape.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns the campaign-level questions the predictions serializer cannot answer:
 * how the submitted patches relate to the ASSIGNED SET, and whether any instance
 * was submitted twice.
 *
 * The BLANK-id check and the explicit field projection — the guard that keeps a
 * gold-bearing `patch` field out of the file the evaluator reads — remain
 * `serializeProMaxPredictions`'s job and are not re-implemented here.
 *
 * Duplicate ids USED to be on that list too, and this paragraph said so. It was
 * wrong: this function collapses the patches into a Map before the serializer
 * ever sees them, so the serializer only ever received `assigned.map(...)`,
 * unique by construction — its `instance_id_duplicated` refusal could not fire
 * on this path. The check had to move here, and the doc is corrected rather than
 * quietly swapped, because a comment that assigns a guard to a module that
 * cannot run it is how the gap survived review in the first place.
 *
 * ## Why the refusals exist
 *
 * Gate 2 requires a covering partition with zero `missing`
 * (`assigned = resolved + model_miss + infra_invalid + ambiguous + missing`):
 *
 *  - an assigned instance with NO row grades as `missing`. That fails the gate
 *    later, further from the cause, after the images and the evaluator have run —
 *    so it is refused HERE, before anything spawns.
 *  - a row for an UNASSIGNED instance would have the pinned evaluator grade work
 *    the campaign never assigned, silently widening the denominator the coverage
 *    number is computed against.
 *  - a DUPLICATED instance was silently last-won: the first patch was discarded
 *    with no failure and no record of which one was graded. Concatenated shard
 *    files and best-of-N exports both take that shape.
 *
 * ## The case that must NOT refuse
 *
 * An EMPTY patch is accepted. An agent that produced nothing is a real,
 * measurable outcome: it must reach the evaluator and come back as a model miss.
 * Dropping it would move a genuine model failure into `missing` — turning a
 * measurement into a measurement HOLE, which is the failure mode this campaign's
 * reporting rules exist to prevent.
 *
 * PURE: no I/O, no clock, no env.
 */
import { buildGoldSentinelPatch } from "./gold-sentinel"

/** One agent-produced patch. `modelPatch` may be empty — see the module note. */
export interface ProMaxSubmittedPatch {
  readonly instanceId: string
  readonly modelPatch: string
}

/**
 * WHICH payload a gate run submits.
 *
 * A discriminated union rather than an optional `patches?` field: "no patches
 * supplied" and "the gold sentinel" are different intentions, and an optional
 * field would let a model run that forgot to pass its patches silently grade a
 * sentinel instead — a green-looking Gate 2 that measured nothing.
 */
export type ProMaxSubmission =
  | { readonly kind: "gold-sentinel" }
  | { readonly kind: "model"; readonly patches: readonly ProMaxSubmittedPatch[] }

export interface ProMaxSubmissionFailure {
  readonly code:
    | "assigned_set_empty"
    | "patch_absent_for_assigned"
    | "patch_not_assigned"
    | "patch_duplicated"
  readonly message: string
}

export type ProMaxSubmissionResult =
  | { readonly ok: true; readonly predictions: readonly ProMaxSubmittedPatch[] }
  | { readonly ok: false; readonly failures: readonly ProMaxSubmissionFailure[] }

/** Stable, readable id list for a refusal message — capped so a 170-instance
 *  mismatch stays legible, with the remainder counted rather than dropped. */
const nameIds = (ids: readonly string[]): string => {
  const shown = ids.slice(0, 5).join(", ")
  return ids.length > 5 ? `${shown} (+${ids.length - 5} more)` : shown
}

/**
 * Build the prediction rows for one gate run.
 *
 * The returned rows are in ASSIGNED order for the model path, so the predictions
 * file, the receipt and the campaign manifest all read in the same order and a
 * diff between two runs is about verdicts rather than ordering.
 */
export const buildProMaxSubmission = (
  submission: ProMaxSubmission,
  campaign: {
    readonly assignedInstanceIds: readonly string[]
    readonly campaignId: string
  },
): ProMaxSubmissionResult => {
  const assigned = campaign.assignedInstanceIds
  if (assigned.length === 0) {
    return {
      ok: false,
      failures: [
        {
          code: "assigned_set_empty",
          message:
            "the campaign assigned no instances. REFUSING — a gate over an empty denominator " +
            "reports 100% coverage of nothing, which reads like a pass.",
        },
      ],
    }
  }

  if (submission.kind === "gold-sentinel") {
    const patch = buildGoldSentinelPatch(campaign.campaignId)
    return {
      ok: true,
      predictions: assigned.map((instanceId) => ({ instanceId, modelPatch: patch })),
    }
  }

  const byId = new Map<string, ProMaxSubmittedPatch>()
  const duplicated: string[] = []
  for (const p of submission.patches) {
    // `byId.set` alone kept the LAST patch and discarded the first, with no
    // failure and no record of which one was graded. Concatenate two shard
    // prediction files, or export a best-of-N run, and the gate scored an
    // arbitrarily chosen patch per instance while reporting a clean coverage.
    //
    // Refusing beats de-duplicating: the caller knows which patch it meant, and
    // picking one for them is exactly how the record was lost. Identical bytes
    // are refused too — two shards claiming one instance is still malformed, and
    // accepting it teaches that duplicates are fine.
    if (byId.has(p.instanceId)) duplicated.push(p.instanceId)
    else byId.set(p.instanceId, p)
  }

  const assignedSet = new Set(assigned)
  const failures: ProMaxSubmissionFailure[] = []

  if (duplicated.length > 0) {
    const unique = [...new Set(duplicated)]
    failures.push({
      code: "patch_duplicated",
      message:
        `${unique.length} instance(s) were submitted more than once: ${nameIds(unique)}. ` +
        "REFUSING — keeping one and discarding the rest would grade an arbitrarily chosen " +
        "patch and leave no record of which produced the number.",
    })
  }

  const absent = assigned.filter((id) => !byId.has(id))
  if (absent.length > 0) {
    failures.push({
      code: "patch_absent_for_assigned",
      message:
        `${absent.length} assigned instance(s) have no submitted patch: ${nameIds(absent)}. ` +
        "REFUSING — an assigned instance with no row grades as `missing`, which fails the " +
        "gate's covering partition after the images and the evaluator have already run. " +
        "Submit an EMPTY patch for an instance the agent produced nothing for: that is a " +
        "model miss, which is a measurement, rather than a hole.",
    })
  }

  const unassigned = [...byId.keys()].filter((id) => !assignedSet.has(id))
  if (unassigned.length > 0) {
    failures.push({
      code: "patch_not_assigned",
      message:
        `${unassigned.length} submitted patch(es) name an instance this campaign did not ` +
        `assign: ${nameIds(unassigned)}. REFUSING — grading them would widen the denominator ` +
        "that coverage is measured against.",
    })
  }

  if (failures.length > 0) return { ok: false, failures }

  // ASSIGNED order, not submission order — see the doc comment.
  return {
    ok: true,
    predictions: assigned.map((id) => {
      const found = byId.get(id)
      // unreachable: `absent` above is empty here, so every assigned id has a row.
      /* c8 ignore next */
      if (found === undefined) throw new Error(`promax submission: no patch for ${id}`)
      return { instanceId: id, modelPatch: found.modelPatch }
    }),
  }
}
