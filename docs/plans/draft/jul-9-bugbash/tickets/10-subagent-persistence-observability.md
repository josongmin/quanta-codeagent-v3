# ALBB-10 — Subagent persistence save observability

**Priority:** P2 (silent data-loss of crash/resume snapshots; does NOT crash or wedge the live loop — proven non-wedge by HG-SER-3)
**Wave:** B
**Depends on:** none
**Owner:** `src/agent/subagent-persistence-store/hydrating-scheduler.ts`

## Goal

The hydrating scheduler manufactures a typed `PersistenceError("io-failed")`
signal SPECIFICALLY for a caller to branch on — then discards it at every
`store.save` catch site. Surface that already-typed signal out-of-band via an
OPTIONAL injected sink so the host can alert on lost crash/resume snapshots,
WITHOUT (a) breaking plane-cleanness, (b) wedging the live loop, or (c) making
`fork()` async.

## Problem (ground-truthed 2026-07-09)

`store.save` throws a typed, closed-code error on real disk failure:

- Contract: `types.ts:76-82` — `save(...)` "throws `PersistenceError`
  `"io-failed"` on underlying filesystem failure (disk full / EPERM); never
  silently drops a write." The error class (`types.ts:109-117`) exposes a
  closed `code` union "the caller can branch on deterministically (no prose
  parsing)."
- Producer: `jsonl-store.ts:238-239` —
  `throw new PersistenceError("io-failed", \`save ${handle.id}: ...\`)`.

The hydrating scheduler is the caller — and it discards the signal at BOTH
catch sites:

- **Hydration write-through** (`hydrating-scheduler.ts:185-189`): reclassifies a
  dead `"running"` handle to `"interrupted"` and writes it back so the next
  process sees the correction — but

  ```ts
  try {
    await store.save(fixed)
  } catch {
    // intentional swallow — hydration must remain best-effort
  }
  ```

  A dropped write here means the NEXT process re-reads the stale `"running"`
  arm and re-does the same reclassify — silent, unbounded.

- **Save-on-event** (`hydrating-scheduler.ts:233-246`): the per-id write chain:

  ```ts
  const next = prev.then(async () => {
    try {
      await store.save(handle)
    } catch {
      // intentional swallow on save-on-event ...
      // AND the contract on PersistenceError("io-failed") is the SURFACE
      // owner's call to log/alert. Phase 1 keeps the hot path quiet.
    }
    hydratedById.delete(id)
  })
  ```

  The comment itself names the missing piece: "the SURFACE owner's call to
  log/alert" — but no sink exists to hand the error to.

- **Fire-and-forget scheduling** — `void saveLiveHandle(id)` at three sites, so
  even the returned promise's rejection is unobservable:
  - `hydrating-scheduler.ts:275` — fork immediate "running" snapshot
    (worst-case loss: a crash before completion leaves NO discoverable handle).
  - `hydrating-scheduler.ts:304` — cancel-success terminal snapshot.
  - `hydrating-scheduler.ts:319` — `forceBackground` promotion (`promoted_now`
    / `moved_to_front`) snapshot.

- **No observability seam exists.** `grep -n
  'logger|console|emit|onError|onPersist|stream|sink'
  hydrating-scheduler.ts` returns NOTHING. `HydratingSchedulerOpts`
  (`hydrating-scheduler.ts:34-50`) has no error callback. The sole composition
  root (`session-execution-plane.ts:180-184`) passes only `{ inner, store,
  workspace }`. The host cannot alert on persistence loss.

**Constraint — plane-cleanness:** module header (`hydrating-scheduler.ts:17-18`)
forbids `@/agent/loop`, `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool`.
A module-level `logger.warn` import is ILLEGAL here. The fix MUST be
dependency-injected.

## Required changes

1. **Add an OPTIONAL injected sink to `HydratingSchedulerOpts`** (DI observer
   pattern, same shape Codex/Claude-Code harness sinks use — an out-of-band
   callback, never a hard-path import):

   ```ts
   readonly onPersistError?: (
     err: PersistenceError,
     ctx: {
       id: SubagentHandleId
       phase: "hydrate-writethrough" | "save-on-event"
       critical: boolean
     },
   ) => void
   ```

2. **Invoke the sink from BOTH catch sites** (`185-189` and `233-246`) —
   NEVER rethrow into the live loop (preserve non-wedge + hot-path-quiet).
   Narrow the caught value to `PersistenceError` before invoking (the store
   contract only promises that type; if some other throwable escapes, pass it
   through the sink as-is or wrap — do NOT `instanceof`-filter it into a second
   silent swallow). The sink itself must be defensively `try`-guarded so a
   throwing host callback cannot re-wedge the chain.

3. **`critical: true` for the discoverable-handle-loss cases** so the host can
   distinguish a lost fork snapshot (worst case) from a routine transition
   miss:
   - fork-immediate save (`275`) → `critical: true`
   - terminal saves (completion via `watchToCompletion` `254-265`, cancel
     `304`) → `critical: true`
   - `forceBackground` promotion (`319`) → `critical: true` (promotion is a
     discoverable-handle transition)
   - routine intermediate transitions / hydration write-through → `critical:
     false`

   Since all these route through the single `saveLiveHandle` helper, thread a
   `critical` flag (and the `phase`) into `saveLiveHandle` at the call sites
   rather than duplicating the catch.

4. **Do NOT make `fork()` async to await the critical save.** `fork()` is a
   SYNC signature (`hydrating-scheduler.ts:269`); awaiting there risks stalling
   the hot path. The whole point of the typed `PersistenceError` is out-of-band
   observation — surface via the async sink, not by changing the signature.

5. **Wire the sink at the sole composition root**
   (`session-execution-plane.ts:180-184`) to the host's existing structured
   logger / metric emitter, keeping the module plane-clean via DI. Absent sink
   ⇒ current swallow (default-OFF, byte-identical).

6. **Measure-first — NO retry/backoff heuristic.** Just surface the
   already-typed signal. Any retry policy is a separate evidence-gated decision;
   do not add arbitrary thresholds/backoff here.

## Non-goals / preserve

- Keep the per-id write-serialize semantics intact — a rejected link MUST still
  not wedge later writes on the same id (HG-SER-3 invariant).
- Keep `poll`/`await`/`list`/`prune`/`serialize` behavior byte-identical.
- No new module imports beyond `PersistenceError` (already imported via
  `./types`).

## Acceptance

- Forced `store.save` throw (`PersistenceError("io-failed")`) → sink fires with
  correct `{ id, phase, critical }` on EACH of: fork-immediate, cancel-success,
  `forceBackground` promotion, hydration write-through.
- Non-wedge invariant stays green: after a rejected link, the terminal save
  still persists (HG-SER-3 unchanged).
- Absent sink ⇒ byte-identical to today (no new behavior, no new imports pulled).

## Proof rails

Existing (must stay green, unchanged):

```sh
bun test tests/unit/subagent-persistence-write-serialize-hellgate.test.ts
```

`HG-SER-3` (`tests/unit/subagent-persistence-write-serialize-hellgate.test.ts:150-182`)
pins the non-wedge invariant (first save throws → terminal save still persists)
but asserts NOTHING about warn/emit — it does not cover the observability
target, so a NEW test is required.

New — `tests/unit/agent/albb-10-persistence-save-emit.test.ts`
(dir `tests/unit/agent/` — persistence tests are flat under `tests/unit/`, NOT
under a `tests/unit/subagent-persistence-store/` subdir, which does not exist):

1. **Sink-fires (red-on-injection).** With a store whose `save` throws
   `PersistenceError("io-failed")`, assert `onPersistError` is invoked with the
   expected `{ id, phase, critical }` for each path:
   - fork-immediate: `phase: "save-on-event"`, `critical: true`
   - cancel-success: `critical: true`
   - `forceBackground` promotion: `critical: true`
   - hydration write-through: `phase: "hydrate-writethrough"`, `critical:
     false` (seed a persisted `"running"` handle with a dead `hostPid` via a
     fake store + `isProcessAlive: () => false`, then construct the scheduler).

   Mutation check: deleting the sink invocation at either catch site MUST turn
   this test RED.

2. **Non-wedge stays green.** Re-assert HG-SER-3's invariant through the sink'd
   scheduler: first save throws, terminal save still persists (`status ===
   "completed"`), AND the sink observed the first failure.

3. **Default-OFF byte-identical.** With `onPersistError` absent and a store
   whose first save throws, assert the scheduler behaves exactly as today (no
   throw escapes, terminal save still lands) and that no observability import is
   pulled — i.e. the swallow path is unchanged when no sink is injected.
