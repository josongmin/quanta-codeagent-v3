/**
 * Multi-source rules vendor-detector — port + value types.
 *
 * Five competing coding-agent vendors plus our native `.quanta/rules/*` all
 * ship their own on-disk rule format. When a user migrates from one of those
 * to quanta — or runs quanta inside a repo that was set up for one of them —
 * we want the model to see those rules as authority WITHOUT the user moving
 * them. That is what this slice owns: detection + parsing + normalization to
 * a single {@link DetectedRule} shape.
 *
 * Scope (deliberate, narrow):
 *
 *   - Detection only — we DO NOT decide whether a rule applies on a given
 *     turn (that is `selectGlobRules`'s job; we just emit the globs/always
 *     flag). We DO NOT render the prompt block (`glob-rules.ts` does that).
 *   - Pure data — every parse error is reported as a typed value in the
 *     return; we never throw across the port surface (RFC §"no fallback").
 *   - No-op when no vendor file is found (byte-identical to today's behaviour).
 *
 * Slice fence (S4): `@/rules` may import `@/shared` only. The detector reads
 * the filesystem via `node:fs/promises` (node-builtin, slice-fence-allowed)
 * but does NOT import `@/skill` / `@/agent` — frontmatter parsing is
 * re-implemented inline (the YAML subset we accept is tiny) so the slice has
 * zero peer-slice dependencies. The consumer in `@/agent` is responsible for
 * glob-matching the emitted rules against changed paths.
 *
 * Determinism: detection results are sorted by (vendor priority, source path).
 * Two callers with the same on-disk state get byte-identical output.
 */

/** Closed enum of the vendor sources this slice knows about. Anchored so that
 *  consumers can switch-exhaustive on it and so `vendor-table.ts` cannot drift
 *  out from under us without the type checker noticing. */
export type VendorId = "cursor" | "cline" | "roo" | "aider" | "windsurf" | "quanta"

/** How a discovered rule scopes itself. Some vendors carry per-file globs
 *  (Cursor `.mdc`), some are always-applied (Cline), some have a mode axis
 *  (Roo's `rules-{mode}/`). The detector emits whatever the vendor source
 *  declared; the caller decides how to interpret. */
export type RuleScope = "repo" | "repo+mode"

/** How a discovered rule wants to trigger on a turn. `alwaysApply` rides every
 *  turn; `globs` rides only when a changed path matches one of the globs;
 *  `agent` is a manual/agent-requestable hint (no auto-injection). */
export interface RuleTrigger {
  /** True ⇒ inject every turn regardless of changed paths. */
  readonly alwaysApply: boolean
  /** Glob patterns to match against changed paths. Empty when `alwaysApply`
   *  is true OR when the vendor source declared neither (the rule is then
   *  agent-requestable — emitted but not auto-injected). */
  readonly globs: readonly string[]
  /** Optional mode tag (Roo `rules-{mode}/`). Present iff
   *  `scope === "repo+mode"`. */
  readonly mode?: string
}

/** One discovered rule after normalization. Self-contained: the consumer
 *  needs nothing else to render or select. */
export interface DetectedRule {
  /** Which vendor source the rule came from. Used for citation in the
   *  rendered prompt block + collision-resolution priority. */
  readonly vendor: VendorId
  /** Absolute path to the source file on disk. */
  readonly sourcePath: string
  /** Free-form short description (vendor frontmatter `description`, or empty
   *  when none was declared). */
  readonly description: string
  /** Markdown / plain body. Empty bodies are filtered by the detector and
   *  never reach the consumer. */
  readonly body: string
  /** When and how this rule wants to fire. */
  readonly trigger: RuleTrigger
  /** Coarse scope class. Carried for diagnostics; the detector also encodes
   *  it in `trigger.mode`. */
  readonly scope: RuleScope
  /** Vendor-specific metadata that did not fit into the normalized fields.
   *  Aider's `read:`, `model:`, etc. land here so they are not silently
   *  dropped (the consumer can surface them in diagnostics). String values
   *  only — we deliberately do not preserve nested structure. */
  readonly metadata: Readonly<Record<string, string>>
}

/** A non-fatal parsing problem for one file. The detector ALWAYS returns
 *  successfully (no throw across the port boundary); errors accumulate here
 *  so the consumer can surface them in diagnostics. */
export interface DetectorError {
  readonly vendor: VendorId
  readonly sourcePath: string
  /** Free-form, human-readable. Never includes secrets — only the file path
   *  + the structural problem (e.g. "unterminated frontmatter", "yaml folded
   *  scalar not supported"). */
  readonly message: string
}

/** The detector's return shape. `rules` is the successfully-parsed,
 *  collision-resolved, deterministically-ordered set; `errors` is the parallel
 *  list of files that were considered but could not be ingested. Either may be
 *  empty. */
export interface DetectionResult {
  readonly rules: readonly DetectedRule[]
  readonly errors: readonly DetectorError[]
}

/** Options for one detection pass. `cwd` is the only required field; everything
 *  else has a documented default in `default-detector.ts`. */
export interface DetectOptions {
  /** Repo root to scan. Vendor paths are resolved relative to this. */
  readonly cwd: string
  /** Cap on the TOTAL number of files the detector will open. Protects against
   *  a hostile / misconfigured repo with thousands of rule files (the per-
   *  turn cost downstream is O(N rules × K paths); we mirror `MAX_RULE_FILES =
   *  256` from glob-rules.ts as the default). */
  readonly maxFiles?: number
  /** Cap on per-file BODY bytes. Files larger than this are truncated with an
   *  explicit marker — matching the existing glob-rules.ts behaviour
   *  (16 KiB). Whole-file size cap is separately enforced before read. */
  readonly maxBodyBytes?: number
}

/**
 * The port: detect every vendor's rule files under `cwd` and emit normalized
 * `DetectedRule`s. Implementations MUST NOT throw across this boundary —
 * every error becomes a `DetectorError` in the result. The consumer
 * (`@/agent/glob-rules.ts`) calls `detectAll` once per session.
 */
export interface VendorDetectorPort {
  detectAll(opts: DetectOptions): Promise<DetectionResult>
}
