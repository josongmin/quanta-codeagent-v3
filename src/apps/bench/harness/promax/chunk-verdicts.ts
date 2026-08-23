/**
 * PMX-04 — PROJECT the pinned evaluator's `pass-rate.json` into the four verdict
 * id-sets a chunk reports.
 *
 * Every other family grades inline during patch-gen, so its chunk reads verdicts
 * out of the bench `report.json`. ProMax cannot: the agent phase runs with the
 * answer key ABSENT (its `absenceProbe` proves it) and grading needs the key
 * present, so they are two on-box invocations. The report from the patch-gen
 * pass records every instance as an explicit "requires the official Python
 * harness — REFUSING to fake-grade" infra error, by construction; reading
 * verdicts from it would report a total infra failure for a chunk that graded
 * fine.
 *
 * ## The mapping, and the one place it is lossy on purpose
 *
 * The official grade has four STATES; the chunk transport has four BUCKETS; they
 * do not line up. `ambiguous` has no bucket of its own and is mapped to
 * `errored`, NOT to `unresolved`. The direction is the point:
 *
 *   `unresolved` says "the model tried and failed" — a claim about the MODEL;
 *   `ambiguous`  says the GRADE is undecided (upstream reaches it for
 *                `need_human_review`).
 *
 * Recording an undecided grade as a measured model miss would inflate the
 * denominator of everything computed from these sets. Recording it as an error
 * is honest about what is known.
 *
 * The AUTHORITATIVE ProMax verdicts are the official grade receipt, which keeps
 * all four states distinct. This projection is pool/dashboard bookkeeping, and
 * it exists so the chunk's own accounting is not a lie.
 *
 * ## Fail-closed
 *
 * An unparseable, empty or drifted artifact yields EMPTY sets — the chunk then
 * surfaces as "no verdicts", which is the existing box-loss/no-verdict path.
 * Nothing here can manufacture a `resolved` from an artifact it could not read,
 * which is the only direction that would corrupt a score.
 *
 * PURE: parses a string. No I/O.
 */
import type { FamilyBoxGradeVerdicts } from "../../profiles/types"
import { classifyOfficialPair } from "./classify"
// The state → bucket table is IMPORTED, never redeclared. PMX-03 owns exactly
// one such mapping; a second copy here would be free to drift, and the audit's
// `legacy_verdict_consumer` detector exists to catch precisely that (it caught
// this file the first time it was written with its own table).
import { LEGACY_BUCKET_BY_STATE } from "@/runner/batch/eval/official-grade"
import { parseOfficialPassRateDocument } from "./official-result"

const empty = (): FamilyBoxGradeVerdicts => ({
  resolved: [],
  unresolved: [],
  errored: [],
  emptyPatch: [],
})

/**
 * Project one evaluator output document into the chunk's verdict sets.
 *
 * `emptyPatch` is always empty here: "the agent produced nothing" is a property
 * of the PREDICTIONS, not of the evaluator's output, and an empty patch reaches
 * the evaluator and comes back as a model miss (see `submission.ts`). Inventing
 * an `emptyPatch` id from a grade row would double-count it.
 */
export const projectProMaxChunkVerdicts = (artifactText: string): FamilyBoxGradeVerdicts => {
  const parsed = parseOfficialPassRateDocument(artifactText)
  if (!parsed.ok) return empty()

  const buckets: {
    resolved: string[]
    unresolved: string[]
    errored: string[]
    emptyPatch: string[]
  } = { resolved: [], unresolved: [], errored: [], emptyPatch: [] }

  for (const row of parsed.rows) {
    // A row the pinned schema cannot read is an ERROR, never a resolution: a
    // drifted evaluator must not be able to manufacture a pass. A row that
    // cannot even be attributed to an instance (`instanceId: null`) is dropped —
    // there is no id to record it against, and inventing one would corrupt the
    // covering partition.
    if (!row.ok) {
      if (row.instanceId !== null) buckets.errored.push(row.instanceId)
      continue
    }
    const outcome = classifyOfficialPair(row.golden.finalResult, row.model.finalResult)
    buckets[LEGACY_BUCKET_BY_STATE[outcome.state]].push(row.instanceId)
  }

  return buckets
}
