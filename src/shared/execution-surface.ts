/**
 * `@/shared/execution-surface` — the SSOT for the EXECUTION-MODE surface taxonomy.
 *
 * jul-4 architecture audit (extensibility lens, F1): the execution-mode surface union was COPY-PASTED
 * in THREE places with identical membership — `SurfaceMirror` (@/stream), `Surface` (@/runner/knobs),
 * `Surface` (@/config/knob-schema). They were deliberately mirrored (each slice avoided importing the
 * others), but three independent literals silently DRIFT. Hoisting the canonical list to `@/shared`
 * (the lowest layer every slice already depends on) gives ONE source without adding cross-slice
 * coupling — each slice aliases this instead of re-declaring it, so adding a surface is a single edit.
 *
 * NB: this is the EXECUTION-MODE axis (how an agent run is driven), NOT the tool-access axis
 * (`ToolSurface` = cli/bench/web/ide/headless/terminal) nor the app-shell axis (`AppSurface`). Those
 * are genuinely different concepts; only these three were the same list duplicated.
 */

/** The canonical execution-mode surfaces. Adding one here propagates to every aliasing slice. */
export const EXECUTION_SURFACES = [
  "bench",
  "cli",
  "agent-batch",
  "agent-interactive",
  "ide",
] as const

/** The execution-mode surface union — derived from {@link EXECUTION_SURFACES} (never re-declared). */
export type ExecutionSurface = (typeof EXECUTION_SURFACES)[number]
