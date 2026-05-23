/**
 * External-agent import: shared types (ADR-0038, Cluster D Feature 4).
 *
 * Mirrors Codex's 4-stage lifecycle for importing sessions/skills from
 * other coding-agent tools. Each stage emits exactly one terminal event
 * (success XOR failure); the failure of any stage halts the lifecycle and
 * emits `import_finished` with `{ ok: false, error }`.
 */
/** All known providers as a readonly array — used by `detector.ts` to
 *  iterate and by the test suite to assert no `unknown` slips through. */
export const ALL_PROVIDERS = Object.freeze([
    "claude_code",
    "cursor",
    "aider",
    "unknown",
]);
