/**
 * Observation metrics — the minimal, LOCAL trajectory-event shape these pure
 * metric functions consume (jul-6, Stream S4). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§실험 설계).
 *
 * WHY a local mirror (additive — the producer is NOT edited): the real event is
 * `TrajectoryEvent` in `src/shared/trajectory.ts:83` (schema `quanta.trajectory.v1`,
 * `TrajectoryKind` at :26). It carries recorder/redaction/pricing/ctx machinery
 * these metrics never read. Mirroring only the load-bearing fields (`kind`, `seq`,
 * `data`) keeps this a pure leaf with no `@/shared` / `@/stream` import — a real
 * `TrajectoryEvent` is assignable to {@link MetricEvent} structurally, so a caller
 * feeds the live array unchanged.
 *
 * HARD: no IO, no env, no `@/llm`. Pure functions over event arrays + bundle.
 */

/**
 * Kinds THIS rail branches on. A strict subset of the real `TrajectoryKind`
 * (`src/shared/trajectory.ts:26`) — kept as a widened `string` union so an event
 * of any other real kind still type-checks (it is simply ignored by the reducers).
 */
export type MetricEventKind =
  | "tool_call"
  | "tool_result"
  | "assistant_text"
  | "patch_generated"
  | (string & {})

/**
 * The minimal trajectory line these metrics read. Mirrors the load-bearing
 * fields of `TrajectoryEvent` (`src/shared/trajectory.ts:83`):
 *   - `kind`   — the event taxonomy discriminant.
 *   - `seq`    — process-monotonic order (we consume the array order, but keep
 *                `seq` so a caller can sort a merged/interleaved stream first).
 *   - `data`   — the kind-specific payload. For `tool_call` it is
 *                `{ id, name, input }` (see `jsonl-recorder.ts:412`); the file a
 *                tool targets lives at `input.path` (read/edit/write/lsp_*) or
 *                `input.file` (scripted_replace).
 */
export interface MetricEvent {
  readonly kind: MetricEventKind
  readonly seq?: number
  readonly data?: Record<string, unknown> | undefined
}

/** Tool names that MUTATE a file — an "edit" for follow/overtrust purposes. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "scripted_replace",
  "apply_patch",
  "notebook_edit",
])

/** Tool names that count as reading a file's content. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["read"])

/**
 * Tool names that count as VERIFYING a file/symbol before editing it, per
 * design §실험 설계 ("edit 전에 LSP/read/test 중 하나로 검증했나" = LSP / read / test).
 *
 * SELF-AUDIT (overtrust axis): this set is deliberately STRICT. A raw `bash`
 * or a broad `search_codebase` is NOT counted as verification — it does not
 * check that the specific edit target is correct, and counting it would LAUNDER
 * overtrust (inflate hint_verify_rate / deflate follow_without_verify — the very
 * danger signal). Only file-targeted inspection (read / LSP nav on the owner)
 * and genuine behavioural exercise (the test runner) count. Erring toward NOT
 * counting is the safe bias for an early-warning metric.
 */
export const VERIFY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "lsp_definition",
  "lsp_references",
  "lsp_document_symbol",
  "lsp_hover",
  "lsp_nav",
  "find_refs",
  "test_runner",
  "testrun",
  "diagnostics",
  "parse_test_failure",
])

/** Verify tools that are NOT file-targeted (a genuine behavioural exercise, not a
 *  per-owner check). ONLY the test runner qualifies — running the tests exercises
 *  the behaviour the edit must satisfy. `bash`/`search_codebase` are intentionally
 *  EXCLUDED (see {@link VERIFY_TOOLS} self-audit note). */
export const NON_FILE_VERIFY_TOOLS: ReadonlySet<string> = new Set([
  "test_runner",
  "testrun",
  "parse_test_failure",
])

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/** The tool name of a `tool_call` event, or `undefined` for other kinds. */
export const toolName = (e: MetricEvent): string | undefined =>
  e.kind === "tool_call" ? asString(e.data?.name) : undefined

/**
 * The file path a tool call targets, normalized to POSIX separators. Reads
 * `input.path` (read/edit/write/lsp_*) then `input.file` (scripted_replace).
 * `undefined` when the call targets no file (e.g. bash/test_runner). NOT
 * suffix-trimmed here — matching is the caller's job ({@link pathMatchesOwner}).
 */
export const toolFilePath = (e: MetricEvent): string | undefined => {
  if (e.kind !== "tool_call") return undefined
  const input = e.data?.input
  if (input === null || typeof input !== "object") return undefined
  const rec = input as Record<string, unknown>
  const raw = asString(rec.path) ?? asString(rec.file)
  return raw === undefined ? undefined : raw.replaceAll("\\", "/")
}

/**
 * Path-suffix match: does a tool's (possibly sandbox-absolute) `candidate` path
 * refer to the same file as an owner-hint `owner` path (repo-relative)?
 *
 * Trajectory paths are sometimes absolute (`/home/.../repo-XXX/django/db/...`)
 * and sometimes repo-relative (`django/db/...`) for the SAME edit — see the live
 * `django-14315` trajectory. Owner hints are always repo-relative. So we match
 * when one normalized path is a trailing path-segment suffix of the other.
 * Anchored on a `/` boundary so `client.py` does NOT match `base/client.py`
 * spuriously, but the full relative owner path DOES.
 */
export const pathMatchesOwner = (candidate: string, owner: string): boolean => {
  const c = candidate.replaceAll("\\", "/")
  const o = owner.replaceAll("\\", "/")
  if (c === o) return true
  const longer = c.length >= o.length ? c : o
  const shorter = c.length >= o.length ? o : c
  if (shorter.length === 0) return false
  if (!longer.endsWith(shorter)) return false
  // The char just before the suffix must be a path separator, so the suffix is
  // a whole trailing path component (not a mid-filename coincidence).
  const boundaryIdx = longer.length - shorter.length - 1
  return boundaryIdx < 0 || longer[boundaryIdx] === "/"
}

/** Does `path` match ANY of the given owner paths (suffix-aware)? */
export const pathMatchesAnyOwner = (path: string, owners: readonly string[]): boolean =>
  owners.some((o) => pathMatchesOwner(path, o))
