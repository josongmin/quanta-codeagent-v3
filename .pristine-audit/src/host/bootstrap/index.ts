/**
 * `@/host/bootstrap` — surface-agnostic session bootstrap (ADR-0299).
 *
 * SSOT for `bootstrapSession`. Imported by every surface entry (CLI today,
 * Web/Tauri/headless next) so the per-session orchestration stays in one place.
 * The surface supplies a {@link SessionBootstrapDeps} bundle of closures; the
 * bootstrap consumes plain data + the closure callbacks and returns a typed
 * {@link SessionBootstrapResult}.
 *
 * Slice invariant: `src/host/bootstrap/**` MUST NOT import from `src/apps/**`.
 * Enforced by biome `noRestrictedImports` (see `biome.json` override).
 */

export { bootstrapSession } from "./bootstrap-session"
export type {
  BootstrapBranchProgress,
  BootstrapCostPanel,
  BootstrapFeatures,
  BootstrapIdleMonitor,
  BootstrapLifecyclePills,
  BootstrapMcpClient,
  BootstrapMcpPillServer,
  BootstrapMcpServerConfig,
  BootstrapMcpSurface,
  BootstrapRejectCounter,
  BuildIdleGuardsFactory,
  BuildLlmFactory,
  BuildMcpSurfaceInfoFactory,
  BuildStreamingFactory,
  BuildToolingFactory,
  ComposeShellEventFactory,
  CreateGuardianReviewFactory,
  LoadFeaturesFactory,
  LoadImageBlockFactory,
  MaterializeReviewerAgentFactory,
  PickIdentityFactory,
  PickPersonaFactory,
  ResolveResumeFactory,
  SessionBootstrapDeps,
  SessionBootstrapFailureKind,
  SessionBootstrapResult,
  SessionRuntimeConfigShape,
  SwitchToSessionCwdFactory,
} from "./types"
export {
  isSessionBootstrapError,
  SessionBootstrapError,
} from "./types"
