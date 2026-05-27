# ADR-0385 — SQLite WAL TRUNCATE checkpoint mode option

**Status:** Accepted (2026-05-28)
**Sibling to:** ADR-0361 (SQLite session-registry adapter + PASSIVE), ADR-0375 (RESTART threshold escalation), ADR-0378 (WAL size telemetry)
**Slice:** `agent/session-resource-registry/sqlite-adapter/{types,gc}.ts` + hellgate
**Default-OFF:** YES — absent `walCheckpointUpgradeMode` ⇒ byte-identical to ADR-0375 RESTART semantics.

## Context

ADR-0375 ships `walSizeThresholdBytes` so the operator can escalate
the existing PASSIVE checkpoint to `PRAGMA wal_checkpoint(RESTART)`
when the WAL file exceeds a configured size. RESTART **drains** the
WAL into the main DB so pages can be reused — but it leaves the WAL
file at its current allocated size on disk for SQLite's later reuse.

In extreme retention scenarios (Codex `logs_2.sqlite` 14 GB WAL after
~10 days; see memory `codex-logs-retention-pattern`), the operator may
prefer the **TRUNCATE** mode, which has the same drain semantics as
RESTART **plus** zeroes out the WAL file on disk. The trade-off is a
slightly longer briefly-blocking window (the file zero-out is done
while writers are paused) and a slower next write (the WAL must be
re-allocated). For a per-minute sweep this overhead is negligible; for
extreme retention scenarios the disk reclamation matters far more.

### Why a new mode option and not a new ADR-0375 default

ADR-0375 §Non-goals explicitly listed TRUNCATE as a "future ADR slot":

> A future ADR may add a separate `truncate-on-shutdown` path for
> explicit "shrink WAL to 0" semantics.

This ADR fills that slot, but with a different (and simpler) shape
than the original §Non-goals sketch: instead of a "shutdown-only"
path, it adds **one** mode-selector knob that runs during the existing
sweep loop. The operator picks the mode once at registry-construction
time and pays the slightly larger writer-pause window on every
threshold-triggered upgrade.

### Checkpoint mode comparison (extended ADR-0375 table)

| Mode      | Drain WAL | Block readers/writers      | Truncate file | ADR     |
| --------- | --------- | -------------------------- | ------------- | ------- |
| PASSIVE   | best-effort | NO                       | NO            | 0361    |
| FULL      | YES (writers may wait) | reader-safe   | NO            | (unused)|
| **RESTART** | YES (force) | briefly blocks new writers | NO          | 0375    |
| **TRUNCATE** | RESTART + | briefly blocks new writers | **YES (size → 0)** | **0385** |

## Decision

Extend `SqliteRegistryConfig` with one optional knob:

```typescript
readonly walCheckpointUpgradeMode?: "RESTART" | "TRUNCATE"
```

Extend `SweepResult` with one sibling boolean field (sibling to
ADR-0375 `walRestarted`):

```typescript
readonly walTruncated: boolean
```

The two booleans are **mutually exclusive by construction**: at most
one is `true` per sweep (case NN).

### Mode dispatch (5-case truth table)

| # | `walSizeThresholdBytes` | `walCheckpointUpgradeMode` | WAL > threshold | Pragma run       | `walRestarted` | `walTruncated` | Case |
| - | ----------------------- | -------------------------- | --------------- | ---------------- | -------------- | -------------- | ---- |
| 1 | absent                  | any / absent               | n/a             | PASSIVE only     | false          | false          | Y/PP |
| 2 | set                     | absent                     | YES             | RESTART (default)| true           | false          | II   |
| 3 | set                     | `"RESTART"`                | YES             | RESTART (explicit)| true          | false          | JJ   |
| 4 | set                     | `"TRUNCATE"`               | YES             | TRUNCATE         | false          | true           | KK   |
| 5 | set                     | any                        | NO              | PASSIVE only     | false          | false          | AA/LL|

Edge cases:

- **mode set + threshold absent** (case MM): mode is ignored (the
  threshold is the activation switch).
- **EMPTY_RESULT path** (case OO): both flags `false`.
- **Unknown mode value** (case RR — defense in depth for JS callers
  ignoring the type): silently rejected, both flags `false`, sweep
  still succeeds.
- **PRAGMA throws under contention**: NO-THROW; both flags `false`
  (matches ADR-0375 RESTART-failure path).

### Why a sibling `walTruncated` field instead of repurposing `walRestarted`

A natural alternative is to reinterpret `walRestarted` as a generic
"upgrade ran" flag covering both modes. We rejected that because:

1. **ADR-0375 contract preservation**: existing consumers of
   `walRestarted` (metrics dashboards, telemetry sinks) interpret it
   as "RESTART specifically". Changing semantics would silently break
   "RESTART vs TRUNCATE" splits downstream.
2. **Closed-set extension log**: adding a sibling field is the same
   pattern used for `walSize` (ADR-0378). The SweepResult shape is a
   tagged union of orthogonal axes; one boolean per axis is the
   cleanest fit.
3. **Mutual-exclusion invariant is explicit**: with two siblings, the
   test `expect(a && b).toBe(false)` (case NN) pins the invariant
   directly. With a single repurposed flag, the invariant becomes
   implicit and silently regressable.

### NO-THROW

Same wrapping as ADR-0375:

- `readWalSize` (statSync) ENOENT / permission / broken symlink ⇒ 0 ⇒
  threshold check evaluates `0 > N` ⇒ false ⇒ no upgrade fires.
- `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")` SQLITE_BUSY or other
  failure ⇒ `walTruncated` stays `false`, no throw. The PASSIVE
  outcome from step 3 is left intact.

The existing ADR-0361 NO-THROW contract is fully preserved.

### Defense-in-depth — mode whitelist

The mode dispatch consults a closed-set whitelist
(`ALLOWED_UPGRADE_MODES = {"RESTART", "TRUNCATE"}`) before splicing
the mode string into the PRAGMA literal. The TypeScript signature
already prevents unknown values at compile time, but downstream JS
callers (composition roots reading env-vars, dynamic config) MAY pass
a stray string. The whitelist guarantees no user-controlled string
reaches the SQL surface.

## Test coverage (10 new cases II-RR)

| Case | Pin                                                                              |
| ---- | -------------------------------------------------------------------------------- |
| II   | mode absent + threshold exceeded ⇒ RESTART default (ADR-0375 backward compat)    |
| JJ   | mode = "RESTART" + threshold exceeded ⇒ identical to default (no `walTruncated`) |
| KK   | mode = "TRUNCATE" + threshold exceeded ⇒ `walRestarted=false`                    |
| LL   | mode = "TRUNCATE" + threshold NOT exceeded ⇒ both flags false                    |
| MM   | mode set + threshold ABSENT ⇒ mode ignored (PASSIVE only)                        |
| NN   | mutual exclusion: `walRestarted && walTruncated` always false                    |
| OO   | EMPTY_RESULT path ⇒ both flags false (full shape contract)                       |
| PP   | backward compat — ADR-0375 cases keep `walTruncated = false`                     |
| QQ   | TRUNCATE actually shrinks WAL — post-sweep walSize ≤ pre-sweep (best-effort)     |
| RR   | NO-THROW on unknown mode value ⇒ both flags false, sweep succeeds                |

All 18 pre-existing cases (1-8 + Y-DD + EE-HH) continue to pass —
byte-identical when `walCheckpointUpgradeMode` is absent.

## Non-goals

- **PASSIVE as an upgrade mode**: would be a no-op (the baseline
  already runs PASSIVE in step 3); not a meaningful selector.
- **FULL as an upgrade mode**: FULL has reader-safe semantics that
  RESTART/TRUNCATE do not — adding it would expand the mode enum
  beyond the two production-validated modes. Future ADR if data
  warrants.
- **Threshold auto-derivation**: no growth-rate observation to
  automatically pick a threshold or mode — operator-supplied only.
- ~~**Wiring from `startAutoSweep` / env-vars**~~ **(SATISFIED by
  ADR-0390, 2026-05-28)**: ADR-0390 added `walSizeThresholdBytes` +
  `walCheckpointUpgradeMode` to `AutoSweepConfig`, plus the env-var
  pair `QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES` +
  `QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE`. The production
  auto-sweep path now reaches this ADR's TRUNCATE branch.

## References

- ADR-0144 — `MetricsRegistry` shape
- ADR-0369 — auto-sweep (extends to thread this ADR's knobs via ADR-0390)
- ADR-0373 — auto-sweep telemetry baseline
- ADR-0375 — WAL size threshold + RESTART (the sibling this ADR extends)
- ADR-0378 — `wal_bytes` gauge (the observability surface operators
  use to tune the threshold this ADR's mode acts upon)
- ADR-0390 — auto-sweep WAL knob wire (closes the production-path gap
  identified in Non-goals above)
