# ADR-0228: Queued follow-up per-msg mutators (`retry` / `edit` / `delete` / `sendNow`)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Renumbered**: from initially-drafted ADR-0221 (collision with
  `0221-git-directive-emit-protocol.md`) and the subsequent occupied
  block 0222-0227. Per ADR-collision policy
  (memory `adr-collision-policy-2026-05-25`): user keeps original,
  ours renumber to next-free. Next free at write time was 0228.
- **Related ADRs**: ADR-0128 (plan-queue helper — this slice extends the
  in-memory primitive with per-msg mutators), ADR-0037 (queued
  follow-ups — original Codex absorption that established the 12-field
  envelope this slice now lets the operator manage), ADR-0208 (`/voice`
  slash — sibling slash that already enqueues to plan-queue;
  `voice_transcript` follow-ups become first-class citizens of the
  new `/queue` surface)
- **References**: `src/agent/plan-queue.ts` (4 mutators + `SendNowSink` +
  `findEntry`), `src/apps/cli/queue-cmd.ts` (5-subcommand `/queue` slash),
  `src/observability/metrics/instrument-plan-queue.ts` (mutator counter),
  `tests/unit/queue-per-msg-mutators-hellgate.test.ts`,
  `tests/unit/cli/queue-cmd-hellgate.test.ts`

## Research grounding

Per the Codex Desktop composer surface: each queued follow-up shows a
context menu with four actions — `retry`, `edit`, `delete`, `sendNow`.
The i18n keys are `composer.queuedMessage.{paused,retry,sendNow,delete}`.
The `sendNow` action is the most distinctive: it bypasses the paused state
(`pausedReason` of the current turn) and delivers the message to the NEXT
turn WITHOUT aborting/interrupting the in-flight turn. This is "steering
bypass" — orthogonal to the ADR-0030 mid-turn-steer slot (which IS an
interrupt-flavoured mutation of the active turn's prompt) and orthogonal
to ADR-0086 plan-exit decisions (which IS a control-flow signal).

ADR-0128 already absorbed the structural surface (`PlanQueueStore` +
12-field `FollowUp` + LRU + dedup) so quanta has the queue. ADR-0037
absorbed the pause-reason vocabulary. The MISSING piece was the per-entry
operator surface: today the operator can only `peek` / `drain` / `clear`
entire threads. The four mutators close that gap.

## Context

Three constraints shape the slice:

1. **Default-OFF byte-identical**: existing `enqueue` / `drain` / `peek` /
   `clear` / `inspect` signatures must not regress. Callers that never
   touch the new mutators see byte-identical queue state. The mutator
   surface is OPT-IN — the host wires the `SendNowSink` (only required by
   `sendNow`) and constructs a `/queue` `SlashContext.planQueue` field
   when ready.

2. **Steering bypass invariant**: `sendNow` must NOT abort/interrupt the
   active turn. The store has no abort signal, no event bus emit, no
   synchronous drain trigger — its sole observable effect is (a) sink
   call + (b) entry removal. The `SendNowSink.inject` contract documents
   this; HELL-S3 pins it as a regression check.

3. **No-throw surface**: every mutator returns `Result<T, QueueMutateError>`
   with a closed 4-arm error union (`not-found` / `already-active` /
   `invalid-text` / `send-not-possible`). Sink throws are caught and
   converted to `send-not-possible`. Callers never see an exception.

## Decision

Add four mutators + one inspector to `PlanQueueStore` and surface them
via a new `/queue` slash command.

| Mutator | Signature | Failure modes |
|---|---|---|
| `findEntry` | `(id: string) → FollowUp \| undefined` | (never fails — undefined on miss) |
| `retry` | `(id: string) → Result<FollowUp, …>` | `not-found` |
| `edit` | `(id: string, newText: string) → Result<FollowUp, …>` | `not-found`, `invalid-text` |
| `delete` | `(id: string) → Result<void, …>` | `not-found` |
| `sendNow` | `(id: string) → Result<void, …>` | `not-found`, `send-not-possible` |

`retry` is **remove-and-re-enqueue atomically**: the source entry is
deleted and a fresh entry (new id, new `enqueuedAtMs`, same text +
metadata + label + urgency) is pushed. This avoids the dedup-with-self
pitfall (`enqueueInternal` would collapse to the source entry's id and
return a stale handle). The `already-active` error variant is reserved in
the public Result shape for a future async-mutation regime — today the
store is synchronous so a live id is unambiguously available to retry.

`edit` validates the new text (trim-empty / over-64KiB → `invalid-text`),
fast-paths a no-op edit (same text ⇒ stable id + hash), and runs a
collapse-with-sibling check: if the new hash matches another LIVE entry
on the same thread, merge urgency + drop THIS entry + return the
survivor. Mirrors enqueue-side dedup so `edit` and `enqueue` converge.

`delete` removes the entry from the live array and cleans up the empty
queue's map entry so `inspect` / `peek` see no stale thread keys.

`sendNow` removes the entry FIRST (contract: removal happens before sink
call), then hands the payload to the wired `SendNowSink`. A sink that
throws OR returns `{ok:false}` yields `send-not-possible`; the entry
stays removed (caller can re-enqueue if intent demands). When no sink is
wired (default-OFF), every `sendNow` returns `send-not-possible` and the
entry is still removed — symmetric with the wired path so a host that
opts in later behaves identically.

### `SendNowSink` port

```ts
export interface SendNowSink {
  inject(input: SendNowInjection): { ok: true } | { ok: false; reason: string }
}

export interface SendNowInjection {
  readonly threadId: string
  readonly text: string
  readonly source: FollowUpSource
  readonly enqueuedAtMs: number
  readonly metadata: Readonly<Record<string, string>>
  readonly label?: string
}
```

Wired by the apps/agent bootstrap; the sink's job is "submit this text
for inclusion in the NEXT LLM turn without aborting the current one".
For the REPL surface, this typically means appending to the working-
message queue read at the next turn boundary. For headless / API
surfaces, appending to the next-prompt buffer.

### `/queue` slash command

```
/queue list                       — print live entries (all threads)
/queue retry <id-prefix>          — re-enqueue with fresh id/timestamp
/queue edit <id-prefix> <text...> — replace entry text in-place
/queue delete <id-prefix>         — remove entry from queue
/queue send-now <id-prefix>       — inject into NEXT turn (no interrupt)
```

Id-prefix resolution mirrors `/rewind-tool`: exact id wins; otherwise a
unique prefix wins; ambiguous prefix returns an error. Operator types
`fu-t1-` or even just `1` instead of the full id.

Registered as the LAST entry in `BUILTINS` per the per-task spec —
trailing slot pinned by `slash-commands.test.ts`. No collision with
`/rewind-tool` (W1-6), `/fork` (W2-1), or the W2-5 `/web` / `/paste` /
`/edit-plan` / `/edit-message` cluster.

`ctx.planQueue` absent ⇒ `/queue *` prints "not wired in this surface"
and exits 0 — parity with `/snapshot`, `/side`, `/skills`, `/rewind-tool`.

### Observability

`instrumentPlanQueue` gains one new counter:

```
plan_queue.mutate.total    labels: op ∈ {retry,edit,delete,sendNow},
                                   outcome ∈ {ok, not-found, already-active,
                                              invalid-text, send-not-possible}
```

So operators can spot a misconfigured `sendNow` sink (sendNow.send-not-
possible spike) or a UI bug spamming retry on a drained id (retry.not-
found spike).

## Consequences

- ✅ Plan-queue gains operator-facing management; `/voice` follow-ups
  (ADR-0208) become first-class managed entries.
- ✅ Steering bypass invariant lets the operator inject "actually do
  this NOW" without aborting an in-flight tool call.
- ✅ Default-OFF: 4 mutator no-call → byte-identical to ADR-0128's
  pre-mutator behaviour. Observability counter only fires when called.
- ⚠️ `retry` discards the source entry's `enqueuedAtMs` and `id` — the
  operator's chip handle changes after retry. Documented in `/queue
  retry: ok ({old}) — new id {new}`.
- ⚠️ `sendNow` removes the entry BEFORE sink success. A sink that
  rejects leaves the operator with a removed entry + typed error;
  they re-enqueue if intent demands. Trade-off vs the alternative
  (sink-fail-then-restore) which can't atomically handle a sink-throw.

## Negative invariants

Pinned by `tests/unit/queue-per-msg-mutators-hellgate.test.ts`:

- `sendNow` MUST NOT mutate any entry other than its target (HELL-S3).
- `sendNow` MUST convert sink throws to `send-not-possible` (HELL-S4).
- `sendNow` MUST convert sink `{ok:false}` to `send-not-possible` (HELL-S5).
- All 4 mutators MUST be idempotent: second call on a successful target
  observes `not-found` (HELL-X1).
- `retry` MUST assign a FRESH id every call — no id reuse (HELL-X4).
- `edit` MUST reject empty / whitespace-only / over-64KiB text and leave
  the entry untouched (HELL-E2, HELL-E4).
- `edit` MUST merge urgency when collapsing to a sibling and drop THIS
  entry (HELL-E5).
