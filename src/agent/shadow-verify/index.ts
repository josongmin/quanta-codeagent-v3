/**
 * ADR-0396 — Shadow Verify slice barrel (public entry-point).
 *
 * Wave 1: the closed port contract + the dependency-injected runner. The
 * scratch / applier / checker ports are satisfied by fakes in tests; Wave 2
 * supplies real worktree + V4A applier + LSP-diagnostics adapters and wires
 * the verifier into the loop / as an LLM tool.
 */

export { createShadowVerify } from "./runner"
export type {
  ShadowApplyPort,
  ShadowCheck,
  ShadowCheckPort,
  ShadowDiagnostic,
  ShadowScratchPort,
  ShadowVerifyDeps,
  ShadowVerifyPort,
  ShadowVerifyRequest,
  ShadowVerifyResult,
} from "./types"
