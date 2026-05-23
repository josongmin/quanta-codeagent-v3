/**
 * Agent outcome surface — what `runAgent` returns at session end. Extracted
 * from `src/agent/types.ts` (cohesion split) so the outcome shape can be
 * imported without pulling in `AgentConfig`'s full dependency graph
 * (LLM/permission/memory/stream/...).
 *
 * Byte-identical: every name re-exports verbatim through `./types`, so the
 * 132 consumer files that import `from "./types"` (or `"@/agent/types"`) are
 * unchanged.
 */
export {};
