# ADR-0324 — Compaction event as typed history variant (ADR-0320 closed-set extension)

Status: accepted
Date: 2026-05-27

> **Numbering note.** Drafted as `0324`; no collision found at the time
> of landing (`docs/decisions/0322-cache-control-thread-stability.md`
> is the latest occupant in the 03xx range; user in-flight slots
> reconciled per `memory/adr-collision-policy-2026-05-25.md`).

## Context

ADR-0320 introduced `src/memory/typed-event/` — a side-channel store
that records 5 closed-set variants of `TypedHistoryEvent`
(`context_update`, `skill_activation`, `repo_rules_change`,
`mode_change`, `reasoning_echo`) so the next prompt assembly can read
structured turn-deltas without re-parsing the flat wm message body.

Codex (`codex-rs/core/src/session/turn.rs:284-310`) goes one step
further: it bakes the **compaction fact** into the conversation
history as a typed `ResponseItem` variant
(`ResponseItem::Compaction / ContextCompaction / CompactionTrigger`),
emitted by `run_auto_compact(..., InitialContextInjection::BeforeLastUserMessage, MidTurn)`.
Because the variant ends up in `clone_history().for_prompt()`, the
next iteration sees a compact-aware narrative — the model itself can
observe "a compaction pass ran" instead of silently losing context.

`quanta` today records compaction only through:

1. A `wm` mutation (messages dropped / rewritten), and
2. Turn-summary metadata (out-of-band, not visible to the model).

The model has no narrative anchor for "I was compacted". When the
follow-up turn asks "why don't you remember X?" the model cannot tell
whether the context was simply not present or was compacted away.

## Decision

Extend the ADR-0320 closed-set `TypedHistoryEvent` union with a 6th
variant `compaction_event`:

```ts
export interface CompactionEventVariant {
  readonly kind: "compaction_event"
  readonly trigger: "pre_sampling" | "mid_turn" | "user_requested"
  readonly reason: "context_limit" | "token_budget" | "manual"
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly messagesRemoved: number
  readonly at: number
  readonly turnId?: string
}
```

The wm mutation channel is left unchanged — the new variant is
**orthogonal**, emitted alongside the mutation so consumers that need
either signal can subscribe independently. The new variant lives in
the existing ADR-0320 slice (`src/memory/typed-event/`), reusing the
`TypedHistoryEventStore` port and the in-memory default adapter
verbatim.

### Schema rationale

- **`trigger`** mirrors the Codex call sites: `pre_sampling` (turn
  begins, context too large), `mid_turn` (sampling produced a
  follow-up tool call but the running context exceeded budget), and
  `user_requested` (manual `/compact` / `/condense` / API trigger).
- **`reason`** separates *why* from *when*: `context_limit` (the
  provider context window itself was nearly full), `token_budget` (a
  configured budget knob fired before the provider limit), or
  `manual` (no automatic threshold; user / orchestrator decision).
- **`tokensBefore` / `tokensAfter`** are estimates supplied by the
  producer. The invariant `tokensAfter <= tokensBefore` is the
  **producer's responsibility**. The store boundary (`append`) does
  **NOT** validate — consistent with ADR-0320 §port-contract ("the
  event is stored verbatim; no validation, no de-duplication"). The
  hellgate suite pins this non-validation invariant so a future
  producer-side check cannot silently migrate into the store.
- **`messagesRemoved`** counts messages dropped (non-negative).
  `messagesRemoved === 0` means a compaction pass was attempted but
  trivial (no removal) — still emit so the model sees the attempt.

### Closed-set extension (not supersession)

This ADR **extends** ADR-0320; it does **not** supersede it. The
original 5 variants keep their field names, shapes, and JSDoc
verbatim. The `TypedHistoryEvent` union grows from 5 to 6; the
`TypedHistoryEventKind` literal union gains `"compaction_event"`. The
port surface (`append / snapshot / since / clear`) is unchanged.

The extension log in ADR-0320 §`Closed-set extension log` records
this transition (5 → 6). Future variants follow the same pattern:
new ADR + ADR-0320 log row + slice-internal type additions only.

### Files touched

In-slice (ADR-0320 fence):

- `src/memory/typed-event/types.ts` — add `CompactionEventTrigger`,
  `CompactionEventReason`, `CompactionEventVariant`; widen
  `TypedHistoryEvent` union.
- `src/memory/typed-event/index.ts` — re-export the new type aliases
  and variant interface.
- `src/memory/typed-event/__tests__/port-contract.test.ts` — update
  the compile-time `Equals<TypedHistoryEventKind, ...>` assertion
  from 5 to 6 literals; add `"compaction_event"` to the exhaustive
  switch.
- `src/memory/typed-event/__tests__/in-memory-store.hellgate.test.ts`
  — extend the 5-variant round-trip case to 6; add 5 new hellgate
  tests pinning trigger / reason / messagesRemoved=0 / store-does-not-
  validate-tokens / optional turnId.

ADRs:

- `docs/decisions/0320-typed-history-event-store.md` — add §`Closed-set
  extension log` row + add the 6th variant row to the variants table.
- `docs/decisions/0324-compaction-typed-history-event.md` — this file.

## Non-goals

- **Compaction algorithm changes.** The compaction strategy
  (sliding-window, summary-replay, importance-pruning) is out of
  scope — this ADR only adds the *observation* schema.
- **Removing the wm mutation.** wm continues to be the SSOT for the
  Anthropic content-block stream. The typed event is purely
  side-channel narrative.
- **Producer wiring.** Default-OFF. No production code path emits
  `compaction_event` yet — a separate ADR will hook the existing
  compaction call sites (wm summarizer, manual `/compact` slash) into
  the typed event store. This ADR is schema-only.
- **Prompt-body inject seam.** The consumer side (how a downstream
  prompt builder surfaces `compaction_event` to the model) is ADR-0321
  territory.

## Wiring

- **This ADR (schema-only):** 1 new variant in the closed union;
  default-OFF; no consumer; no producer.
- **Future producer ADR:** emit on every compaction call site (wm
  summarize, manual `/compact`, budget-breaker auto-compact).
- **ADR-0321 (consumer):** prompt-body inject seam reads from
  `since(t)` and includes a compact summary line in the next system
  prompt so the model has a narrative anchor.

## Slice fence

Same as ADR-0320: `src/memory/**` may not import `@/tool`, `@/stream`,
`@/permission`, `@/lsp`, `@/observability`, `@/llm`, `@/security`,
`@/patch`, `@/rules`, `@/mcp` (RFC §3.1, ADR-0001). This extension
adds only literal-typed fields and number/string primitives — no new
dependencies.
