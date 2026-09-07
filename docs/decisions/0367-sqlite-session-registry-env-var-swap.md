# ADR-0367 — SQLite session-registry env-var swap

**Status:** Accepted (2026-05-28)
**Sibling to:** ADR-0351 (disk JSONL env-var swap), ADR-0361 (SQLite backend)
**Slice:** `agent/session-resource-registry/global.ts`
**Default-OFF:** YES — env var unset ⇒ legacy in-memory path byte-identical to ADR-0345.

## Context

ADR-0345 shipped `SessionResourceRegistry` as a process-level singleton
backed by an in-memory `Map<sessionId, SessionResources>`. ADR-0351
added an opt-in env-var swap (`QUANTA_SESSION_REGISTRY_DISK_DIR`) that
mints the JSONL disk adapter (ADR-0348) on first call when the env var
is set.

ADR-0361 then shipped a **SQLite** sibling adapter
(`createSqliteSessionResourceRegistry`) targeting Codex `logs_2.sqlite`
parity (WAL + sliding-window GC + `PRAGMA wal_checkpoint(PASSIVE)`).
The barrel re-exports the factory, but the global singleton in
`global.ts` does NOT auto-mount it — composition roots had to opt in
by passing a custom registry through the host wire path, which is
verbose enough that no production caller actually does it.

The remaining gap: an **env-var swap on the ADR-0351 pattern** for the
SQLite adapter, so operators can promote the singleton backend with a
single env var:

```bash
QUANTA_SESSION_REGISTRY_SQLITE_PATH=/var/lib/quanta/sessions.sqlite quanta
```

## Decision

Add a `QUANTA_SESSION_REGISTRY_SQLITE_PATH` env var with **priority
above the existing disk env var**:

```text
priority order (first non-empty wins, with NO-THROW fallback chain):
  1. QUANTA_SESSION_REGISTRY_SQLITE_PATH  ⇒ sqlite (ADR-0361)
  2. QUANTA_SESSION_REGISTRY_DISK_DIR     ⇒ disk JSONL (ADR-0348)
  3. (neither set)                        ⇒ in-memory (ADR-0345)
```

When the SQLite env var is set to a non-empty string, the first call
to `getGlobalSessionResourceRegistry()` mints
`createSqliteSessionResourceRegistry({ databasePath })` and reuses
that instance per the existing lazy-init contract.

### Why SQLite first

SQLite is more durable than the JSONL disk adapter (WAL + atomic
multi-statement transactions + Codex production calibration:
~10-day / ~14 GB steady-state). When an operator deliberately sets
BOTH env vars (likely during a migration), promoting SQLite is the
safer default than silently demoting to JSONL.

### NO-THROW fallback chain

The SQLite adapter's constructor MAY throw on first-open (unreadable
file, parent dir missing — the adapter does NOT mkdir, per
ADR-0361 `SqliteRegistryConfig.databasePath` doc). When it throws,
the wrapper falls through to the JSONL env-var (if set) and, on its
failure, to in-memory. A misconfigured env var MUST NOT abort process
startup.

```typescript
const buildDefaultRegistry = (cfg: RuntimeConfig): SessionResourceRegistry => {
  const sqlitePath = cfg.sessionRegistrySqlitePath
  if (sqlitePath !== undefined && sqlitePath.length > 0) {
    try { return createSqliteSessionResourceRegistry({ databasePath: sqlitePath }) }
    catch { /* fall through to disk */ }
  }
  const diskDir = cfg.sessionRegistryDiskDir
  if (diskDir !== undefined && diskDir.length > 0) {
    try { return createDiskSessionResourceRegistry({ storageDir: diskDir }) }
    catch { /* fall through to in-memory */ }
  }
  return createInMemorySessionResourceRegistry()
}
```

### Read EXACTLY ONCE per process

Both values come from one `runtimeConfig()` snapshot at the FIRST call to
`getGlobalSessionResourceRegistry()` (lazy-init). Subsequent config
mutations are ignored — the singleton is already minted. The
test-only `resetGlobalSessionResourceRegistry()` knob drops the
singleton so a fresh snapshot is built on the next call (hellgate L
verifies this for the SQLite var).

## Consequences

### Positive

- One-line operator promotion of the durable backend.
- Byte-identical to ADR-0345 when both env vars unset (default-OFF
  invariant preserved).
- Fallback chain composes: a hosed SQLite path with a valid disk path
  yields the disk adapter, not a process crash (hellgate K).
- Identical contract surface — no new TypeScript types, no new wire
  hooks. `global.ts` mutation is purely additive.

### Negative

- The SQLite adapter MUST be importable at module-load time. Removing
  the SQLite sibling slice would break `global.ts` even when the env
  var is unset (because the import is unconditional). Mitigation: the
  sqlite-adapter barrel is already re-exported from
  `src/agent/session-resource-registry/index.ts`, so the import cost
  is already paid by any consumer.
- Operators who set the env var BUT have not provisioned the parent
  directory get silent fallback to disk / memory. The trade-off
  (vs. throw + abort) is intentional — startup robustness wins. A
  follow-up could add a structured warning emit, but that crosses
  slice fences (would require `metricsEmitter` on `global.ts`, see
  ADR-0368 architectural mismatch).

## Hellgate

`tests/unit/session-registry-env-swap-hellgate.test.ts` — appended 6
SQLite cases (G-L) to the existing 6 disk cases (A-F):

- **G.** sqlite env set ⇒ sqlite backend minted; same-id reuse +
  size invariants.
- **H.** sqlite env empty string ⇒ in-memory fallback (treated as
  absent).
- **I.** sqlite + disk BOTH set ⇒ sqlite wins; SQLite file is
  created and per-session disk subdir is NOT.
- **J.** NO-THROW on hosed sqlite env var (unreachable parent dir);
  registry stays functional via fallback chain.
- **K.** hosed sqlite + valid disk ⇒ disk fallback consulted; same-id
  reuse preserved.
- **L.** sqlite env read EXACTLY ONCE; runtime mutation after first
  call ignored (singleton invariant).

## Slice fence

- **Mutates:** `src/agent/session-resource-registry/global.ts` (one
  function: `buildDefaultRegistry`).
- **Tests:** `tests/unit/session-registry-env-swap-hellgate.test.ts`
  (append 6 cases; existing 6 unchanged).
- **Does NOT mutate:** sqlite-store.ts, disk-store.ts,
  in-memory-registry.ts, types.ts, the barrel re-exports, composition
  roots (`assemble.ts`, prompt.ts, loop.ts).
- **Reuses:** ADR-0361's `createSqliteSessionResourceRegistry` factory
  unchanged. ADR-0351's disk env-var swap path is preserved
  byte-identical when SQLite env is unset.

## Related

- ADR-0345 — `SessionResourceRegistry` closed port + in-memory default
- ADR-0347 — Process-level singleton + lazy-init contract
- ADR-0348 — Disk JSONL sibling adapter
- ADR-0351 — Disk env-var swap (this ADR is the SQLite peer)
- ADR-0361 — SQLite backend (this ADR opts the global singleton in)
- ADR-0368 — Flock telemetry composition wire (defer — architectural
  mismatch with global lazy-init singleton)
