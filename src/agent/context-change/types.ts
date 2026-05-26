/**
 * Context-change typed event surface — local mock for parallel slice W-B.
 *
 * ADR-0319 (collision: requested 0301 already taken — see ADR header).
 * Codex absorption: `codex-rs/core/src/session/turn.rs:161`
 * `record_context_updates_and_set_reference_context_item` mirror.
 *
 * Why a LOCAL mock interface in this slice:
 *   The companion slice W-A (granular history store) defines the production
 *   `TypedHistoryEventStorePort`. We are landing in parallel; importing W-A's
 *   port directly would couple the two worktrees and force a serial merge.
 *   Instead we declare the EXACT contract here as a local mock; main-integration
 *   then either (a) re-exports W-A's port under this name, or (b) swaps the
 *   import — both byte-stable for THIS slice's consumers because the shapes
 *   are designed to match.
 *
 * Default-OFF: NO production path imports from this module. The slice is
 *   purely additive — detector + injector are pure functions, the port is
 *   contractually consumed via dependency-injection by future wire-up.
 *
 * Contracts (5):
 *   1. NO-THROW on every method — bad input is a no-op or empty array; the
 *      detector is observability-grade infra and MUST NOT take down the loop.
 *   2. READ-ONLY arrays / readonly fields everywhere — callers MUST NOT mutate
 *      the returned events. The detector returns a fresh array per call.
 *   3. CLOSED ContextEvent variant union — 5 kinds frozen by ADR. Adding a new
 *      `kind` is a breaking change for downstream switch-exhaustiveness; do it
 *      in a follow-up ADR with explicit consumer migration.
 *   4. exactOptionalPropertyTypes — `turnId` and `tokenCount` are OMITTED, not
 *      `undefined`-set. Matches the project tsconfig strict posture.
 *   5. STABLE FIELD NAMES — `at` (ms epoch), `turnId`, `prev`, `next`, `field`
 *      are load-bearing for the W-A port; renaming is a coordinated change.
 */

/** Discriminated union of context-state typed events.
 *
 *  Variants (5):
 *    - `context_update`     — generic single-field diff (cwd/mode/repo_rules/active_skills/model).
 *                              `prev`/`next` are `unknown` because each field's value-type differs;
 *                              consumers narrow per `field`.
 *    - `skill_activation`   — a skill ENTERED active state this turn. Mirror is one-direction:
 *                              de-activation is intentionally not a variant in this ADR (negative
 *                              invariant — out-of-scope, may extend in a future ADR).
 *    - `repo_rules_change`  — repo-local rules paths added / removed. Path-level diff so the
 *                              consumer can show "+AGENTS.md / -.cursor/rules/foo.mdc" without
 *                              re-rendering the whole rule body.
 *    - `mode_change`        — agent-mode transition with optional `reason` (e.g. "user requested",
 *                              "auto-derived from /plan command"). Distinct from `context_update`
 *                              with `field:"mode"` because the consumer often wants the dedicated
 *                              transition narrative without union-narrowing.
 *    - `reasoning_echo`     — model-emitted reasoning summary echo (Codex `reasoning` event mirror)
 *                              with a content signature for dedup and a `redacted` arm for the
 *                              "thinking encrypted" case. Token count is best-effort.
 */
export type ContextEvent =
  | {
      readonly kind: "context_update"
      readonly field: "cwd" | "mode" | "repo_rules" | "active_skills" | "model"
      readonly prev: unknown
      readonly next: unknown
      readonly at: number
      readonly turnId?: string
    }
  | {
      readonly kind: "skill_activation"
      readonly skillId: string
      readonly trigger: "user" | "auto" | "system"
      readonly at: number
      readonly turnId?: string
    }
  | {
      readonly kind: "repo_rules_change"
      readonly addedPaths: readonly string[]
      readonly removedPaths: readonly string[]
      readonly at: number
      readonly turnId?: string
    }
  | {
      readonly kind: "mode_change"
      readonly prev: string
      readonly next: string
      readonly reason?: string
      readonly at: number
      readonly turnId?: string
    }
  | {
      readonly kind: "reasoning_echo"
      readonly signature: string
      readonly redacted: boolean
      readonly tokenCount?: number
      readonly at: number
      readonly turnId?: string
    }

/**
 * W-A port surface mirror — declared LOCAL to this slice. Signature is the
 * ground truth for the parallel W-A track; if W-A's actual port ships with a
 * different shape, this slice's main-integration step adapts (we do NOT
 * mutate consumers here; the slice does not import this port operationally).
 *
 * 3 methods:
 *   - `append(event)`       — push a single event onto the typed history. NO-THROW.
 *   - `snapshot()`          — full event log. Returns frozen view; consumer
 *                              MUST NOT mutate.
 *   - `since(at)`           — events with `event.at >= at`. Used by replay and
 *                              by inject-this-turn windowing. Frozen view.
 */
export interface TypedHistoryEventStorePort {
  append(event: ContextEvent): void
  snapshot(): readonly ContextEvent[]
  since(at: number): readonly ContextEvent[]
}
