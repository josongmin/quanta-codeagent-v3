# R02 integration delta — APPLIED (W3-I)

Status: **applied**.

## Trust persistence (`src/apps/agent/index.ts`)

`TrustPersistencePort.save` removed. `commit(mutations)` re-reads, merges dirty keys, `writeFileAtomic` under flock on `${trustFilePath}.lock`.

Host/CLI no-op adapters (`mcp-composition.ts`, `configured-endpoint-wire.ts`) expose `commit` only.

`tests/unit/central-config-comproot-wire-hellgate.test.ts` in-memory port uses `commit`.

## Sticky-model (shared `acquireLock`)

Flock semantics: leftover lock files are acquirable; release does not unlink. Hellgate rewritten. Error text no longer claims age reclaim.

## Web/CLI session-setup

Those roots do not own `TrustStore` files. Agent composition root is the persist adapter.
