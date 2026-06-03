// Structured per-file apply result — type definitions (ADR-0464).
//
// What this does: declares the ADDITIVE, default-OFF result shape returned by
// `applyPatchStructured` (`./structured`). Faithful to Cursor's
// `ApplyAgentDiff` proto: a per-file outcome carrying change_type, optional
// before/after content, and a model-facing `messageForModel` hint so the LLM
// can self-correct ONE failed file without re-emitting the whole patch.
//
// Slices imported: NONE beyond `@/shared` types are needed here — this is a
// pure type module (no value imports). It lives in `@/patch`, which may import
// only `@/shared`.
//
// NO-THROW contract: types only; no executable surface. The function that
// produces these (`./structured`) is no-throw and returns `Result<…>`.
//
// Relationship to the existing throwing path: this is purely additive. The
// canonical `applyPatch` (`./applier`) STILL throws its typed errors and is
// unchanged. Callers opt into the structured per-file behaviour by calling
// `applyPatchStructured` instead — current dispatch is byte-identical.

/** Cursor-faithful per-file change category. Mirrors
 *  `ApplyAgentDiffSuccess.applied_changes[].change_type`
 *  (`CREATED | MODIFIED | DELETED`), lower-cased to match this codebase's
 *  union-literal convention (cf. `RecorderFormat`, `AgentMode`). A V4A
 *  `*** Move to:` op is reported as `"modified"` on its NEW path — the rename
 *  is an edit-in-place + relocation, and the model only needs to know the
 *  resulting file exists with new content. */
export type ApplyChangeType = "created" | "modified" | "deleted"

/**
 * One file's outcome inside {@link StructuredApplyOutcome}. Mirrors Cursor's
 * `ApplyAgentDiffSuccess.applied_changes[]` entry verbatim:
 * `{ path, change_type, before_content?, after_content?, error?,
 *    message_for_model? }`.
 *
 * On SUCCESS: `error`/`messageForModel` are undefined; `beforeContent`/
 * `afterContent` are populated per change-type (a created file has no before;
 * a deleted file has no after).
 *
 * On FAILURE: `error` carries the typed error's `.message`; `messageForModel`
 * carries a compact model-facing hint built from the typed error so the model
 * can retry JUST this file. The file's prior on-disk content is left intact —
 * `beforeContent` reflects what is still on disk; `afterContent` is undefined
 * (no write happened).
 */
export interface AppliedChange {
  /** The op's target path (for a move, the SOURCE path the op named). */
  readonly path: string
  /** Cursor `change_type` — the op category. */
  readonly changeType: ApplyChangeType
  /** For a move op, the rename DESTINATION. Present ONLY when the op was a
   *  `*** Move to:` update; the model sees the final file location. */
  readonly movedTo?: string
  /** File content BEFORE this op. Undefined for a `created` file (no prior
   *  content). On failure, this is the still-intact on-disk content (or
   *  undefined when the target could not be read). */
  readonly beforeContent?: string
  /** File content AFTER this op. Undefined for a `deleted` file and for any
   *  FAILED op (no write happened). */
  readonly afterContent?: string
  /** The typed error's `.message` when this file's op failed; undefined on
   *  success. Verbatim from the thrown error so callers keep full fidelity. */
  readonly error?: string
  /** Compact, model-facing retry hint synthesised from the typed error
   *  (`./message-for-model`). Undefined on success. Designed to be dropped
   *  straight into the next turn so the model re-emits JUST this file. */
  readonly messageForModel?: string
}

/**
 * Structured outcome of `applyPatchStructured`. `appliedChanges` is in PATCH
 * ORDER (one entry per op, success or failure — never collapsed). `allOk` is
 * `true` iff EVERY op succeeded. Mirrors the Cursor split where
 * `ApplyAgentDiffSuccess` (all ok) vs `ApplyAgentDiffError` (partial) are two
 * proto messages — here unified into one struct with `allOk` as the
 * discriminator so the caller branches on a single boolean.
 */
export interface StructuredApplyOutcome {
  readonly appliedChanges: readonly AppliedChange[]
  readonly allOk: boolean
}
