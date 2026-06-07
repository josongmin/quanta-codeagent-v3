/**
 * Tool idempotency classifier (ADR-0174 Phase 3).
 *
 * Subagent tool-history replay needs to know, for each persisted tool call,
 * how SAFE it is to either (a) re-run on a fresh fork OR (b) reuse the cached
 * output without re-executing the side effect. We solve this with an EXPLICIT
 * 3-tier table — auditable, testable, no heuristic — rather than introspecting
 * each Tool's `isReadOnly()` flag (which would be a heuristic and could drift
 * silently when a tool grows a new code path).
 *
 *   - `"pure"`                 — read-only / introspective. Safe to re-run on
 *                                cache miss (the second call returns the same
 *                                output for the same args, modulo time drift).
 *                                Cache hit → replay-from-cache (preferred).
 *   - `"mutating-recoverable"` — modifies the working tree but the shadow ODB
 *                                (ADR-0108) captured a SHA right after the
 *                                call. Cache hit → replay-from-cache PLUS
 *                                restore the shadow commit. Cache miss → halt
 *                                (re-running would mutate again; restoring
 *                                a non-existent shadow commit is impossible).
 *   - `"mutating-external"`    — produces side effects OUTSIDE the workspace
 *                                (network, daemons, pushed branches). Cache
 *                                hit → replay-from-cache (output already
 *                                captured; do NOT re-run the side effect).
 *                                Cache miss → ask-user-confirm (caller must
 *                                decide whether re-running the side effect
 *                                is acceptable).
 *
 * Plane-clean: this slice imports NOTHING — pure data. No `@/agent/loop`,
 * `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool` (we do NOT introspect
 * tool instances; the table is the source of truth).
 *
 * exactOptional strict: `classify` returns `IdempotencyTier | null` — `null`
 * means "unknown tool name", NOT "absent property". Callers branch on the
 * arm explicitly.
 */

/** 3-tier idempotency classification. See module-doc for semantics. */
export type IdempotencyTier = "pure" | "mutating-recoverable" | "mutating-external"

/** Closed port — implementations need only `classify`. Default factory is
 *  pure data; callers may inject custom tables to extend coverage. */
export interface IdempotencyClassifier {
  /** Return the tier for `toolName`, or `null` when the name is not in the
   *  table. Callers MUST treat `null` defensively (halt or ask-user) — silent
   *  "default to pure" would be a security hazard. */
  classify(toolName: string): IdempotencyTier | null
}

/** Default classification table. EVERY known tool name is mapped explicitly.
 *  Frozen at module load — callers cannot mutate the canonical table.
 *
 *  Categorization rules of thumb:
 *    - Returns data WITHOUT touching FS / network / git ref → "pure".
 *    - Modifies workspace FS or workspace git refs only       → "mutating-recoverable".
 *    - Touches network, OS daemons, pushed branches, or shell → "mutating-external".
 *
 *  Drift watch: when a new tool is added, this table MUST be updated in the
 *  same PR. The hellgate `DEFAULT_IDEMPOTENCY_TABLE coverage` case lists the
 *  current known set so a missing entry surfaces as a test failure. */
export const DEFAULT_IDEMPOTENCY_TABLE: Readonly<Record<string, IdempotencyTier>> = Object.freeze({
  // --- Read-only / introspective (pure) ---
  read: "pure",
  grep: "pure",
  glob: "pure",
  git_status: "pure",
  git_diff: "pure",
  git_log: "pure",
  git_blame: "pure",
  git_churn: "pure",
  git_blame_heatmap: "pure",
  git_upstream_check: "pure",
  git_review_diff: "pure",
  git_moved_code: "pure",
  git_conflict_inspect: "pure",
  file_tree_summary: "pure",
  parse_test_failure: "pure",
  test_runner: "pure",
  diagnostics: "pure",
  localize: "pure",
  read_image: "pure",
  read_image_url: "pure",
  web_fetch: "pure",
  csv_read: "pure",
  ndjson_read: "pure",
  yaml_read: "pure",
  pdf_read: "pure",
  xlsx_read: "pure",
  lsp_definition: "pure",
  lsp_references: "pure",
  lsp_hover: "pure",
  lsp_type_definition: "pure",
  lsp_implementation: "pure",
  lsp_document_symbol: "pure",
  lsp_workspace_symbol: "pure",
  lsp_rename_preview: "pure",
  lsp_code_action: "pure",
  lsp_signature_help: "pure",
  shadow_snapshots: "pure",
  subagent_poll: "pure",
  subagent_await: "pure",
  budget_status: "pure",
  coverage_check: "pure",

  // --- Mutates workspace; recoverable via shadow ODB ---
  edit: "mutating-recoverable",
  write: "mutating-recoverable",
  scripted_replace: "mutating-recoverable",
  apply_patch: "mutating-recoverable",
  git_commit: "mutating-recoverable",
  git_branch_switch: "mutating-recoverable",
  update_working_state: "mutating-recoverable",
  request_user_input: "mutating-recoverable",
  shadow_rewind: "mutating-recoverable",
  shadow_restore_partial: "mutating-recoverable",

  // --- External side effects (shell, network, daemons, fork) ---
  bash: "mutating-external",
  subagent_fork: "mutating-external",
  lsp_format: "mutating-external",
  lsp_rename_apply: "mutating-external",
  web_search: "mutating-external",
})

/** Default classifier — wraps {@link DEFAULT_IDEMPOTENCY_TABLE} with a lookup
 *  that returns `null` (not `undefined`) for unknown names so the public type
 *  matches `IdempotencyTier | null` strictly. Uses `Object.hasOwn` so prototype
 *  pollution attempts (`__proto__`, `constructor`, etc.) cannot smuggle in a
 *  classification — only own keys count. */
export const defaultIdempotencyClassifier = (): IdempotencyClassifier => ({
  classify(toolName: string): IdempotencyTier | null {
    if (!Object.hasOwn(DEFAULT_IDEMPOTENCY_TABLE, toolName)) return null
    const tier = DEFAULT_IDEMPOTENCY_TABLE[toolName]
    return tier ?? null
  },
})
