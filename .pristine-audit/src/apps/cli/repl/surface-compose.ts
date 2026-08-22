// Stable public facade for the REPL surface composition cluster. Implementation
// lives under `surface-compose/` so consumers keep their historical import path.
export { composeSurfaceSlashCtx, composeSurfaceWires } from "./surface-compose/composer"
export { buildPromptUx, type PromptUxOpts } from "./surface-compose/prompt-ux"
export type { SurfaceState } from "./surface-compose/turn-sinks"
export { composeTurnSinks, createSurfaceState } from "./surface-compose/turn-sinks"
export type { ReplSurfaceWires } from "./surface-compose/types"
export {
  buildModelAdapterWire,
  buildRetryCandidates,
  extractApplyPatchPaths,
} from "./surface-compose/wire-builders"
