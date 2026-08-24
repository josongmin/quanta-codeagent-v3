/**
 * PMX-04 — READ the pinned evaluator's `pass-rate.json` into per-instance
 * OFFICIAL STATES.
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
 * ## What this deliberately does NOT do
 *
 * It does not produce the remote layer's legacy verdict arrays. This module says
 * what the evaluator MEASURED — the four official states, all distinct.
 * Squeezing those into the lossier wire shape is a TRANSPORT concern and belongs
 * to the one place that already owns bucket placement
 * (`remote/verdict-buckets.ts`), so every family that ever grades on-box shares
 * one answer instead of each shipping its own.
 *
 * ## Fail-closed
 *
 * An unparseable, empty or drifted artifact yields NOTHING — the chunk then
 * surfaces as "no verdicts", the existing box-loss path. A row the pinned schema
 * cannot read is `infra_invalid`, never `resolved`: a drifted evaluator must not
 * be able to manufacture a pass, which is the only direction that corrupts a
 * score.
 *
 * PURE: parses a string. No I/O.
 */
import type { GradedInstance } from "../../remote/verdict-buckets"
import { classifyOfficialPair } from "./classify"
import { parseOfficialPassRateDocument } from "./official-result"

export const projectProMaxGradedInstances = (artifactText: string): readonly GradedInstance[] => {
  const parsed = parseOfficialPassRateDocument(artifactText)
  if (!parsed.ok) return []

  const graded: GradedInstance[] = []
  for (const row of parsed.rows) {
    if (!row.ok) {
      // A row that cannot even be attributed to an instance is dropped: there is
      // no id to record it against, and inventing one would corrupt the covering
      // partition. An attributable but unreadable row is infra-invalid.
      if (row.instanceId !== null) {
        graded.push({ instanceId: row.instanceId, state: "infra_invalid" })
      }
      continue
    }
    const outcome = classifyOfficialPair(row.golden.finalResult, row.model.finalResult)
    graded.push({ instanceId: row.instanceId, state: outcome.state })
  }

  // A DUPLICATE row is evaluator schema drift, and drift must never manufacture a
  // pass. Downstream, `resolved` is the STRONGEST bucket, so two rows for one
  // instance — one `success`, one anything else — promoted it to resolved. Every
  // copy is collapsed to `infra_invalid` instead: the instance stays in the
  // denominator, and what is reported is the truth, which is that the grade for
  // it cannot be read.
  const counts = new Map<string, number>()
  for (const g of graded) counts.set(g.instanceId, (counts.get(g.instanceId) ?? 0) + 1)
  const emitted = new Set<string>()
  const out: GradedInstance[] = []
  for (const g of graded) {
    if (emitted.has(g.instanceId)) continue // one row per instance, always
    emitted.add(g.instanceId)
    out.push(
      (counts.get(g.instanceId) ?? 0) > 1
        ? { instanceId: g.instanceId, state: "infra_invalid" }
        : g,
    )
  }
  return out
}
