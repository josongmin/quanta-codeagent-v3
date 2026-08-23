/**
 * LEAF — the CLOSED classification of every ProMax dataset row field.
 *
 * ## Why a classification rather than a deny-list of two keys
 *
 * `promax-projection.ts` calls itself the fail-safe FLOOR for packet invariant 3
 * ("agent-visible data and grader-only data are different types and storage
 * roots"). It used to name exactly two keys — `patch` and `test_patch` — while
 * PMX-02's {@link PromaxGraderTaskView} carries SIX row-derived fields, and the
 * real 170-row corpus carries a seventh field (`hints_text`) that belongs on
 * NEITHER artifact. So the floor was fail-OPEN: a chunk with the two patch
 * bodies deleted still shipped the image name, the working dir, the environment
 * setup commit and the issue HINTS to the box the agent runs on, and nothing
 * tied any of it to the grader view.
 *
 * This module makes the split a CLOSED, total function over a closed field set:
 * adding a field to {@link PROMAX_ROW_FIELDS} without classifying it is a
 * compile error, and (because the classification is a `Record` over that union)
 * so is classifying a field that is not in it.
 *
 * ## The three destinations
 *
 * The classification answers ONE question — which artifact does this field's
 * value travel to? — and there are exactly three answers, so a binary
 * agent/grader split would have forced a lie about `hints_text`:
 *
 *  - `agent`    → the public artifact / the agent-visible wire row.
 *  - `grader`   → the grader bundle, i.e. a field of `PromaxGraderTaskView`.
 *  - `withheld` → NEITHER. Dropped at preparation. `hints_text` is upstream
 *                 SWE-bench issue-comment text that routinely contains the fix;
 *                 the grader has no use for it and the agent must not see it.
 *
 * The agent-side deny-list is therefore *everything that is not `agent`*, which
 * is what makes "floor" true rather than aspirational.
 *
 * ## What still is NOT closed, stated rather than implied
 *
 * The projection remains a DENY-list over arbitrary row keys, on purpose (see
 * `promax-projection.ts`: ProMax rows are not key-uniform, and an allow-list at
 * this layer would drop legitimate sparse public metadata). So a brand-new
 * upstream key that nobody has classified still passes THROUGH to the wire row.
 * Two things catch that, and both are load-bearing:
 *   1. the real allow-list one layer up — `rowView` in `promax/corpus/public-reader.ts`
 *      builds a CLOSED five-field struct, so a new key can never reach the agent
 *      `Instance` or prompt regardless of this file;
 *   2. {@link PROMAX_V1_FIELD_PRESENCE} — a frozen census of the verified 170-row
 *      corpus that the corpus test recomputes from the real dataset bytes, so an
 *      upstream field addition turns a test RED instead of widening a chunk.
 */
import type { PromaxGraderTaskView } from "@/apps/bench/promax/corpus"

/**
 * EVERY field observed on the verified v1 corpus
 * (`promax-bundle/v1-170/dataset.json`, sha256 f1f08483…). Closed on purpose:
 * this union is what makes the classification below exhaustive.
 */
export const PROMAX_ROW_FIELDS = [
  "base_commit",
  "created_at",
  "environment_setup_commit",
  "hints_text",
  "image_name",
  "instance_id",
  "issue_numbers",
  "language",
  "patch",
  "problem_statement",
  "pull_number",
  "repo",
  "test_patch",
  "working_dir",
] as const

export type ProMaxRowField = (typeof PROMAX_ROW_FIELDS)[number]

/** Which artifact a row field's value travels to. See the header. */
export type ProMaxFieldDestination = "agent" | "grader" | "withheld"

/**
 * THE classification. `satisfies Record<ProMaxRowField, …>` binds it both ways:
 * a field added to {@link PROMAX_ROW_FIELDS} and not classified here fails to
 * compile, and a key here that is not a row field is an excess property.
 */
export const PROMAX_ROW_FIELD_DESTINATION = {
  // identity + checkout coordinates + the problem: the five-field public view.
  instance_id: "agent",
  repo: "agent",
  base_commit: "agent",
  problem_statement: "agent",
  language: "agent",
  // public upstream provenance metadata. SPARSE (`pull_number` 104/170,
  // `issue_numbers` 3/170) — the documented reason this layer is a deny-list.
  created_at: "agent",
  pull_number: "agent",
  issue_numbers: "agent",
  // the grader bundle, field for field (see PROMAX_GRADER_ROW_FIELD_TO_VIEW_KEY).
  patch: "grader",
  test_patch: "grader",
  image_name: "grader",
  working_dir: "grader",
  environment_setup_commit: "grader",
  // NEITHER artifact: issue-comment hints are a known answer-leak vector and
  // nothing grades with them.
  hints_text: "withheld",
} as const satisfies Record<ProMaxRowField, ProMaxFieldDestination>

type FieldsWithDestination<D extends ProMaxFieldDestination> = {
  readonly [K in ProMaxRowField]: (typeof PROMAX_ROW_FIELD_DESTINATION)[K] extends D ? K : never
}[ProMaxRowField]

/** Row fields that MUST end up on the grader view. */
export type ProMaxGraderRowField = FieldsWithDestination<"grader">
/** Row fields the agent-visible wire row may carry. */
export type ProMaxAgentRowField = FieldsWithDestination<"agent">

/**
 * DIRECTION 1 of the two-way bind: every `grader`-classified row field names the
 * `PromaxGraderTaskView` key it becomes. `Record<ProMaxGraderRowField, …>` makes
 * a grader-classified field with no grader-view key a COMPILE error, and
 * `keyof PromaxGraderTaskView` makes a typo'd view key one too.
 */
export const PROMAX_GRADER_ROW_FIELD_TO_VIEW_KEY = {
  patch: "patch",
  test_patch: "testPatch",
  image_name: "imageName",
  working_dir: "workingDir",
  environment_setup_commit: "environmentSetupCommit",
} as const satisfies Record<ProMaxGraderRowField, keyof PromaxGraderTaskView>

/**
 * DIRECTION 2 of the two-way bind: a VALUE-level mirror of the grader view's
 * keys, each stating where its value comes from. Because it is
 * `Record<keyof PromaxGraderTaskView, …>`, adding a field to the view is a
 * compile error here until someone gives it a provenance, and deleting one is an
 * excess-property error. `assertProMaxFieldClassificationInSync` then checks the
 * two tables agree at runtime, so the bind survives a `satisfies` being dropped.
 */
export const PROMAX_GRADER_VIEW_FIELD_SOURCE = {
  /** The join key. Public identity; it is on the agent view too, by design. */
  instanceId: "join-key",
  patch: "row",
  testPatch: "row",
  imageName: "row",
  workingDir: "row",
  environmentSetupCommit: "row",
  /** Not a dataset field at all — the pinned evaluator's `eval.json`. */
  evalScript: "eval-map",
} as const satisfies Record<keyof PromaxGraderTaskView, "row" | "join-key" | "eval-map">

/**
 * Row counts per field on the verified v1 corpus (170 rows). A frozen census, so
 * a corpus test can prove the classification is TOTAL over the bytes that were
 * actually verified — and so an upstream field addition or removal is a red test
 * rather than a silently widened chunk.
 */
export const PROMAX_V1_FIELD_PRESENCE = {
  base_commit: 170,
  created_at: 170,
  environment_setup_commit: 170,
  hints_text: 170,
  image_name: 170,
  instance_id: 170,
  issue_numbers: 3,
  language: 170,
  patch: 170,
  problem_statement: 170,
  pull_number: 104,
  repo: 170,
  test_patch: 170,
  working_dir: 170,
} as const satisfies Record<ProMaxRowField, number>

const fieldsWithDestination = (destination: ProMaxFieldDestination): readonly ProMaxRowField[] =>
  PROMAX_ROW_FIELDS.filter((field) => PROMAX_ROW_FIELD_DESTINATION[field] === destination)

/**
 * The agent-side DENY set: every classified field that is not destined for the
 * agent. Derived — never hand-listed — so widening the classification widens the
 * floor in the same commit.
 */
export const PROMAX_NON_AGENT_ROW_FIELDS: readonly ProMaxRowField[] = PROMAX_ROW_FIELDS.filter(
  (field) => PROMAX_ROW_FIELD_DESTINATION[field] !== "agent",
)

export class ProMaxFieldClassificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProMaxFieldClassificationError"
  }
}

/** The classification is TOTAL over the closed field set, in both directions,
 *  and every declared field has a v1 census entry. */
const totalityProblems = (): readonly string[] => {
  const problems: string[] = []
  const classified = Object.keys(PROMAX_ROW_FIELD_DESTINATION)
  const declared: readonly string[] = PROMAX_ROW_FIELDS
  for (const field of declared) {
    if (!classified.includes(field)) problems.push(`row field \`${field}\` is unclassified`)
    if (!(field in PROMAX_V1_FIELD_PRESENCE)) {
      problems.push(`row field \`${field}\` has no v1 presence census entry`)
    }
  }
  for (const key of classified) {
    if (!declared.includes(key)) {
      problems.push(`classified key \`${key}\` is not a declared ProMax row field`)
    }
  }
  return problems
}

/** The TWO-WAY bind to `PromaxGraderTaskView`: every `grader` field lands on a
 *  row-sourced view key, and every row-sourced view key is produced by one. */
const graderBindProblems = (): readonly string[] => {
  const problems: string[] = []
  const mapped = PROMAX_GRADER_ROW_FIELD_TO_VIEW_KEY as Readonly<Record<string, string>>
  const viewSource = PROMAX_GRADER_VIEW_FIELD_SOURCE as Readonly<Record<string, string>>
  // DIRECTION 1
  for (const field of fieldsWithDestination("grader")) {
    if (mapped[field] === undefined) {
      problems.push(`field \`${field}\` is classified grader but maps to no grader-view key`)
    }
  }
  // DIRECTION 2
  const mappedViewKeys = new Set(Object.values(mapped))
  for (const [viewKey, source] of Object.entries(viewSource)) {
    if (source === "row" && !mappedViewKeys.has(viewKey)) {
      problems.push(
        `grader-view field \`${viewKey}\` comes from a row but no row field is classified into it`,
      )
    }
  }
  for (const [field, viewKey] of Object.entries(mapped)) {
    if (viewSource[viewKey] !== "row") {
      problems.push(
        `row field \`${field}\` maps to grader-view key \`${viewKey}\`, which is not a row-sourced grader-view field`,
      )
    }
  }
  return problems
}

/**
 * RUNTIME drift guard for everything the compiler proves above, so the bind
 * cannot rot into a `satisfies` that someone widened to `Record<string, …>`.
 * Throws naming EVERY disagreement; called by the classification test and cheap
 * enough to call from a preparation tool.
 */
export const assertProMaxFieldClassificationInSync = (): void => {
  const problems = [...totalityProblems(), ...graderBindProblems()]
  if (problems.length > 0) {
    throw new ProMaxFieldClassificationError(
      `promax row-field classification is out of sync with PromaxGraderTaskView: ${problems.join("; ")}`,
    )
  }
}
