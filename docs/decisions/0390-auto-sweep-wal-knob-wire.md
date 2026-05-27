# ADR-0390 — Auto-sweep WAL knob wire (close ADR-0375/0385 production-path gap)

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0369 (auto-sweep), ADR-0375 (WAL RESTART check),
ADR-0385 (TRUNCATE mode)
**Slice:** `agent/session-resource-registry/auto-sweep.ts` + hellgate
extension (no new file).
**Default-OFF:** Yes — env+cfg absent ⇒ PASSIVE-only, byte-identical to
pre-R15 auto-sweep.

## Context

The R15 audit (round 1, cross-cut lens, finding F11) discovered that
ADR-0375 (`walSizeThresholdBytes`) + ADR-0385 (`walCheckpointUpgradeMode`)
ship as `SqliteRegistryConfig` knobs but `auto-sweep.ts:276` (the
production sweep dispatcher) called `sweepSqliteRegistry({ databasePath,
now })` — **the new knobs never reached the production path**. Only
direct callers of `sweepSqliteRegistry` (none in production) got the
benefit. The periodic auto-sweep — the actual mechanism a deployed
process relies on for WAL hygiene — was blind to both.

`AutoSweepConfig` also had no knobs to set them.

## Decision

Two changes to `src/agent/session-resource-registry/auto-sweep.ts`:

1. **`AutoSweepConfig` gains two optional fields** mirroring the
   sqlite-adapter shape:

   ```typescript
   readonly walSizeThresholdBytes?: number
   readonly walCheckpointUpgradeMode?: SqliteRegistryConfig["walCheckpointUpgradeMode"]
   ```

2. **Two new env vars** (sibling to the existing `DISK_DIR_ENV` /
   `SQLITE_PATH_ENV`):

   ```
   QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES   (base-10 integer)
   QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE   ("RESTART" | "TRUNCATE")
   ```

3. **Resolvers + thread.** `resolveWalThresholdBytes` + `resolveWalUpgradeMode`
   follow the existing `resolveDiskDir` / `resolveSqlitePath` precedence:
   cfg wins over env. Negative / non-finite thresholds are rejected at
   the resolver (treated as absent) so downstream sees only valid values.
   Both are resolved once at `startAutoSweep` time and pinned for the
   handle's lifetime — env changes mid-process require a restart, same
   convention as `diskDir` / `sqlitePath`.

4. **`runSqliteSweep` extraction.** The sqlite branch of `sweepOnce`
   was approaching the cognitive-complexity cap (15) once the new knobs
   landed. Extracted to a sibling helper that builds the cfg object
   with the optional knobs included only when defined (preserving the
   byte-identical `sweepSqliteRegistry({ databasePath, now })` shape on
   the unset path).

5. **Two new observability counters** added to the sqlite branch:

   ```
   codex_r2.sweep.sqlite_wal_restarted   (counter, 1 when RESTART fired)
   codex_r2.sweep.sqlite_wal_truncated   (counter, 1 when TRUNCATE fired)
   ```

   Counters not gauges (mirroring `sqlite_checkpointed`'s existing shape):
   each sweep contributes 0 or 1 to the running total so operators can
   verify their threshold + mode wiring is firing on a quiet workload.

## Behavior table

| `cfg.walSizeThresholdBytes` | env `_WAL_THRESHOLD_BYTES` | `cfg.walCheckpointUpgradeMode` | Effective threshold | Effective mode |
|----|----|----|----|----|
| absent | absent | any | undefined | undefined |
| absent | `"10000"` | absent | 10000 | undefined |
| 5000 | `"10000"` | "RESTART" | 5000 (cfg wins) | "RESTART" |
| -1 | absent | any | undefined (rejected) | as supplied |
| 10000 | absent | "BOGUS" | 10000 | "BOGUS" (downstream `ALLOWED_UPGRADE_MODES` whitelist coerces to noop) |

## Why surface counters (not just trust the existing `sqlite_checkpointed`)

`sqlite_checkpointed` fires on every PASSIVE checkpoint — it tells you
the periodic sweep is alive but not whether the RESTART/TRUNCATE
escalation actually fired. Operators tuning ADR-0375 need to see
"threshold X produced N RESTART events in 24 hours" — the new counters
give that without changing the gauge contract.

## Why pin resolution at start, not per-tick

`startAutoSweep` resolves env vars exactly once for `diskDir` and
`sqlitePath`. Pinning the WAL knobs at the same point keeps the
mental model consistent: change env → restart process. Re-reading
env on every tick would invite race conditions with operators
tuning live thresholds via shell `export`.

## Why counters always emit (delta 0 when the upgrade did not fire)

A flat unconditional emit is simpler than a "skip-emit-when-zero"
branch and makes the periodic counter's *absence* a reliable
diagnostic signal (gap in the time series ⇒ sweep is not running,
not ⇒ checkpoint did not fire). The same pattern is used for
`sqlite_evicted` (emits 0 when no eviction happens).

## Non-goals

- **Per-tick env re-read.** Out of scope.
- **Auto-recommendation of the threshold from `wal_bytes` history.**
  Operator tunes manually based on observed WAL gauge — that's the
  whole point of ADR-0378.
- **Disk-adapter equivalent.** Disk has no WAL.
- **Wiring the `walCheckpointUpgradeMode` whitelist at the auto-sweep
  layer.** Resolver passes unknown strings through to
  `sweepSqliteRegistry`'s `ALLOWED_UPGRADE_MODES`; double-validating
  here would duplicate the contract. Single source of truth.

## Files

- `src/agent/session-resource-registry/auto-sweep.ts` — 2 new cfg
  fields + 2 env vars + 2 resolvers + `runSqliteSweep` extraction + 2
  new counters + threaded `walSizeThresholdBytes` /
  `walCheckpointUpgradeMode` through `sweepOnce` /
  `startAutoSweep`.
- `tests/unit/auto-sweep-hellgate.test.ts` — 4 new cases [BB], [CB],
  [DB], [EB] (the second-letter doubled scheme keeps the existing
  [A–AA] sequence intact + leaves room for siblings).

## Hellgate

`bun test tests/unit/auto-sweep-hellgate.test.ts` ⇒ 31 pass / 0 fail
(27 retained + 4 new). 51 expect() calls.

## References

- ADR-0369 — Auto-sweep (this ADR extends)
- ADR-0373 — Auto-sweep telemetry shape
- ADR-0375 — WAL size threshold + RESTART (now reachable in
  production via this ADR)
- ADR-0378 — `wal_bytes` gauge (operators tune the threshold using
  this gauge; that loop now closes)
- ADR-0385 — `walCheckpointUpgradeMode` knob (now reachable in
  production via this ADR)
- ADR-0389 — R15 retrospective process ADR (audit lens that surfaced
  this gap)
