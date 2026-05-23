/**
 * Re-export shim — the surface-agnostic implementation now lives in
 * `@/runner/assemble/config.ts` so a future Web/Tauri surface can depend on
 * the same per-turn `AgentConfig` assembly without coupling to `apps/cli/**`.
 *
 * Keeping this file as a pure re-export preserves the prior import paths
 * (`./config-assemble` from `internal.ts`, `repl.ts`, tests) byte-identically
 * — the implementation is byte-identical too (relocated verbatim).
 */

export type { Tooling } from "@/runner/assemble"
export { assembleConfig, compactionDep, type SessionDeps } from "@/runner/assemble"
