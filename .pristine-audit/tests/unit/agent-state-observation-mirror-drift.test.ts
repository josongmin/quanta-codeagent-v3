/**
 * Compile-time projection assertions — `AgentStateObservation`
 * (`@/protocol/agent-state`) is source-derived from the central tapped
 * inventory plus the canonical `AgentEvent` union (`@/stream`).
 *
 * The protocol no longer keeps a hand-maintained 9-arm mirror union. Instead
 * `projection.ts` derives `AgentStateObservation` from the typed tapped-event
 * inventory (`AGENT_STATE_OBSERVATION_EVENT_TYPES`) and the canonical
 * `AgentEvent` union via `Extract<...>`. If the inventory or any tapped source
 * event drifts, these pins fail at type-check time before the owner-path tests
 * even run.
 *
 * This file is exempt from the slice-isolation lint (tests are the integration
 * layer), so we arm the type checker directly against the source union and the
 * exported central inventory.
 *
 * The runtime `expect` below is a proof-of-life sentinel; the real contract is
 * the `extends` chains — the file's value is its TYPE failure mode.
 */

import { describe, expect, test } from "bun:test"
import type {
  AGENT_STATE_OBSERVATION_EVENT_TYPES,
  AgentStateEventObservation,
  AgentStateObservation,
} from "@/protocol/agent-state"
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

/* Closure pin: the EVENT-derived observation union covers EXACTLY the 9 tapped
 * types — no more, no less (a 10th AgentEvent tap added to one side fails here). */
type TappedType = (typeof AGENT_STATE_OBSERVATION_EVENT_TYPES)[number]
const _coversExactly9: AssertEqual<AgentStateEventObservation["type"], TappedType> = true

/* T01 — the FULL observation channel is the 9 event types PLUS the synthetic
 * `item_stream` carrier (NOT an AgentEvent — produced by the central
 * ItemStreamProjector). Pin the exact widening so neither a dropped nor a 3rd
 * synthetic member slips in unnoticed. */
const _fullChannelIs9PlusItem: AssertEqual<
  AgentStateObservation["type"],
  TappedType | "item_stream"
> = true

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
        _fullChannelIs9PlusItem,
      ].every((v) => v === true),
    ).toBe(true)
  })
})
