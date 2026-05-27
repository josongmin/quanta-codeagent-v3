# ADR-0384 — `/session-registry evict` hygiene message

Status: Accepted
Date: 2026-05-28

## Context

ADR-0374 shipped the targeted `/session-registry evict <id>` slash. The
output is intentionally terse:

```
evicted session-x
```

That is enough for a tool/script consumer (the `evicted ` prefix is
grep-stable), but it tells an operator NOTHING about:

1. **Impact.** Did the registry actually shed a session? The
   closed-port `evict` is idempotent on unknown ids (ADR-0345) — the
   `evicted <id>` line surfaces UNCHANGED whether the id was real or a
   typo. An operator reading the output cannot distinguish "I evicted
   one of 12 sessions, 11 remain" from "I typed a wrong id, nothing
   changed".
2. **Reversibility.** `evict` is destructive — events + cache_entries
   are dropped (sqlite via FK cascade; disk via `rm -r`). There is no
   undo. The slash never warns the operator.

Codex's admin path for the equivalent operation
(`sqlite3 logs_2.sqlite 'DELETE FROM sessions WHERE id = ?'`) inherits
sqlite's own non-warning by default. We deliberately do BETTER here
because the slash is an opinionated operator surface, not a SQL shell.

## Decision

Augment `renderEvict` with a **post-evict hygiene block**:

```
evicted session-x
Sessions: 4
(irreversible)
```

Algorithm:

1. Call `registry.evict(sessionId)` (byte-identical to ADR-0374).
2. `await inspectGlobalRegistry()` to get the POST-evict `RegistryStats`
   snapshot.
3. Emit:
   - `evicted <id>` (existing line, byte-identical for downstream parsers)
   - `Sessions: <post-count>` (the new impact signal)
   - `(irreversible)` (the new warning)

The original `evicted <id>` line is **preserved verbatim** — automated
tooling that greps for `^evicted ` continues to work.

## Why post-evict only (no pre/post diff)

Pre-evict + post-evict `inspectGlobalRegistry()` would:

- **Double** the cost. On the sqlite backend, each inspect runs 4
  `COUNT()` + 1 `SUM()` + a WAL `stat`. On the disk backend it walks
  every session dir. The slash is operator-facing — they will tolerate
  one inspect call, not two.
- Surface a delta that is sometimes ambiguous. An auto-sweep that fires
  between the pre + post snapshots can corrupt the diff (a sweep evicts
  N other sessions, the diff reads `N+1` evictions). Single-snapshot
  semantics avoid that race.

The single post-evict snapshot is **informational**, not load-bearing
— the explicit `(irreversible)` warning carries the safety message
independently of any count.

## Why surface `(irreversible)` verbatim

It is the simplest possible signal. `--confirm` flags would change the
ergonomics (and break the existing test contract); a `WARNING:` prefix
would be noisier. The parenthetical "(irreversible)" reads as a
post-action editorial — concise, unambiguous, and parse-friendly.

## Non-goals

- **Pre-evict snapshot.** Skipped for cost (see above).
- **Pre-flight confirm prompt.** The slash is non-interactive (REPL
  emits and exits); a confirm gesture would block. Operators who want
  a confirm gesture should script `if confirm; then evict; fi` upstream.
- **Diff against pre-evict.** Same cost reason. The post-evict count is
  enough to answer "did anything happen?".
- **Per-resource-detail breakdown** (events removed / bytes reclaimed
  per evict). The closed port does not expose those numbers per
  operation; surfacing them would require a port change. The aggregate
  `Sessions:` count is the closest port-honest signal.

## Implementation surface

`src/apps/cli/session-registry-cmd.ts:renderEvict` becomes `async` so
it can `await inspectGlobalRegistry()`. The slash dispatcher already
awaits the return — no caller change.

Inspector is **NO-THROW** (ADR-0370 §NO-THROW) — a hostile backend that
throws from `inspectGlobalRegistry()` is caught and the hygiene block
is silently dropped. The primary `evicted <id>` line is always emitted.

## Tests

`tests/unit/session-registry-slash.test.ts` cases [22] / [23] / [24]
pin the hygiene contract:

- [22] success message contains `irreversible`
- [23] success message contains `Sessions:` post-evict count
- [24] idempotent unknown-id evict also surfaces `irreversible`

## Trade-offs

Single inspect-call adds ~1ms (in-memory) to ~10ms (sqlite COUNT+SUM).
Acceptable: this slash is operator-typed (latency-tolerant), not on a
hot path.

## Future work

- Track per-evict bytes-reclaimed via a port extension (ADR-0386 added
  `listSessionIds`; a follow-up could add `lastEvictionInfo()` returning
  `{ events, bytes }`). Out of scope here.
- A `--dry-run` mode mirroring ADR-0379 §Future work would skip the
  mutation and surface `would-evict` counts. Out of scope.
