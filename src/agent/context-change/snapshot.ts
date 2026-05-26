/**
 * Ephemeral turn-state snapshot — input to {@link detectContextChanges}.
 *
 * ADR-0319 (collision: requested 0301; user 0301 holds `playbook-trigger-flag-echo`).
 * Codex absorption: `codex-rs/core/src/session/turn.rs:161`
 *   `record_context_updates_and_set_reference_context_item` — the host
 *   captures pre/post turn-state and emits the diff as typed events.
 *
 * The snapshot is INTENTIONALLY ephemeral: it is NOT persisted to working-
 * memory (wm), NOT folded into the cached system prompt, and NOT echoed in
 * the ephemeral `<system-reminder>` tail. It exists only to feed the
 * `detect → event → inject` pipeline. The detector is pure: snapshot in,
 * events out, no I/O.
 *
 * Field shapes match {@link TurnContextInput} (src/agent/prompt.ts) where
 * the prompt seam already has the values; the snapshot is a strict subset
 * so capture is cheap.
 */

/** Per-turn capture surface — frozen-ish ephemeral input to detect.
 *
 *  All fields readonly; arrays readonly so the detector's reference-equality
 *  short-circuit holds when the caller passes the SAME array instance two
 *  turns in a row (a common pattern when nothing changed).
 */
export interface TurnStateSnapshot {
  readonly cwd: string
  readonly mode: string
  readonly model: string
  /** Repo-rule SOURCE PATHS (e.g. `AGENTS.md`, `.cursor/rules/edit.mdc`).
   *  NOT the rule body — keep the snapshot cheap, path-set is the diff
   *  surface. Empty array ⇒ no rules loaded. */
  readonly repoRulesPaths: readonly string[]
  /** Active skill ids (e.g. `progress-audit`). Empty array ⇒ no skills. */
  readonly activeSkills: readonly string[]
}

/** Construct a snapshot. Caller may pass partials; missing fields default to
 *  empty / zero so a fresh-session capture is well-defined.
 *
 *  No I/O; no clock read; no `now()` — the snapshot is value-only. The
 *  timestamp lives on the EVENT (set by the detector caller), not on the
 *  snapshot, so two snapshots compared with the same content yield zero
 *  events regardless of wall-clock skew.
 */
export const captureSnapshot = (input: Partial<TurnStateSnapshot> = {}): TurnStateSnapshot => ({
  cwd: input.cwd ?? "",
  mode: input.mode ?? "default",
  model: input.model ?? "",
  repoRulesPaths: input.repoRulesPaths ?? [],
  activeSkills: input.activeSkills ?? [],
})
