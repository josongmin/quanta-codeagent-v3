# ADR-0216: Stage1Store port (agent-side, no-throw, 4-verb surface)

- Status: Superseded (2026-07-19)
- Date: 2026-05-25
- Renumbered: from initially-drafted ADR-0207 (collision with the
  parallel-agent ADR `0207-stage1-outputs-persist.md` that landed a
  sibling slice at `src/memory/stage1-store/`). Per
  [[adr-collision-policy-2026-05-25]] we move to next-free 0216.
- Related: ADR-0068 (2-Phase memory consolidator — Phase 1 produces
  the rows persisted here), ADR-0131 (4-state memory outcome enum —
  optional `outcome` / `outcomeEvidence` fields), ADR-0207 (sibling
  port — usage/selection layer in `src/memory/stage1-store/`).

> **Superseded:** A production-composition audit found this agent-side V2
> wrapper had no runtime consumer and could not feed the canonical Phase 2
> contract without adding a duplicate cache. The V2 slice was removed. The
> live authority is the canonical `@/memory/consolidate` Phase 1 → Phase 2
> store path.

## Context

R1 verify reported the ADR-0131 stage1 path "fully wired" but the
SQL `INSERT` was only exercised by `tests/unit/memory-outcome.test.ts`.
Phase 1 (`runPhase1`) DID call `store.upsert(stage1)`, and the
session-end hook (`runMemoryConsolidatorHook`) DID call `runPhase1` —
so the path was wired in source. The R1 false positive was the
**host-injectability gap**: the agent layer had no factory for
`Stage1StorePort`, so a host that opted into the consolidator without
also constructing a SQLite handle would silently end up with
`store: undefined` → `kind:"skipped", reason:"store_missing"` and
nothing landed on disk.

The sibling ADR-0207 (`src/memory/stage1-store/`, landed by a
parallel agent) addresses the same root cause from the **memory
side** with a different shape (sync, JSONL-file-backed,
usage/selection-oriented). This ADR closes the **agent-side gap**
with a small, no-throw, in-memory-default port the agent's
composition root can default-construct.

## Decision

Introduce `Stage1StorePortV2` in `@/agent/memory/stage1-store/` — a
4-verb closed seam (`write` / `read` / `incrementUsageCount` /
`selectForPhase2`) with two adapters:

- **`inMemoryStage1Store()`** — zero-dep reference implementation.
  Used as the default when the host opts in but does NOT supply a
  SQLite handle, so the wire never silently no-ops.
- **`sqliteStage1Store(db)`** — wraps `@/memory#Stage1Store` (the
  canonical SQLite-backed class that owns the
  `ensureConsolidateSchema` migration). The wrapper converts the
  underlying class's throw-on-error surface into the
  `Stage1Result<T>` discriminated union so agent code never needs a
  try/catch per call.

### Invariants

- **NO-THROW public surface** — every method returns `Stage1Result<T>`.
  Constructor MAY throw (host bootstrap is the right place to fail
  loudly on a bad disk).
- **Upsert semantics** — `write(input)` REPLACES the prior row for
  that thread (mirrors the canonical `Stage1Store.upsert`). Including
  CLEARING a previously-set outcome when the new input omits it
  (test [10] enforces).
- **exactOptionalPropertyTypes** — `outcome` / `outcomeEvidence` keys
  are OMITTED when absent. Tests [9, 10] verify both round-trips.
- **`incrementUsageCount` is monotonic** — +1 per call; missing thread
  → `not-found` (not silently swallowed). Tests [6, 7] enforce.
- **`selectForPhase2` skips unknown ids** — returns only the records
  actually flipped (caller observes via length comparison). Test [8]
  enforces.
- **Default-OFF parity** — importing the slice barrel opens zero
  files. The host wires an adapter at composition time.

### Why a sibling port, not a re-use of ADR-0207

ADR-0207 lives in `src/memory/stage1-store/` and exposes a SYNC API
(get/put/touch/markSelectedForPhase2/list/prune) backed by JSONL with
a different threadId convention. Our agent slice needs an ASYNC,
`Stage1Result`-typed surface so the agent's `loop.ts` finally-block
can drop a `await store.write(...)` without restructuring the
existing no-throw `runMemoryConsolidatorHook` contract. The two ports
are intentionally distinct: ADR-0207 is the usage/selection layer;
this ADR is the persist seam. They MAY share a SQLite backend in a
later iteration; today they don't.

## Consequences

Positive:
- Closes the R1 false-positive: a host opting into the consolidator
  with `enabled: true` can call `inMemoryStage1Store()` (zero deps)
  and immediately see persistence.
- The `sqliteStage1Store` adapter wraps the canonical schema owner,
  so the on-disk layout stays SSOT in
  `src/memory/consolidate/schema.ts`.
- No-throw semantics propagate cleanly through the agent slice (no
  new try/catch in `loop.ts`).

Trade-offs:
- We have TWO stage1 store ports now (ADR-0207 + this one). Operator
  cost is mild — they target different consumers. Future
  consolidation possible but not required.

Negative invariants (NOT violating):
- `Stage1Store` (canonical SQLite class in `@/memory/consolidate`) is
  UNCHANGED. We wrap it; we don't re-implement it.
- Phase 1 / Phase 2 / `runMemoryConsolidatorHook` / `MemoryConsolidatorBlock`
  shapes are UNCHANGED. The host can wire the new port via the existing
  block's `store?: Stage1StorePort` slot using a thin adapter (the canonical
  port is satisfied by the SQLite class directly; this slice's port is the
  agent-side default-OFF factory).

## Validation

- 13 hellgate cases in `tests/unit/stage1-store-hellgate.test.ts`
  covering: write/read round-trip, sqlite parity, upsert replacement,
  invalid-input / not-found arms, monotonic increment,
  selectForPhase2 marking + skip-unknown, exactOptional omission,
  schema-migration idempotency.
- All 13 pass; tsc 0 / biome 0 in the new slice.
