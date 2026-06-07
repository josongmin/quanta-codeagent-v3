# ADR-0508: item-lifecycle stream projector

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/stream/item-lifecycle.ts` (`ItemLifecycleTracker`, `itemLifecycleEnabled`)
  - `src/stream/types.ts` (`item_started` / `item_updated` / `item_completed` AgentEvents)
  - `src/stream/adapters/{jsonl-recorder,stdout}.ts` (exhaustive consumers updated)
  - `src/agent/optional-ports.ts` (`wireItemLifecycleStream` decorator)
  - Tests: `tests/unit/item-lifecycle-hellgate.test.ts`, `tests/unit/item-lifecycle-wire-hellgate.test.ts`
  - Absorbs: Codex/Claude per-item streaming protocol (gap-other-agent GAP 10)

## Context

Modern host UIs render per-item progress (a text block / tool call / thinking block has a started →
updated → completed lifecycle). quanta's stream emitted coarse events with no per-item boundaries, so
a thin client could not show "this item is in progress / done".

## Decision

Three additive `AgentEvent` variants (`item_started` {itemId, itemKind, index} / `item_updated`
{itemId, delta} / `item_completed` {itemId}). A pure `ItemLifecycleTracker.track(ev)` projects the
existing event stream into these — tracking open text + open tool ids, closing them at turn
boundaries, ignoring orphan/duplicate signals (fuzz-proven: every started has exactly one completed).
Wired as the final `wireOptionalAgentPorts` decorator behind `QUANTA_ITEM_LIFECYCLE`: gate off ⇒ the
stream is returned unwrapped (byte-identical); on ⇒ each emit also emits the derived lifecycle events
on the underlying sink (no re-entrancy). The two exhaustive stream consumers (jsonl-recorder, stdout)
skip the new variants.

## Consequences

Thin clients gain per-item progress; default-OFF keeps every existing surface byte-identical.
