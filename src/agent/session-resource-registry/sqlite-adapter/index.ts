/**
 * ADR-0361 — `src/agent/session-resource-registry/sqlite-adapter/`
 * barrel.
 *
 * Sibling slice to `../disk-adapter/` (ADR-0348). Implements the
 * same `SessionResourceRegistry` closed port (ADR-0345) on top of
 * `bun:sqlite` with WAL + Codex `logs_2.sqlite` parity.
 *
 * Default-OFF: the parent barrel (`../index.ts`) re-exports the factory +
 * helper types. The process singleton mounts this backend only when its frozen
 * runtime-config snapshot contains a non-empty SQLite path.
 */

export type { SweepResult } from "./gc"
export { sweepSqliteRegistry } from "./gc"
export { createSqliteSessionResourceRegistry } from "./sqlite-store"
export type { SqliteRegistryConfig } from "./types"
export { DEFAULT_MAX_TOTAL_BYTES, DEFAULT_TTL_MS } from "./types"
