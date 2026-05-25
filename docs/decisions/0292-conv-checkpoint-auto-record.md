# ADR-0292 — Conversation-Checkpoint Per-Turn Auto-Record + `/rewind-conv` Slash

## Status

Accepted (default-OFF).

## Context

ADR-0124 shipped `ConversationCheckpointStore` — a pure in-memory
`messages[]` snapshot/restore primitive, the conversation-side
counterpart of `ShadowOdb` (file face). The store's `deliberate_hold`
note flagged it as "awaiting a consumer (e.g. `/rewind` slash command or
auto-recovery hook to opt-in)". Today the agent loop NEVER reads or
writes the store: the JSDoc on the `AgentConfig.conversationCheckpoint`
slot (`src/agent/types.ts:923`) calls it out explicitly — "NOT consumed
by the loop itself today — slot exists for caller-side composition".

Competing products show the user-visible payoff of the missing half:
Hermes Agent's `/rollback` restores both file state and conversation
context in one shot; Cline's "Restore Files & Task" mode is the same
shape. quanta already has the file half (ADR-0118 / ADR-0122
`/snapshot`); this ADR delivers the conversation half — minus any loop
coupling.

## Decision

Ship a **surface-side** auto-record wire + a `/rewind-conv` slash
command. The agent loop is untouched.

### Wire shape — `ConvCheckpointWire`

Location: `src/apps/cli/repl/conv-checkpoint-wire.ts`.

```ts
export interface ConvCheckpointWire {
  recordTurn(messages: readonly Message[]): void
  listTags(): readonly { tag: string; takenAt: number; len: number }[]
  restore(tag: string): readonly Message[] | null
  stop(): void
}
export function startConvCheckpointWire(opts: {
  store: ConversationCheckpointStore
  tagFormat?: (turn: number, now: number) => string
  maxEntries?: number
  now?: () => number
}): ConvCheckpointWire
```

The wire holds a monotonic turn counter. Callers (the host REPL, a
Tauri shell, a future headless surface) invoke `recordTurn(messages)`
at turn-end (post-successful-turn hook). The wire mints a tag via
`tagFormat(turn, now())` — default `turn-${turn}-${now}` — and calls
`store.record(tag, messages)`. Tags surface verbatim in `/rewind-conv`'s
listing.

### Slash shape — `/rewind-conv`

Location: `src/apps/cli/rewind-conv-cmd.ts`.

Three forms:

- `/rewind-conv` — list tags (newest-first); one line per tag.
- `/rewind-conv --list` — explicit-flag alias of the no-arg form (help
  discoverability).
- `/rewind-conv <tag>` — restore that snapshot's `messages` and call
  `ctx.convCheckpoint.replaceMessages(restored)` so the surface swaps
  its live transcript binding.

`SlashContext` is extended via the typed `declare module` pattern
(parity with `/snapshot`, `/fork-checkpoint`, `/queue`, `/inspect` etc.):

```ts
declare module "./slash-commands" {
  interface SlashContext {
    readonly convCheckpoint?: ConvCheckpointSlashState | undefined
  }
}
```

The `ConvCheckpointSlashState` carries both the wire (for `listTags` /
`restore`) and a `replaceMessages(msgs)` adapter — only the surface
knows how to swap its live `history` binding, so the wire owns the
store and the surface owns the live-binding swap.

### Registration

A 2-line touch in `src/apps/cli/slash-commands.ts`: an `import` and an
append to the `BUILTINS` array. No edits to the dispatch switch or
runtime — table-driven by construction.

## Default-OFF posture (RFC §1.2)

When the host never instantiates a wire (`ctx.convCheckpoint` absent),
zero allocations happen and zero loop paths change. The slash command
prints `/rewind-conv: not wired in this surface` and exits 0 — the
canonical "not wired" pattern (parity with `/snapshot`, `/snooze`,
`/skills`, `/side`, `/profile`, `/identity`, `/focus-chain`, `/effort`,
`/inspect`, `/replay`, `/why`).

## No-throw guarantee

Every wire method either returns its declared shape or no-ops. The
underlying `ConversationCheckpointStore.record` is no-throw on its
documented public surface (it only throws on programmer-bug
`messages` non-array); the wire adds an outer try/catch as
belt-and-suspenders so any future internals change cannot cascade into
the loop via the surface-side hook.

## Negative invariants (things this ADR explicitly does NOT do)

1. **No loop coupling.** `src/agent/loop*.ts`, `src/agent/dispatch.ts`,
   `src/apps/agent/index.ts`, `src/tool/index.ts` — all untouched.
   `ConvCheckpointWire.recordTurn` is caller-driven from the host
   surface's turn-end hook; there is no observer-pattern injection into
   the loop.
2. **No store mutation.** `src/agent/conversation-checkpoint.ts` is
   read-only from this slice. The wire wraps, never extends.
3. **No persistence.** The wire is in-memory only (delegates to the
   store, which is in-memory only). Persistence is a follow-up; this
   ADR is intentionally scope-limited to the per-turn-record + restore
   shape.
4. **No mid-turn restore.** `/rewind-conv <tag>` replaces the live
   transcript via the surface adapter, but the actual swap happens
   between turns (the slash runs outside the loop). Mid-turn rollback
   is a separate ADR.
5. **No HITL gate on restore.** Unlike `/snapshot <N> --yes` (which
   confirms before mutating the workspace), `/rewind-conv <tag>`
   commits immediately on the surface-side swap. Rationale: the
   transcript is in-memory and the original snapshot is preserved
   unchanged in the store, so a "rewind" can itself be rewound (re-run
   `/rewind-conv` with the prior tag). Workspace files (`/snapshot`)
   need a confirm because the restore writes to disk; transcript
   doesn't.
6. **Slot-additive `SlashContext`.** Pure declaration merge — adding a
   new optional field on a shared interface, with `| undefined` per
   repo-wide `exactOptionalPropertyTypes`. No breaking change to the
   five Tier-2 builtins or any other slash command.

## Wire-up vs. slot definition

This ADR provides the SLICE only — the wire helper, the slash, the
SlashContext slot. Constructing `startConvCheckpointWire({ store })`
in the host REPL bootstrap (so `recordTurn` actually fires after each
turn) and projecting `ctx.convCheckpoint` into `projectSlashCtx` is a
sibling follow-up. Until that follow-up lands, the slash and the wire
exist but are never instantiated — RFC §1.2 byte-identical posture is
preserved.

## Tests

`tests/unit/conv-checkpoint-auto-record-hellgate.test.ts`. 15+ cases:
idempotency on tag collision, round-trip restore, newest-first +
insertion-order tiebreak, `stop()` no-op, "not wired" exit-0, list
rendering, unknown-tag exit-1, valid-tag `replaceMessages` capture,
no-throw on store-internal failure, custom `tagFormat` verbatim, LRU
visible, empty-messages, concurrent `recordTurn` no-corruption,
`--list` flag alias, unknown-flag + too-many-args typed errors.

## Catalog

`tools/feature-catalog/features/04-context-management/0292-conv-checkpoint-auto-record.yaml`
with `depends_on: [conversation-checkpoint-store]`. The sibling
`conversation-checkpoint-store.yaml` `deliberate_hold` note is
intentionally NOT edited (track-fence with the user's in-flight feature
catalog work) — the new YAML's `purpose` cross-references it so the
promotion-path is discoverable.
