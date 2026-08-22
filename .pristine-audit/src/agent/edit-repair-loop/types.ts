/**
 * Edit-repair-loop slice — shared types (ADR-0472).
 *
 * WHAT: after a model edit (edit/write/apply_patch), compute the diagnostics the
 * edit INTRODUCED (post − pre, not the file's pre-existing lint debt) and, when
 * gated ON, re-drive a fast edit model until the check goes green — bounded by a
 * REQUIRED `maxIters` (no magic number), feeding each failure back with
 * per-loop custom instructions. Mirrors the loops Cursor/Codex run after an edit
 * before handing a still-broken file back to the main turn.
 *
 * SLICES IMPORTED: `@/shared` ONLY (Result/ok/err, errMessage). This slice lives
 * under `@/agent` but does NOT import `@/llm`, `@/tool`, or any sibling slice.
 * The two intelligence collaborators are PORT-INVERTED (mirrors
 * `src/permission/classifier.ts` ClassifierPort):
 *   - `DiagnosticsProvider` — runs the linter/type-checker over a file revision.
 *   - `RepairReactorPort` — the fast edit model: given failures + per-loop custom
 *     instructions, returns ONE repaired edit attempt.
 * The composition root adapts the real LSP/diagnostics source and the fast-apply
 * executor (reusing the `src/agent/fast-apply-fallback` side-conversation +
 * `src/tool/parse-test-failure` signal sources) onto these shapes — this slice
 * never imports them directly (slice fence).
 *
 * NO-THROW: every exported async fn returns a `Result`-shaped value or a plain
 * value; a port that throws collapses to a typed failure outcome — never an
 * exception into the caller's turn.
 *
 * DEFAULT-OFF: `QUANTA_EDIT_REPAIR_LOOP` unset ⇒ `editRepairLoopEnabled` is
 * false ⇒ callers MUST skip the loop entirely (byte-identical to today). The
 * lint-delta computer is a pure fn usable on its own to enrich edit output.
 */

import type { Result } from "@/shared"

/** Env var that opts a deployment into the repair loop. Strict `=== "1"`. */
export const EDIT_REPAIR_LOOP_ENV = "QUANTA_EDIT_REPAIR_LOOP"

/**
 * One diagnostic from a linter / type-checker, projected to the minimal shape
 * the delta needs. The slice never sees the LSP wire format — the composition
 * root maps real diagnostics down to this. Identity for delta purposes is the
 * `(file, line, code, message)` tuple (see {@link diagnosticKey}); `severity`
 * and `column` are carried for rendering but are NOT part of identity so a mere
 * column shift never counts as a "new" lint.
 */
export interface Diagnostic {
  readonly file: string
  readonly line: number
  /** Stable rule/error code (e.g. "TS2322", "no-unused-vars"). Empty allowed. */
  readonly code: string
  readonly message: string
  readonly severity: "error" | "warning" | "info"
  /** 1-based column, optional. Carried for render; NOT part of delta identity. */
  readonly column?: number
}

/**
 * INJECTED diagnostics source (port inversion). Runs the linter/type-checker
 * over a single file revision and returns its diagnostics. NO-THROW: the
 * adapter must collapse failures to `ok:false` (a broken checker must not abort
 * the loop). `revision` is opaque to the slice — the adapter decides whether it
 * means "current on-disk content" or a specific snapshot id.
 */
export type DiagnosticsProvider = (
  input: { file: string; revision?: string },
  signal?: AbortSignal,
) => Promise<Result<readonly Diagnostic[], string>>

/** A single failing check fed back to the repair model. */
export interface RepairFailure {
  /** Which check produced this failure. */
  readonly check: CheckKind
  /** Diagnostics the edit INTRODUCED (lints) — empty for tests/command checks. */
  readonly diagnostics: readonly Diagnostic[]
  /** Raw failing output (test runner / command stderr+stdout) — empty for lints. */
  readonly output: string
  /** Non-zero exit code for command/test checks; undefined for lints. */
  readonly exitCode?: number
}

/** The repair request handed to the fast edit model on each loop iteration. */
export interface RepairRequest {
  /** The file under repair. */
  readonly file: string
  /** What went wrong on the LAST attempt (introduced lints / test / command). */
  readonly failure: RepairFailure
  /** Per-loop custom instructions appended to the repair prompt (caller-chosen;
   *  e.g. "do not change the public signature"). Empty allowed. */
  readonly customInstructions: string
  /** 0-based iteration index (0 = first repair attempt). */
  readonly iteration: number
}

/** Outcome of ONE repair attempt from the fast model. */
export interface RepairAttempt {
  /** true ⇒ an edit was produced and (per the adapter) applied; the runner will
   *  re-run the check. false ⇒ the model declined / errored; runner gives up. */
  readonly applied: boolean
  /** Human-readable note on what the model did (always nonempty). */
  readonly rationale: string
}

/**
 * INJECTED fast edit model (port inversion). Given the failure + custom
 * instructions, produces ONE repaired edit attempt. NO-THROW: a throw inside
 * is caught by the runner and treated as `applied:false`. The adapter at the
 * composition root wires the fast-apply side-conversation + applies the patch.
 */
export type RepairReactorPort = (req: RepairRequest, signal?: AbortSignal) => Promise<RepairAttempt>

/** Which kind of check decides "green". Closed union (no arbitrary extension). */
export type CheckKind = "lints" | "tests" | "command"

/**
 * INJECTED check (port inversion). Returns the CURRENT failure for the file,
 * or null when the check is green. For `lints` the adapter computes the
 * lint-delta (introduced diagnostics) via {@link computeLintDelta}; for
 * `tests`/`command` it runs the named test / command and reports exit code +
 * output. NO-THROW: a throw is caught by the runner and ends the loop with a
 * `check-error` give-up.
 */
export type RepairCheck = (signal?: AbortSignal) => Promise<Result<RepairFailure | null, string>>

/** Config for {@link runRepairLoop}. `maxIters` is REQUIRED — no magic. */
export interface RepairLoopConfig {
  /** Which file is under repair (for the request + report). */
  readonly file: string
  /** Which check decides green. */
  readonly checkKind: CheckKind
  /** Maximum repair iterations. REQUIRED, must be ≥ 1. The loop runs at most
   *  this many model attempts; exhaustion ⇒ structured give-up report. */
  readonly maxIters: number
  /** Per-loop custom instructions appended to every repair request. Empty ok. */
  readonly customInstructions?: string
}

/** Closed reason union for why the loop stopped. */
export type RepairStopReason =
  /** The check went green (possibly after 0 attempts — was already green). */
  | { readonly kind: "green" }
  /** `maxIters` repair attempts ran and the check is still failing. */
  | { readonly kind: "exhausted" }
  /** The repair model declined / failed to produce an applied edit. */
  | { readonly kind: "model-declined" }
  /** The check port returned an error (broken checker). */
  | { readonly kind: "check-error"; readonly error: string }
  /** The signal aborted mid-loop. */
  | { readonly kind: "aborted" }
  /** Invalid config (e.g. `maxIters` < 1). */
  | { readonly kind: "invalid-config"; readonly error: string }

/** One entry in the loop's audit trail (one per iteration attempted). */
export interface RepairIterationLog {
  readonly iteration: number
  /** The failure that triggered this iteration. */
  readonly failure: RepairFailure
  /** What the repair model did. */
  readonly attempt: RepairAttempt
}

/** Structured loop report. Always returned (NO-THROW); the caller renders it. */
export interface RepairLoopReport {
  readonly file: string
  readonly checkKind: CheckKind
  /** Did the file end green? */
  readonly green: boolean
  /** Why the loop stopped. */
  readonly stop: RepairStopReason
  /** How many repair attempts were actually run (0 ⇒ already green). */
  readonly attempts: number
  /** Per-iteration audit trail. */
  readonly iterations: readonly RepairIterationLog[]
}

/** Deps for {@link runRepairLoop}. */
export interface RepairLoopDeps {
  readonly check: RepairCheck
  readonly reactor: RepairReactorPort
}
