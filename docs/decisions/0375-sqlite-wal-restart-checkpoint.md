# ADR-0375 — WAL-size-threshold RESTART checkpoint (Codex 14 GB WAL parity)

**Status:** Accepted (2026-05-28)
**Sibling to:** ADR-0361 (SQLite session-registry adapter + PASSIVE checkpoint)
**Slice:** `agent/session-resource-registry/sqlite-adapter/gc.ts` + `types.ts` + hellgate
**Default-OFF:** YES — absent `walSizeThresholdBytes` ⇒ byte-identical to ADR-0361.

## Context

ADR-0361 ships `sweepSqliteRegistry` with a single PASSIVE WAL
checkpoint after each retention pass:

```sql
PRAGMA wal_checkpoint(PASSIVE)
```

PASSIVE is **non-blocking**: it lets concurrent writers continue and
returns immediately on contention. The trade-off is that under heavy
write traffic, PASSIVE may finish **without actually shrinking the
WAL** — the WAL keeps accumulating across sweeps.

### Codex production calibration (memory `codex-logs-retention-pattern`)

After ~10 days of heavy use, Codex `logs_2.sqlite`:

- DB file: **14.8 GB**
- WAL file: **14 GB**
- Total: **~29 GB** for a single database with a 14 GB cap

The 14 GB WAL is **as big as the main DB**, which is the empirical
worst case of "PASSIVE plus a busy writer". Codex mitigates with a
separate daemon process that periodically force-drains the WAL. We
match that posture in-process via the RESTART escalation below.

### Checkpoint mode comparison

| Mode      | Drain WAL | Block readers/writers | Truncate file |
| --------- | --------- | --------------------- | ------------- |
| PASSIVE   | Best-effort | NO                  | NO            |
| FULL      | YES (writers may wait) | reader-safe | NO   |
| **RESTART** | YES (force-drains) | briefly blocks new writers | NO |
| TRUNCATE  | RESTART semantics    | briefly blocks new writers | YES |

PASSIVE is the safest but weakest. TRUNCATE is the most aggressive
(actually shrinks the WAL to 0 bytes). RESTART sits in between: it
fully drains the WAL but leaves the file at its current allocated
size for SQLite's later reuse. We choose **RESTART** for the
threshold-driven escalation because:

1. It actually drains (PASSIVE may not under load).
2. It does not delete file allocations (TRUNCATE does — slower next write).
3. The brief writer-blocking window is acceptable as a periodic sweep
   (default 60 s).

TRUNCATE is intentionally **not** implemented in this ADR — see
§Non-goals.

## Decision

Extend `SqliteRegistryConfig` with one optional knob:

```typescript
readonly walSizeThresholdBytes?: number
```

When set, `sweepSqliteRegistry` runs the existing PASSIVE checkpoint
**and then**:

1. `statSync(<databasePath>-wal)` — read WAL file size.
2. If WAL is missing (ENOENT): treat size as 0 (graceful).
3. If `size > walSizeThresholdBytes`: run `PRAGMA wal_checkpoint(RESTART)`.
4. Report the outcome on `SweepResult.walRestarted: boolean`.

When the knob is absent, the slice is byte-identical to ADR-0361:
PASSIVE-only, no `stat` call, no extra `db.exec`.

### Threshold default

**No default — opt-in.** A composition root that runs without the
knob preserves ADR-0361 semantics exactly. Reasoning:

- The right threshold is workload-dependent. Codex hits 14 GB under
  ~10 d of constant load; a single-developer in-process session
  registry may never see > 100 MB.
- A baked-in default risks RESTART running on a tiny test DB on every
  tick, briefly pausing the writer with no benefit.
- The opt-in shape makes the absorption ROI explicit: the operator
  who has measured WAL bloat sets the knob; everyone else keeps
  PASSIVE-only.

For a production-style mount, callers typically pick ~1 GB (well
under Codex's 14 GB ceiling, well above test-fixture noise). The
slice carries NO `DEFAULT_WAL_SIZE_THRESHOLD_BYTES` export — keeping
the surface honest about the absent default.

### NO-THROW

Both the `statSync` (via `readWalSize`) and the RESTART `db.exec` are
wrapped:

- `statSync` ENOENT (missing WAL) ⇒ size 0 ⇒ RESTART skipped.
- `statSync` other errors (permission, broken symlink) ⇒ size 0 ⇒
  RESTART skipped (degrade to PASSIVE-only).
- `db.exec("PRAGMA wal_checkpoint(RESTART)")` SQLITE_BUSY or other
  failure ⇒ `walRestarted` stays `false`, no throw.

This means an in-flight transaction can never crash the sweep loop —
the existing ADR-0361 NO-THROW contract is fully preserved.

## Test coverage (6 new cases Y-DD)

| Case | Pin                                                                  |
| ---- | -------------------------------------------------------------------- |
| Y    | absent threshold ⇒ PASSIVE only, `walRestarted = false`              |
| Z    | WAL > threshold path reachable (returns boolean, sweep succeeds)     |
| AA   | WAL < threshold (huge threshold) ⇒ no RESTART, `walRestarted = false`|
| BB   | missing WAL file (no writes) ⇒ graceful, no throw                    |
| CC   | RESTART path coexists with existing TTL + size eviction              |
| DD   | threshold = 0 (edge case) ⇒ RESTART when WAL has content             |

All 8 pre-existing cases (1-8) continue to pass — byte-identical when
the knob is absent.

## Non-goals

- **TRUNCATE checkpoint**: a future ADR may add a separate
  `truncate-on-shutdown` path for explicit "shrink WAL to 0" semantics.
  Not in this ADR because it has different blocking semantics
  (writer-wait on a 0-allocation WAL) and a different ROI shape
  (graceful-shutdown only).
- **Automatic threshold picking**: no introspection of WAL growth rate
  to auto-tune the threshold — operator-supplied only.
- **Wiring from `startAutoSweep`**: ADR-0369's auto-sweep config does
  NOT yet forward a `walSizeThresholdBytes` field. A follow-up wire
  adds the env-var swap (e.g. `QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES`).
