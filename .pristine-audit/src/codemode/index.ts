/**
 * `@/codemode` — QuickJS-WASM code-cell sandbox (RFC jun-6-code-mode, Phase 1).
 *
 * A DUMB sandbox: it runs a model-authored JS program in an isolated WASM heap
 * and can reach the host ONLY via an injected {@link CodeCellDispatchPort}. The
 * security-critical binding that routes the port to the REAL `dispatchTool`
 * lives in `@/agent/codemode-wire.ts` — NOT here. This slice imports only
 * `node:*` / `quickjs-emscripten` / `@/shared` / `@/security` (RFC §5.1).
 */

export { wrapExecMain } from "./exec-main"
export { CODE_MODE_DEFAULTS, capOutput, redactAndCap } from "./limits"
export { isCellToolIdentifier, PHASE1_CELL_TOOLS, runCodeCell } from "./runtime"
export type {
  CellToolCallRecord,
  CodeCellDispatchPort,
  CodeCellLimits,
  CodeCellResult,
  CodeCellStatus,
  DispatchOutcome,
  RunCodeCellOptions,
} from "./types"
