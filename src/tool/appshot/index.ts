/**
 * `appshot` slice barrel (G1 — appgen/appshot verify loop, RFC jun-6, Phase 1).
 *
 * The CLOSED generation→verification cycle: spec → scaffold → render →
 * screenshot → LLM-judge → iterate (bounded). Composes the existing `browser_*`
 * + jailed-write + artifact-store ends into a feedback loop, all effects
 * injected via {@link AppshotPort}. Default-OFF: the composition root registers
 * `appshot_verify` only when `DefaultToolPorts.appshot` is wired (gated behind
 * `QUANTA_APPSHOT`).
 */

export {
  APPSHOT_MAX_ITER,
  APPSHOT_MAX_SCREENSHOT_BYTES,
  APPSHOT_MIN_ITER,
  type AppshotIteration,
  type AppshotLoopDeps,
  type AppshotOutcomeKind,
  type AppshotRequest,
  type AppshotResult,
  type AppshotStepError,
  clampIter,
  runAppshotLoop,
} from "./loop"
export type {
  AppSpec,
  AppshotArtifactSink,
  AppshotPort,
  ScaffoldResult,
  VerifyVerdict,
} from "./port"
export {
  makeJailedScaffold,
  renderScaffoldHtml,
  type ScaffoldWritePort,
} from "./scaffold"
export {
  type AppshotToolOptions,
  type AppshotVerifyInput,
  appshotVerifyInputSchema,
  appshotVerifyTool,
} from "./tool"
