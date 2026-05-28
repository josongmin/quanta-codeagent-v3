/**
 * ADR-0325 — Mention-driven explicit context-injection types.
 *
 * Closed-port + closed-enum surface. The 3-kind {@link MentionKind} enum
 * is FROZEN by this ADR; extending the kind set requires a new ADR.
 *
 * Sibling to ADR-0321's snapshot-diff producer:
 *   - ADR-0321 produces typed events from PASSIVE state diffs (cwd /
 *     mode / repo-rules / active-skills / model swap), one per turn.
 *   - ADR-0325 (this slice) produces typed events from EXPLICIT user
 *     mentions in the per-turn input (`@skill`, `plugin://`, `@@app`),
 *     so the model receives a persistent record of the activation that
 *     the user typed verbatim.
 *
 * Codex absorption: `codex-rs/core/src/session/turn.rs:436-575`
 *   (`build_skills_and_plugins`). Codex parses `@skill` and `plugin://`
 *   mentions out of the user message, resolves them via the skill /
 *   plugin registries, and shoves the resolved bodies into the history
 *   stream as `ResponseItem`s. Quanta mirrors the producer shape but
 *   targets two consumers: ADR-0320's `TypedHistoryEventStore` (for the
 *   replayable side-channel) and the ADR-0321 inject-message format
 *   (for the per-turn prompt splice).
 *
 * Default-OFF: this slice ships parser + resolver port + emitter +
 * inject builder. No registry adapter is wired, no production path
 * imports the module — wire-up is a follow-up ADR.
 */

/**
 * Closed set of mention kinds. Mirrors Codex's `build_skills_and_plugins`
 * three-way dispatch (skill / plugin / app), extended by ADR-0414 with a
 * fourth sync `file` kind.
 *
 * - `skill` — user-invocable skill bundle (matches `@kebab-name`).
 * - `plugin` — installable plugin (matches `plugin://kebab-name`).
 * - `app` — third-party / OS app integration (matches `@@kebab-name`,
 *   double-`@` to disambiguate from `skill`).
 * - `file` — workspace file reference (matches `@file:<path>` or a bare
 *   `@<path>` containing `/` or `.`). ADDED by ADR-0414 as a pure-sync,
 *   additive extension: resolution is `fs.readFileSync`, which fits the
 *   existing sync resolver contract with zero signature changes. The
 *   three legacy kinds are byte-identical.
 *
 * **Frozen at 4 kinds.** Extending (e.g. a future async `symbol` kind,
 * which would force the resolver/injector sync→async cascade) requires a
 * new ADR — see ADR-0414 §"deliberate_hold".
 */
export type MentionKind = "skill" | "plugin" | "app" | "file"

/**
 * A single parsed mention. {@link span} carries the half-open
 * `[start, end)` char-offset range into the original user input so a
 * caller can highlight / strip the mention if it later decides to.
 *
 * Invariant (enforced by the parser): `raw.length === span.end - span.start`.
 */
export interface ParsedMention {
  readonly kind: MentionKind
  /** Skill name / plugin URI tail / app name. ASCII-only, kebab-case.
   *  Does NOT include the leading sigil(s) — for `@code-review` this is
   *  `code-review`, for `plugin://github` this is `github`. */
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
