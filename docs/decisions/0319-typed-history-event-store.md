# ADR-0319 — Typed history event store (foundation slice)

Status: accepted
Date: 2026-05-27

> **Numbering note.** This ADR was drafted as `0300` per the originating
> task. ADR-0300 was already taken by
> `0300-per-tool-granular-registry.md` (in-flight user track), so per
> the project's user-deference renumber policy
> (`memory/adr-collision-policy-2026-05-25.md`) our slice renumbers to
> the next free slot, `0319`. The user's ADR-0300 stays at 0300.

## Context

`quanta` wm (`src/memory/working.ts`) currently stores only the flat
Anthropic content-block union (`text` / `tool_use` / `tool_result` /
`thinking` / `image` / `document`). Side-channel signals that the next
prompt assembly cares about — mode flips, cwd flips, repo-rules tree
changes, skill activations, provider reasoning signatures — have to be
re-derived from the flat message body, which is lossy and order-fragile.

Codex's `codex-rs/core/src/session/turn.rs` (`record_conversation_items`
≈ line 161; `ResponseItem` discriminator ≈ lines 182-185) solves this
by writing a PARALLEL typed envelope stream into the session as it
records conversation items. Each variant carries a closed shape
(`Reasoning { signature, ... }`, `FunctionCall { ... }`,
`FunctionCallOutput { ... }`, side-channel context-update records, ...)
so a downstream prompt builder can iterate the typed stream and inject
only the structured turn-deltas it needs, without re-parsing message
bodies.

We want the same affordance, but without mutating `wm` — wm's flat
shape is load-bearing for the Anthropic content-block round-trip and
for the existing 5-layer memory contract (ADR-0021).

## Decision

Introduce a new closed-port slice `src/memory/typed-event/` that lives
PARALLEL to wm:

- 5-variant `TypedHistoryEvent` discriminated union covering the
  side-channel signals we need first: `context_update`,
  `skill_activation`, `repo_rules_change`, `mode_change`,
  `reasoning_echo`. **Closed set** — extending requires a new ADR.
- Closed port `TypedHistoryEventStore { append, snapshot, since, clear }`.
  Sync, in-process. Producers stamp `at` themselves; the store is a
  pure container.
- Default in-memory adapter (`createInMemoryTypedHistoryEventStore`)
  with append-only array semantics. `snapshot()` returns a frozen
  shallow copy each call. `since(t)` is **INCLUSIVE** on the lower
  bound so a polling consumer can resume with the last seen `at`
  without losing same-millisecond events.

### Closed port

```ts
interface TypedHistoryEventStore {
  append(event: TypedHistoryEvent): void
  snapshot(): readonly TypedHistoryEvent[]
  since(at: number): readonly TypedHistoryEvent[]   // INCLUSIVE
  clear(): void                                     // session boundary
}
```

Surface widening (adding a method, loosening a return type, dropping a
method) requires a new ADR. The 5-variant union widens under the same
rule.

### The 5 variants (frozen by this ADR)

| kind                 | shape (load-bearing fields)                                              |
|----------------------|--------------------------------------------------------------------------|
| `context_update`     | `{ field: "cwd" \| "mode" \| "repo_rules" \| "active_skills" \| "model"; prev, next }` |
| `skill_activation`   | `{ skillId; trigger: "user" \| "auto" \| "system" }`                     |
| `repo_rules_change`  | `{ addedPaths: readonly string[]; removedPaths: readonly string[] }`     |
| `mode_change`        | `{ prev: string; next: string; reason? }`                                |
| `reasoning_echo`     | `{ signature; redacted: boolean; tokenCount? }`                          |

Every variant additionally carries `at: number` (epoch ms) and
optional `turnId?: string`. `turnId` is producer-supplied; the store
does not synthesize one.

## Non-goals

- **wm replacement.** wm continues to be the SSOT for the Anthropic
  content-block stream. This slice does not duplicate or shadow message
  content.
- **Disk persistence.** The default adapter is in-process only. A
  jsonl-file or sqlite adapter is out of scope here (will be a separate
  ADR if needed, satisfying the same port).
- **Cross-session bleed.** The store is one-per-session; `clear()` is
  the boundary. No cross-session aggregation.
- **Auto-wiring.** Default-OFF. No production code path imports this
  slice yet. ADR-0301 wires producers and the prompt-body inject seam.

## Wiring

- **This ADR (foundation):** slice + closed port + default adapter +
  10 hellgate tests + 1 port-contract test. No consumer.
- **ADR-0301 (next):** producer hooks (mode flip / cwd flip /
  repo-rules tree diff / skill activation / Anthropic `thinking`
  signature capture) and the prompt-body inject seam under a feature
  flag.

## Files

```
src/memory/typed-event/
├── types.ts                            # 5-variant union + tags
├── port.ts                             # closed port
├── in-memory-store.ts                  # default adapter + factory
├── index.ts                            # barrel (port + types + factory)
└── __tests__/
    ├── in-memory-store.hellgate.test.ts
    └── port-contract.test.ts
```

The slice is reachable via `@/memory/typed-event` (the tsconfig path
mapping `@/memory/*` resolves it). It is intentionally NOT re-exported
from the `@/memory` barrel — until ADR-0301 lands a wired consumer, the
default-OFF surface stays opt-in.

## Slice fence

Inside `src/memory/**` biome forbids importing `@/tool`, `@/stream`,
`@/permission`, `@/lsp`, `@/observability`, `@/llm`, `@/security`,
`@/patch`, `@/rules`, `@/mcp` (RFC §3.1, ADR-0001). This slice imports
nothing from the project — its only dependencies are `bun:test` (test
files) and the slice's own internal modules.
