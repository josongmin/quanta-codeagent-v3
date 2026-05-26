/**
 * Context-change detector — pure diff over {@link TurnStateSnapshot}.
 *
 * ADR-0319 — Codex `record_context_updates_and_set_reference_context_item`
 *   (`codex-rs/core/src/session/turn.rs:161`) mirror. The pattern: at turn
 *   boundary, compare previous and current state and emit typed events for
 *   each field that changed; persist those into the typed history stream
 *   (W-A port), not into the cached prompt prefix.
 *
 * Algorithm (5-pass, deterministic, allocation-bounded):
 *   1. Reference identity short-circuit — `Object.is(prev, current)` ⇒ [].
 *      Same-instance snapshot capture is the hot path (caller passed the
 *      cached snapshot two turns in a row); avoid the field-loop entirely.
 *   2. cwd ⇒ context_update{field:"cwd"} when strings differ.
 *   3. mode ⇒ TWO events when strings differ:
 *      - mode_change (rich form with optional reason — primary)
 *      - context_update{field:"mode"} is NOT emitted (mode_change supersedes;
 *        consumer registers ONE handler). Otherwise a single mode change
 *        produces two events and double-injects.
 *      Reason is sourced from optional `reason` arg (caller threads "user
 *      requested" or "/plan slash" etc.). Absent ⇒ omitted, not undefined-set.
 *   4. model ⇒ context_update{field:"model"} when strings differ.
 *   5. repoRulesPaths ⇒ repo_rules_change with added/removed path sets when
 *      either differs. Path-set diff (not body diff) — see snapshot.ts.
 *   6. activeSkills ⇒ skill_activation events, one per NEW (added) skill id.
 *      Removed skills do NOT emit a deactivation event (negative invariant:
 *      out of scope for this ADR — see types.ts).
 *
 * Equality definition:
 *   - Strings: `===`.
 *   - String arrays: same length AND every index `===` (order-sensitive).
 *     This is "deep-ish" — sufficient because the snapshot field shapes are
 *     all-primitives or string arrays; we never compare nested objects.
 *
 * NO-THROW: malformed input (NaN `at`, undefined fields after captureSnapshot
 *   guards) is silently treated as the closest well-typed neighbor; no
 *   `throw` paths exist in this module.
 */

import type { TurnStateSnapshot } from "./snapshot"
import type { ContextEvent } from "./types"

/** Optional metadata bag — `turnId` and a `reason` for mode-change. The
 *  detector THREADS these onto the events it emits; absent ⇒ omitted, not
 *  undefined-set (exactOptionalPropertyTypes friendly). */
export interface DetectorMeta {
  readonly turnId?: string
  /** Free-form reason annotation for mode_change events. The detector never
   *  inspects content; it just threads the string onto the event. Absent ⇒
   *  no reason field on the event. */
  readonly modeChangeReason?: string
}

/** Path-set equality — order-sensitive, length-sensitive, `===` per slot.
 *  Order-sensitive on purpose: a reorder is a deliberate caller signal (e.g.
 *  rule precedence rearrangement) and should be visible to the typed stream
 *  consumer. */
const sameStringArray = (a: readonly string[], b: readonly string[]): boolean => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Compute added paths in `next` not in `prev`. Preserves `next` order so a
 *  consumer that displays "+a.md +b.md" sees the rule author's intent. */
const diffAdded = (prev: readonly string[], next: readonly string[]): readonly string[] => {
  const prevSet = new Set(prev)
  return next.filter((p) => !prevSet.has(p))
}

/** Compute removed paths in `prev` not in `next`. Preserves `prev` order. */
const diffRemoved = (prev: readonly string[], next: readonly string[]): readonly string[] => {
  const nextSet = new Set(next)
  return prev.filter((p) => !nextSet.has(p))
}

/** Detect context-state changes and emit typed events.
 *
 *  Returns a fresh array (never frozen — callers freeze if they need to).
 *  Length contract:
 *    - 0 events when prev === current (reference) OR when no field differs.
 *    - N events when N independent fields differ, where mode is ONE event
 *      (mode_change), repo_rules is at-most ONE (repo_rules_change), each
 *      added skill is ONE (skill_activation).
 *
 *  Same-snapshot case is the steady-state hot path; ensure the early-return
 *  guard is the FIRST check.
 */
export const detectContextChanges = (
  prev: TurnStateSnapshot,
  current: TurnStateSnapshot,
  at: number,
  meta: DetectorMeta = {},
): ContextEvent[] => {
  // Pass 1: reference identity short-circuit.
  if (Object.is(prev, current)) return []

  const events: ContextEvent[] = []
  const turnIdEntry: { readonly turnId?: string } =
    meta.turnId !== undefined ? { turnId: meta.turnId } : {}

  // Pass 2: cwd.
  if (prev.cwd !== current.cwd) {
    events.push({
      kind: "context_update",
      field: "cwd",
      prev: prev.cwd,
      next: current.cwd,
      at,
      ...turnIdEntry,
    })
  }

  // Pass 3: mode — emit ONLY the rich mode_change variant (not a duplicate
  // context_update); see header for rationale.
  if (prev.mode !== current.mode) {
    const reasonEntry: { readonly reason?: string } =
      meta.modeChangeReason !== undefined ? { reason: meta.modeChangeReason } : {}
    events.push({
      kind: "mode_change",
      prev: prev.mode,
      next: current.mode,
      at,
      ...reasonEntry,
      ...turnIdEntry,
    })
  }

  // Pass 4: model.
  if (prev.model !== current.model) {
    events.push({
      kind: "context_update",
      field: "model",
      prev: prev.model,
      next: current.model,
      at,
      ...turnIdEntry,
    })
  }

  // Pass 5: repo rules paths.
  if (!sameStringArray(prev.repoRulesPaths, current.repoRulesPaths)) {
    events.push({
      kind: "repo_rules_change",
      addedPaths: diffAdded(prev.repoRulesPaths, current.repoRulesPaths),
      removedPaths: diffRemoved(prev.repoRulesPaths, current.repoRulesPaths),
      at,
      ...turnIdEntry,
    })
  }

  // Pass 6: active skills — one skill_activation per NEW skill id. Removed
  // skills do NOT emit a deactivation event (out of scope for this ADR).
  if (!sameStringArray(prev.activeSkills, current.activeSkills)) {
    const added = diffAdded(prev.activeSkills, current.activeSkills)
    for (const skillId of added) {
      events.push({
        kind: "skill_activation",
        skillId,
        // The detector cannot infer the trigger source from snapshot diff
        // alone — the caller (auto-classifier vs slash command vs system)
        // knows. We tag "system" as a conservative default; future extension
        // accepts an optional `skillTriggerByName` map in DetectorMeta.
        trigger: "system",
        at,
        ...turnIdEntry,
      })
    }
  }

  return events
}
