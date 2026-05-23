/**
 * Resume FSM — relocated to `@/runner/orchestrate/resume-fsm` (Layer-2
 * surface-agnostic slice). This file is now a thin re-export shim so the
 * existing CLI imports (`internal.ts` barrel, `repl.ts`, the unit tests
 * `cli-resume-heuristic.test.ts`) keep resolving the same symbols
 * byte-identically.
 *
 * Why mirror instead of move-then-delete:
 *   - `apps/cli/internal.ts` already re-exports `resolveResume` /
 *     `isPathLikeToken` / `defaultUntitled` for tests that import them
 *     from the CLI namespace. Removing this file would break those
 *     re-exports. The shim preserves the public surface while the
 *     implementation lives in the Layer-2 slice.
 *   - Surface code (`repl.ts`) can still continue importing from `./resume`;
 *     a Web/Tauri surface imports `@/runner` directly.
 */

export type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate"
export { defaultUntitled, isPathLikeToken, resolveResume } from "@/runner/orchestrate"
