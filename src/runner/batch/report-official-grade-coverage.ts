/**
 * C-B (aug-22) — the official-grade section's ONE external anchor.
 *
 * ## Why the section cannot validate itself
 *
 * Everything `decodeOfficialGradeSection` checks is a property of the section
 * ALONE: the covering partition is arithmetic on `totals`, and the row/total
 * cross-checks tie those counts to the section's own two lists. A hand edit that
 * deletes the missing ids, zeroes `totals.missing` and decrements `assigned`
 * satisfies every one of them — the section stays a legal covering partition of
 * a SMALLER campaign, and `coverage = grading_valid / assigned` climbs to 100%
 * because the rows it lost are no longer in the denominator. That is the exact
 * failure mode PMX-03 exists to prevent, arriving through the read boundary
 * instead of through a merge.
 *
 * A section can only be caught by something OUTSIDE it. The report that carries
 * it already holds one: `perInstance`, the run's own record of which instances
 * it attempted, written by a different producer (the batch driver) from a
 * different source (the run, not the grader). So the rule is:
 *
 *   **every instance the run attempted must be NAMED by the section** — as a
 *   graded row or as a named gap.
 *
 * Zero threshold, no heuristic: one unnamed attempt is a refusal. Deleting a
 * missing id now requires deleting the run row that proves the instance was
 * attempted, and that row is what every other surface of the report counts.
 *
 * The check is deliberately DIRECTIONAL. The section may name MORE than the run
 * attempted (a campaign is accountable for instances whose box died before the
 * agent ever ran, and naming them is the honest direction — it can only enlarge
 * the denominator). It may never name FEWER.
 */
import type { OfficialGradeInstanceReceipt, OfficialGradeSection } from "./report-official-grade"
import { OfficialGradePartitionError } from "./report-official-grade"

/** The section's roster: every instance it accounts for, graded or missing. */
export const officialGradeSectionRoster = (section: {
  readonly instances: readonly OfficialGradeInstanceReceipt[]
  readonly missing_instance_ids: readonly string[]
}): ReadonlySet<string> =>
  new Set<string>([...section.instances.map((i) => i.instance_id), ...section.missing_instance_ids])

/**
 * Refuse a section that does not account for every instance the run attempted.
 *
 * `attemptedInstanceIds` are the report's own `perInstance` ids — the campaign's
 * independent record of what it spent an agent on.
 */
export const assertOfficialGradeSectionCoversRun = (
  section: OfficialGradeSection,
  attemptedInstanceIds: readonly string[],
): void => {
  const roster = officialGradeSectionRoster(section)
  const unnamed = [...new Set(attemptedInstanceIds)].filter((id) => !roster.has(id))
  if (unnamed.length > 0) {
    throw new OfficialGradePartitionError(
      `the official-grade section accounts for ${roster.size} instance(s) but the run attempted ` +
        `${new Set(attemptedInstanceIds).size}; ${unnamed.join(", ")} ` +
        "appear(s) in neither section.instances nor missing_instance_ids — " +
        "a campaign may not drop an instance out of its own denominator",
    )
  }
}

/**
 * The report-side wrapper: pull the attempted ids off a raw persisted body and
 * run the reconcile.
 *
 * A body carrying an official section but NO `perInstance` array is refused
 * rather than skipped. Skipping would hand the editor a one-key escape from the
 * only external anchor there is, and no producer writes a graded report without
 * run rows.
 */
export const assertOfficialGradeSectionCoversReportBody = (
  section: OfficialGradeSection,
  body: Record<string, unknown>,
): void => {
  const rows = body.perInstance
  if (!Array.isArray(rows)) {
    throw new OfficialGradePartitionError(
      "a report carrying an officialGrade section must carry its perInstance rows — " +
        "they are the only independent record of what the campaign attempted",
    )
  }
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const id = (row as Record<string, unknown>).id
    if (typeof id === "string" && id !== "") ids.push(id)
  }
  assertOfficialGradeSectionCoversRun(section, ids)
}
