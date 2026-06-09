/**
 * Compile-time mirror assertions — `AgentStateObservation` (@/protocol/agent-state)
 * structurally === the 9 source `AgentEvent` variants (@/stream).
 *
 * The agent-state protocol slice is SLICE-FENCED: `messages.ts` may NOT import
 * `@/stream`, so it RE-MIRRORS the 9 tapped `AgentEvent` variants
 * (`plan_created` / `plan_updated` / `plan_snapshot` / `plan_user_input_requested`
 * / `plan_user_input_resolved` / `mode_changed` / `tool_progress` /
 * `context_compacted` / `ratelimit_snapshot`) as a hand-maintained structural
 * copy (`AgentStateObservation`). The `wireAgentStateTap` casts the live
 * `AgentEvent` to `AgentStateObservation` (the SSOT `AGENT_STATE_TYPES` gates the
 * narrowing), so a field added to ONE `AgentEvent` variant but not the matching
 * mirror would be SILENTLY LOST at the tap with NO compiler complaint — exactly
 * the drift this guard closes.
 *
 * This file is exempt from the slice-isolation lint (tests are the integration
 * layer), so we ARM the type checker: import BOTH the protocol mirror union AND
 * the canonical `AgentEvent`, then declare a per-variant type-level identity
 * (`AssertEqual<Extract<AgentEvent, {type}>, Extract<AgentStateObservation,
 * {type}>>`). If either side drifts (a renamed/added/removed field), the
 * `_assert*` constant fails to type-check and `tsc --noEmit` fails BEFORE review.
 *
 * The runtime `expect` below is a proof-of-life sentinel; the real contract is
 * the `extends` chains — the file's value is its TYPE failure mode.
 */

import { describe, expect, test } from "bun:test"
import type { AgentStateObservation } from "@/protocol/agent-state"
import type { AgentEvent } from "@/stream"

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never

/**
 * Bidirectional ASSIGNABILITY pin (ignores `readonly`-modifier variance on
 * purpose). The source `AgentEvent` variants declare MUTABLE fields
 * (`{ plan: … }`) while the slice-fenced protocol mirror declares them
 * `readonly` (`{ readonly plan: … }`) — a deliberate posture difference, NOT a
 * shape drift. A strict `AssertEqual` would (wrongly) fire on that modifier
 * difference. `MutualExtends` instead requires each side to be assignable to the
 * other, which is invariant to `readonly` but STILL fires on a real field drift
 * (a renamed / added / removed / re-typed field breaks assignability in at least
 * one direction). The `& true` collapses the success case to the literal `true`
 * so the runtime sentinel below is meaningful. */
type MutualExtends<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/** Narrow each union to the single member carrying `type: K`. */
type EventOf<K extends string> = Extract<AgentEvent, { type: K }>
type ObsOf<K extends string> = Extract<AgentStateObservation, { type: K }>

/* The 9 per-variant structural pins. Each fails the typecheck if the source
 * `AgentEvent` variant and its protocol mirror diverge (field renamed / added /
 * removed / re-typed) in EITHER direction. */
const _planCreated: MutualExtends<EventOf<"plan_created">, ObsOf<"plan_created">> = true
const _planUpdated: MutualExtends<EventOf<"plan_updated">, ObsOf<"plan_updated">> = true
const _planSnapshot: MutualExtends<EventOf<"plan_snapshot">, ObsOf<"plan_snapshot">> = true
const _planInputRequested: MutualExtends<
  EventOf<"plan_user_input_requested">,
  ObsOf<"plan_user_input_requested">
> = true
const _planInputResolved: MutualExtends<
  EventOf<"plan_user_input_resolved">,
  ObsOf<"plan_user_input_resolved">
> = true
const _modeChanged: MutualExtends<EventOf<"mode_changed">, ObsOf<"mode_changed">> = true
const _toolProgress: MutualExtends<EventOf<"tool_progress">, ObsOf<"tool_progress">> = true
const _contextCompacted: MutualExtends<
  EventOf<"context_compacted">,
  ObsOf<"context_compacted">
> = true
const _ratelimitSnapshot: MutualExtends<
  EventOf<"ratelimit_snapshot">,
  ObsOf<"ratelimit_snapshot">
> = true

/* Closure pin: the protocol mirror union covers EXACTLY the 9 tapped types — no
 * more, no less. `AgentStateObservation["type"]` must equal the closed 9-literal
 * union (a 10th member added to the mirror without a tap entry, or a dropped
 * member, fails here). */
type TappedType =
  | "plan_created"
  | "plan_updated"
  | "plan_snapshot"
  | "plan_user_input_requested"
  | "plan_user_input_resolved"
  | "mode_changed"
  | "tool_progress"
  | "context_compacted"
  | "ratelimit_snapshot"
const _coversExactly9: AssertEqual<AgentStateObservation["type"], TappedType> = true

describe("AgentStateObservation ↔ AgentEvent mirror (compile-time enforcement)", () => {
  test("the 9 per-variant structural pins + the closure pin all type-check", () => {
    // SUM the type-level checks into one runtime confirmation. The real failure
    // mode is `tsc --noEmit` red on any divergent `_assert*` above.
    expect(
      [
        _planCreated,
        _planUpdated,
        _planSnapshot,
        _planInputRequested,
        _planInputResolved,
        _modeChanged,
        _toolProgress,
        _contextCompacted,
        _ratelimitSnapshot,
        _coversExactly9,
      ].every((v) => v === true),
    ).toBe(true)
  })
})
