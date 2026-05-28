/**
 * ADR-0325 / ADR-0418 — Mention-driven explicit context-injection types.
 *
 * Status: the 3-kind enum (`skill | plugin | app`) frozen by ADR-0325 and the
 * 4-kind sync extension (`+ file`) of ADR-0413 are both **SUPERSEDED by
 * ADR-0418**. The kind enum is now 5-way (`skill | plugin | app | file |
 * symbol`) and the resolver port is **async** (see `./resolver`) so file
 * reads and symbol (LSP / semantic) lookups can perform I/O without blocking.
 *
 * The original ADR-0325 contract is preserved as a structural subset: a
 * conformant 5-kind resolver still answers `skill | plugin | app` the same
 * way it always did, and a parser caller that emits NO file/symbol mention
 * sees byte-identical mention lists for the legacy subset.
 *
 * Sibling to ADR-0321's snapshot-diff producer:
 *   - ADR-0321 produces typed events from PASSIVE state diffs (cwd /
 *     mode / repo-rules / active-skills / model swap), one per turn.
 *   - ADR-0325 (this slice, post-ADR-0418) produces typed events from
 *     EXPLICIT user mentions in the per-turn input (`@skill`,
 *     `plugin://`, `@@app`, `@path/to/file`, `@SymbolName`), so the
 *     model receives a persistent record of the activation that the
 *     user typed verbatim.
 *
 * Codex absorption: `codex-rs/core/src/session/turn.rs:436-575`
 *   (`build_skills_and_plugins`). Quanta extends with file + symbol
 *   kinds (ADR-0418) to reach Cursor / IDE-mention parity.
 *
 * Default-OFF: this slice ships parser + resolver port + emitter +
 * inject builder + file/symbol resolver factories. No production path
 * imports the module until a wire-up ADR lands; the legacy 3-kind
 * behaviour is byte-identical for zero-file/zero-symbol inputs.
 */

/**
 * Closed set of mention kinds. Mirrors Codex's `build_skills_and_plugins`
 * three-way dispatch, extended by ADR-0418 with `file` and `symbol`:
 *
 * - `skill` — user-invocable skill bundle (matches `@kebab-name`).
 * - `plugin` — installable plugin (matches `plugin://kebab-name`).
 * - `app` — third-party / OS app integration (matches `@@kebab-name`,
 *   double-`@` to disambiguate from `skill`).
 * - `file` — workspace path (ADR-0418, matches `@path/to/file` — contains
 *   `/` — or a lowercase-leading dotted token `@foo.ts`).
 * - `symbol` — code symbol (ADR-0418, matches `@FooBar` or
 *   `@MyClass.method` — must start uppercase ASCII).
 *
 * **Extending requires a new ADR.** The current 5-kind enum is fixed by
 * ADR-0418; further kinds must explicitly supersede 0418.
 */
export type MentionKind = "skill" | "plugin" | "app" | "file" | "symbol"

/**
 * A single parsed mention. {@link span} carries the half-open
 * `[start, end)` char-offset range into the original user input so a
 * caller can highlight / strip the mention if it later decides to.
 *
 * Invariant (enforced by the parser): `raw.length === span.end - span.start`.
 */
export interface ParsedMention {
  readonly kind: MentionKind
  /** Skill name / plugin URI tail / app name / file path / symbol name.
   *  For `skill | plugin | app`: ASCII kebab-case. For `file`: arbitrary
   *  workspace-relative or `./`-prefixed path (post-sigil). For `symbol`:
   *  ASCII alphanumeric starting uppercase, optional `.member` suffix.
   *  Does NOT include the leading sigil(s) — for `@code-review` this is
   *  `code-review`, for `plugin://github` this is `github`, for
   *  `@src/foo.ts` this is `src/foo.ts`, for `@FooBar.method` this is
   *  `FooBar.method`. */
  readonly target: string
  /** Half-open char-offset range `[start, end)` in the original input. */
  readonly span: { readonly start: number; readonly end: number }
  /** The exact substring of the input that matched (sigil included). */
  readonly raw: string
}

/**
 * A resolved mention ready for emission. The resolver port renders each
 * parsed mention into a {@link bodyText} string (the body the model
 * eventually sees, post-defang).
 *
 * Invariant (enforced by the resolver layer): `originSpan` is a copy of
 * the producing {@link ParsedMention.span}, so consumers can correlate
 * fragments back to input offsets without holding a parser reference.
 */
export interface InjectionFragment {
  readonly kind: MentionKind
  readonly target: string
  /** Text body to embed into the prompt envelope. Pre-defang (the
   *  embedder defangs at envelope time). Empty string is permitted —
   *  it produces a present-but-empty envelope, NOT a skipped fragment. */
  readonly bodyText: string
  readonly originSpan: { readonly start: number; readonly end: number }
}
