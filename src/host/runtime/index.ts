// ADR-0303 thin-surface relocation — the env-READING "argv → AgentConfig base"
// composition builder + the pure argv parser now live in this host layer (moved
// DOWN out of `apps/agent`) so any surface — incl. `apps/cli`'s `batch`
// subcommand — reaches them via `@/host/runtime` rather than sideways into a
// sibling surface.
export type { AssembleRequestPartial } from "./agent-arg-builder"
export {
  assembleMemoryAuto,
  buildBaseFromArgs,
  buildProfileDefinitionRegistry,
  installCommandHooksIntoBase,
  PERMISSION_PROFILE_SESSION_THREAD,
  ProviderKeyMissingError,
  pickMcpNegotiator,
  resolveLayeredProfileSlots,
  resolveLocalEnvSelection,
  resolveObservabilityWire,
  resolvePermissionModeFromProfile,
  resolvePermissionProfileManager,
  resolvePolicyMergeStrategy,
  toAssembleRequest,
} from "./agent-arg-builder"
export {
  type AgentArgs,
  AgentArgsError,
  formatHelp,
  type IdentityModeToken,
  type OutputFormatToken,
  type PermissionProfileToken,
  type ProviderToken,
  parseAgentArgs,
  type ToolProfileToken,
} from "./agent-args"
export {
  type AssembleRequest,
  type AssembleRequestSeams,
  type AssemblerEnv,
  assembleAgentConfig,
  type BatchExtras,
  buildInteractiveTurnAssembler,
  type CiBotExtras,
  type HeadlessExtras,
  type InteractiveTurnAssemblerRequest,
  type RunOutcome,
  resolveRunAgent,
} from "./agent-config-assembler"
export { createSingleSessionRuntimeHost } from "./builder"
export {
  assertCapabilityExpectation,
  buildCapabilityManifest,
  deriveCapabilityManifest,
} from "./capabilities"
export {
  bunKeyringExec,
  composeTokenStore,
  createLibsecretKeyring,
  createMacosKeyring,
  createNullKeyring,
  DEFAULT_KEYRING_SERVICE,
  type KeyringExec,
  type KeyringExecInput,
  type KeyringExecResult,
  type KeyringPlatform,
  type KeyringPort,
  parseRecord as parseKeyringTokenRecord,
  selectKeyring,
  serializeRecord as serializeKeyringTokenRecord,
} from "./keyring"
export {
  buildMcpOAuthWiring,
  type ConnectorsMcpOAuthConfig,
  createConnectorsMcpOAuthProvider,
  type McpBrowserFlowResult,
  type McpOAuthDeps,
  type McpOAuthKeyringOption,
  type McpOAuthWiring,
  type RunMcpBrowserFlow,
  resolveMcpOAuthKeyringOption,
} from "./mcp-oauth-provider"
export {
  buildRootsWiring,
  type RootsWiring,
  workspaceRootsProvider,
} from "./mcp-roots-provider"
export {
  buildSamplingWiring,
  createLlmSamplingHandler,
  type SamplingHandlerDeps,
  type SamplingWiring,
} from "./mcp-sampling-handler"
export type { OperatorReviewAdapter } from "./operator-review"
export { createInMemorySessionPersistence } from "./persistence"
export { hasExecutableTools } from "./tool-executor"
export type { CreateRuntimeOptions, RuntimeHost, RuntimeSessionConfig } from "./types"
