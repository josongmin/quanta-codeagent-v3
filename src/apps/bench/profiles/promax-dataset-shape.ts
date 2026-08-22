/**
 * LEAF — the ProMax dataset SHAPE + LEAK check, owned by the profile layer.
 *
 * Mirrors `pro-dataset-shape.ts`: a fail-closed, LOCAL check that runs before a
 * remote box is spent. It refuses two distinct failure modes, each of which
 * otherwise surfaces only as a wasted campaign:
 *
 *  1. MISLABELED CORPUS — a Verified/Pro-shaped JSONL passed as
 *     `--dataset-family promax`. The pinned upstream evaluator keys every
 *     instance by `instance_id` in its own `eval.json` and applies patches
 *     inside the row's own image under `/testbed`; a row with no `image_name` /
 *     `working_dir` / `language` is not a ProMax instance at all, and grading it
 *     would produce infra failures that read as model misses.
 *  2. GOLD ON THE WIRE — a chunk that still carries `patch` / `test_patch`.
 *     Those are grader-only (packet invariant 3) and a chunk file is shipped to
 *     the box the AGENT runs on, so a gold-bearing chunk is a contamination
 *     event, not a formatting nit.
 *
 * The refusal text deliberately reports only field NAMES and lengths — never a
 * gold body — matching PMX-00's leak-boundary discipline.
 *
 * PMX-02: it receives ALREADY-DECODED rows from the ProMax family reader rather
 * than opening the file itself. That matters more here than for Pro: the ProMax
 * corpus is an official JSON ARRAY, so a JSONL-only re-read inside this function
 * would see ZERO rows and the gold-leak check would silently pass on the very
 * file it exists to refuse.
 */
import { RemoteDatasetPreflightError } from "../remote/box-session/dataset-rows"
import type { FamilyCorpusRow } from "./corpus-row"
import { proMaxGraderOnlyKeysPresent } from "./promax-projection"

/** Fields present on ALL 170 upstream rows that the ProMax lane genuinely needs
 *  downstream (identity, repo checkout, image selection, apply directory). Kept
 *  deliberately small: PMX-00 verified `pull_number` / `issue_numbers` are
 *  SPARSE, so requiring them would reject the real corpus. */
//
// PMX-02 CORRECTION to PMX-01: `image_name` and `working_dir` are GRADER
// metadata and live in the grader bundle, NOT in the agent-visible corpus. PMX-01
// required them here, which would have made a correctly-projected ProMax chunk
// fail its own preflight. The columns kept are exactly the PUBLIC ones a run
// needs: identity, checkout coordinates, the problem, and the language label used
// for toolchain preflight.
const PROMAX_REQUIRED_COLUMNS = ["repo", "base_commit", "problem_statement", "language"] as const

/** Accept BOTH the official snake_case spelling and the typed camelCase spelling
 *  of the public artifact, so a chunk sliced from either form validates. */
const PROMAX_COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  repo: ["repo"],
  base_commit: ["base_commit", "baseCommit"],
  problem_statement: ["problem_statement", "problemStatement"],
  language: ["language"],
}

const promaxRowMissingFields = (row: Record<string, unknown>): string[] =>
  PROMAX_REQUIRED_COLUMNS.filter((c) =>
    (PROMAX_COLUMN_ALIASES[c] ?? [c]).every((key) => row[key] === undefined || row[key] === null),
  )

/**
 * FAIL-CLOSED ProMax dataset check. Family-agnostic: the caller (the ProMax
 * profile's `preflight` field) has already decided this applies.
 */
export const assertProMaxDatasetShape = (args: {
  readonly rows: readonly FamilyCorpusRow[]
  readonly instanceIds?: readonly string[] | undefined
  readonly surface: string
}): void => {
  const rows = args.rows
  // Only the OPERATOR-SELECTED rows are validated when an `--instance` filter is
  // present, matching the Pro check: an unselected malformed row must not refuse
  // a run that targets a single sound instance.
  const selected =
    args.instanceIds !== undefined && args.instanceIds.length > 0
      ? new Set(args.instanceIds)
      : undefined

  const malformed: string[] = []
  const leaking: string[] = []
  for (const { instanceId, record } of rows) {
    if (selected !== undefined && !selected.has(instanceId)) continue
    const missing = promaxRowMissingFields(record)
    if (missing.length > 0) malformed.push(`${instanceId} (missing: ${missing.join(", ")})`)
    const gold = proMaxGraderOnlyKeysPresent(record)
    if (gold.length > 0) leaking.push(`${instanceId} (carries: ${gold.join(", ")})`)
  }

  const preview = (rowList: readonly string[]): string =>
    rowList.slice(0, 5).join("; ") + (rowList.length > 5 ? ` (+${rowList.length - 5} more)` : "")

  if (leaking.length > 0) {
    throw new RemoteDatasetPreflightError(
      `[${args.surface}] dataset-family=promax but ${leaking.length} row(s) still carry ` +
        `GRADER-ONLY gold fields: ${preview(leaking)}. ` +
        "Those bytes would be shipped to the box the agent runs on. REFUSING — ship the " +
        "PUBLIC projection (profiles/promax-projection.ts) and keep gold in the grader-only " +
        "bundle.",
    )
  }
  if (malformed.length > 0) {
    throw new RemoteDatasetPreflightError(
      `[${args.surface}] dataset-family=promax but ${malformed.length} row(s) lack ProMax-required ` +
        `columns (${PROMAX_REQUIRED_COLUMNS.join(" / ")}): ${preview(malformed)}. ` +
        "A Verified/Pro-shaped dataset is NOT a ProMax corpus. Refusing a remote run that " +
        "would grade as all-infra.",
    )
  }
}
