/**
 * Id-addressable session persistence — V2 schema.
 *
 * V1 (path-based) lives in `src/agent/state.ts` and is NOT touched. This slice
 * is a NEW rail next to it: callers mint an opaque id and we keep the file at
 * `<sessionsRoot>/<id>.json` (or `<sessionsRoot>/archived/<id>.json` when
 * archived) plus a single `index.jsonl` for cheap listing. Inspired by the
 * Codex CLI's session UX.
 *
 * Schema bump: `SESSION_VERSION = 2` so a future reader can tell V1 / V2 apart
 * (their on-disk shapes differ — V2 has a `meta` envelope; V1 has flat fields).
 */
export const SESSION_VERSION = 2;
