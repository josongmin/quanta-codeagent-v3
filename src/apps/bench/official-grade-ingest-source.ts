/**
 * The bench composition root's ONE ingress for an official grader's verdict.
 *
 * PMX-05 gave the report an `officialGrade` section and no writer. This is the
 * writer's front door: a grader phase (a pinned upstream evaluator, run out of
 * process, on a box, outside the agent workspace) drops the
 * `official-grade-ingest` document beside the run's artifacts and names it here;
 * the report layer aggregates it into totals.
 *
 * FAIL-CLOSED, deliberately asymmetric:
 *  - ABSENT ⇒ `undefined` ⇒ no section ⇒ every existing lane is byte-identical.
 *    A run with no official grader is a legitimate, common state.
 *  - PRESENT but unreadable / undecodable / drifted ⇒ THROW. The operator named
 *    a grader verdict; publishing a report that silently omits it would put an
 *    unofficial number on a leaderboard under an official campaign's name.
 *
 * Env-reading lives HERE, at the allowlisted composition root, and the document
 * is decoded by its owner (`runner/batch/official-grade-ingest.ts`).
 */
import { readFileSync } from "node:fs"
import { parseOfficialGradeIngestDocument } from "@/runner/batch/official-grade-ingest"
import type { AggregateOfficialGradeInput } from "@/runner/batch/report-official-grade"

/** Absolute path of the official-grade ingest document this run should publish. */
export const OFFICIAL_GRADE_INGEST_ENV = "QUANTA_OFFICIAL_GRADE_RECEIPT"

export const resolveOfficialGradeReportInput = (
  env: NodeJS.ProcessEnv,
): AggregateOfficialGradeInput | undefined => {
  const raw = env[OFFICIAL_GRADE_INGEST_ENV]
  if (raw === undefined) return undefined
  const path = raw.trim()
  if (path === "") {
    throw new Error(
      `bench: ${OFFICIAL_GRADE_INGEST_ENV} is set but blank. Unset it entirely, or name the ` +
        "official-grade ingest document. REFUSING to publish a campaign report that silently " +
        "drops the grader's verdict.",
    )
  }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    throw new Error(
      `bench: the official-grade ingest document ${path} could not be read ` +
        `(${err instanceof Error ? err.message : String(err)}). REFUSING to write a report ` +
        "without the grader verdict this run claims to have.",
    )
  }
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(
      `bench: the official-grade ingest document ${path} is not JSON ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  const parsed = parseOfficialGradeIngestDocument(json)
  if (!parsed.ok) {
    throw new Error(
      `bench: the official-grade ingest document ${path} was REFUSED — ` +
        parsed.failures.map((f) => `${f.code}: ${f.message}`).join(" | "),
    )
  }
  return parsed.input
}
