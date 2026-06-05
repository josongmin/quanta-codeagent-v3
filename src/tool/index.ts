import type { OsSandboxProfile } from "@/runtime"
import type { AutomationEnginePort } from "@/scheduler/automation-engine"
import type { FileSystemPort } from "@/storage"
import { applyPatchTool } from "./apply-patch"
import { makeApplyPatchStructuredTool } from "./apply-patch-structured-tool"
import { type ArtifactRegistryPort, artifactTools } from "./artifact"
import { automationUpdateTool } from "./automation_update"
import { makeBashTool } from "./bash"
import { bashAwaitTool } from "./bash/await"
import { bashKillTool } from "./bash/kill"
import { createCommunicateUpdateTool } from "./communicate-update"
import { coverageCheckTool } from "./coverage_check"
import { type DiagnosticsProvider, diagnosticsTool, nullDiagnosticsProvider } from "./diagnostics"
// ADR-0142: register document/structured-data read tools into the default
// fence (the 5 tools were barrel-exported but not in `buildDefaultTools` —
// the missing leg is the MUTATING_TOOL_TABLE classification, added in the
// same change). All five are read-only + concurrency-safe.
import {
  csvReadTool,
  docxReadTool,
  ndjsonReadTool,
  pdfReadTool,
  pptxReadTool,
  xlsxReadTool,
  yamlReadTool,
} from "./document"
// H14b — Office document AUTHORING tools (generate real .xlsx / .docx / .pptx).
// Pure-TS STORED-ZIP + OOXML; conditionally registered via DefaultToolPorts.officeAuthoring.
import { makeDocxWriteTool, makePptxWriteTool, makeXlsxWriteTool } from "./document/authoring"
import { editTool, makeEditTool } from "./edit"
import { fileTreeSummaryTool } from "./file-tree-summary"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readImageTool, readImageUrlTool } from "./image"
import { type ImageGenPort, imageGenTool } from "./image-gen"
import { localizeTool } from "./localize"
import { mcpResourcesTools, type ResourcesHandle } from "./mcp_resources"
import { type McpConnectorDiscoveryPort, mcpConnectorTools } from "./mcp-connector"
import { parseTestFailureTool } from "./parse-test-failure"
import { type PtySessionPort, ptyTools } from "./pty"
import { makeReadTool, readTool } from "./read"
import { scriptedReplaceTool } from "./scripted-replace"
import { sessionConfigTool } from "./session_config"
import { testRunnerTool } from "./test-runner"
import type { Tool } from "./types"
import { webFetchTool } from "./web"
import { makeWriteTool, writeTool } from "./write"

export { applyPatchTool, FsJailViolationError } from "./apply-patch"
export { makeApplyPatchStructuredTool } from "./apply-patch-structured-tool"
// C1 — artifact (Canvas) read/manage tools. Caller-wired via
// `DefaultToolPorts.artifactRegistry` (default-OFF; the host passes a session
// registry when `QUANTA_ARTIFACT_STORE` is on). The duck-typed port keeps
// `@/tool` fence-clean (no `@/artifact` import).
export {
  type ArtifactDestroyInput,
  type ArtifactGetInput,
  type ArtifactListInput,
  type ArtifactRegisterInput,
  type ArtifactRegistryPort,
  type ArtifactSpecInput,
  type ArtifactView,
  artifactDestroyInputSchema,
  artifactGetInputSchema,
  artifactListInputSchema,
  artifactRegisterInputSchema,
  artifactTools,
} from "./artifact"
// ADR-0296 — async-shell sibling tools to `bash` (timeout_behavior=background).
export {
  type BashAwaitInput,
  bashAwaitInputSchema,
  bashAwaitTool,
  makeBashAwaitTool,
} from "./bash/await"
export {
  type BashKillInput,
  bashKillInputSchema,
  bashKillTool,
  makeBashKillTool,
} from "./bash/kill"
// C2 (jun-4-communicate-update.md) — structured mid-turn progress-report tool.
// Caller-wired + default-OFF: registered only when `DefaultToolPorts.progressUpdate`
// is true (the composition root passes it when `QUANTA_PROGRESS_UPDATE === "1"`).
// Read-only — emits a render-only `progress_update` event via `ctx.progressSink`.
export {
  type CommunicateUpdateInput,
  communicateUpdateInputSchema,
  createCommunicateUpdateTool,
} from "./communicate-update"
// `coverage_check` tool (ADR-0165). Caller-wired via `DefaultToolPorts.coverageCheck`
// (default-OFF; the CLI passes it when `QUANTA_COVERAGE_TOOL === "1"`). Read-only +
// concurrency-safe — reports per-file/total V8 coverage and optionally gates a threshold.
export {
  type CoverageCheckInput,
  coverageCheckInputSchema,
  coverageCheckTool,
} from "./coverage_check"
export { DeferredResultRegistry, UnknownDeferredHandleError } from "./deferred"
export {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  formatDiagnostics,
  nullDiagnosticsProvider,
} from "./diagnostics"
// Office document AUTHORING cluster (H14b) — generate real `.xlsx` / `.docx`
// files via pure-TS STORED-ZIP + OOXML (NO office dependency). A NEW category
// alongside `image_gen`. Caller-wired + default-OFF: `xlsx_write` + `docx_write`
// are registered only when `DefaultToolPorts.officeAuthoring` is true (the
// composition root passes it when `QUANTA_OFFICE_AUTHORING` is on). PPTX is a
// scoped follow-up — the STORED-ZIP + OOXML core here is its shared substrate.
export {
  buildDocx,
  buildPptx,
  buildStoredZip,
  buildXlsx,
  crc32,
  type DocxSpec,
  type DocxWriteInput,
  type DocxWriteToolOptions,
  docxWriteInputSchema,
  docxWriteTool,
  makeDocxWriteTool,
  makePptxWriteTool,
  makeXlsxWriteTool,
  OOXML_MEDIA_TYPES,
  type PptxSpec,
  type PptxWriteInput,
  type PptxWriteToolOptions,
  parseStoredZip,
  pptxWriteInputSchema,
  pptxWriteTool,
  type XlsxSpec,
  type XlsxWriteInput,
  type XlsxWriteToolOptions,
  xlsxWriteInputSchema,
  xlsxWriteTool,
} from "./document/authoring"
export type { DefineToolSpec, StreamingInputStep } from "./factory"
export {
  defineTool,
  driveStreamingInput,
  enforceOutputSchema,
  renderModelOutput,
  validateToolOutput,
} from "./factory"
export { fileTreeSummaryTool, inferNextAction } from "./file-tree-summary"
export type { GhRunner } from "./gh"
export { defaultGhRunner, ghTools } from "./gh"
export type {
  GitBlameInput,
  GitBranchSwitchInput,
  GitCommitInput,
  GitDiffInput,
  GitLogInput,
  GitRunner,
  GitRunResult,
  GitStatusInput,
  GitUpstreamCheckInput,
} from "./git"
export {
  defaultGitRunner,
  gitBlameHeatmapTool,
  gitBlameTool,
  gitBranchSwitchTool,
  gitChurnTool,
  gitCommitTool,
  gitConflictInspectTool,
  gitDiffTool,
  gitLogTool,
  gitMovedCodeTool,
  gitStatusTool,
  gitTools,
  gitUpstreamCheckTool,
  rankBlame,
  rankChurn,
} from "./git"
// `read_image` cluster (ADR-0126): tool + composer helper + magic-byte sniffer.
// The composer is caller-wired (dispatch.ts is NOT modified by this slice) —
// when the helper is plumbed, `ToolResult.images` flows into the model's
// tool_result content; absent ⇒ legacy string shape (byte-identical).
export {
  composeToolResultContent,
  MAX_IMAGE_BYTES as READ_IMAGE_MAX_BYTES,
  type ReadImageInput,
  type ReadImageUrlInput,
  readImageInputSchema,
  readImageTool,
  readImageUrlInputSchema,
  readImageUrlTool,
  SUPPORTED_MEDIA_TYPES as READ_IMAGE_SUPPORTED_MEDIA_TYPES,
  type SupportedMediaType as ReadImageSupportedMediaType,
  sniffMediaType,
  type ToolResultContent,
} from "./image"
// `image_gen` cluster (H14a) — text→image generation + edit. The FIRST
// binary-artifact-GENERATION tool (a NEW category; `read_image*` is read-only).
// Caller-wired + default-OFF: registered only when `DefaultToolPorts.imageGen`
// is set (the composition root passes a key-bound provider port when
// `QUANTA_IMAGE_GEN` is on). NOT part of `defaultTools` — mirrors the
// `coverage_check` / `web_search` caller-wired pattern.
export {
  defaultImageWritePort,
  type GeneratedImage,
  IMAGE_GEN_MAX_BYTES,
  IMAGE_GEN_MAX_N,
  type ImageGenFormat,
  type ImageGenInput,
  type ImageGenOutcome,
  type ImageGenPort,
  type ImageGenRequest,
  type ImageGenToolOptions,
  type ImageWritePort,
  imageGenInputSchema,
  imageGenTool,
  openAiImagePort,
} from "./image-gen"
export type {
  LspNavProvider,
  LspNavSession,
  NavHover,
  NavLocation,
  NavPos,
  NavRange,
  NavRenamePreview,
  NavSymbolInfo,
  NavSymbolKind,
  RenameApplyPort,
  RenameApplyPortDocumentEdit,
  RenameApplyPortPos,
  RenameApplyPortRange,
  RenameApplyPortTextEdit,
  RenameApplyPortWorkspaceEdit,
} from "./lsp_nav"
export {
  lspNavTools,
  lspRenameApplyTool,
  nullLspNavProvider,
} from "./lsp_nav"
// N3 — MCP resource/prompt tools (`mcp_list_resources` / `mcp_read_resource` /
// `mcp_list_prompts` / `mcp_get_prompt`). Caller-wired + default-OFF: registered
// only when `DefaultToolPorts.mcpResources` is wired (the duck-typed
// `ResourcesHandle` keeps `@/tool` fence-clean; the host adapts a live McpClient
// over the H19-landed `resources/*` + `prompts/*` methods). Output is mcp-origin
// ⇒ the H2 untrusted-source envelope wraps it at dispatch.
export {
  type GetPromptInput,
  getPromptInputSchema,
  type HandleResult as ResourcesHandleResult,
  type ListPromptsInput,
  type ListResourcesInput,
  listPromptsInputSchema,
  listResourcesInputSchema,
  mcpGetPromptTool,
  mcpListPromptsTool,
  mcpListResourcesTool,
  mcpReadResourceTool,
  mcpResourcesTools,
  type PromptEntry,
  type PromptMessage,
  type PromptResult,
  type ReadResourceInput,
  type ResourceBlock,
  type ResourceEntry,
  type ResourcesFailureReason,
  type ResourcesHandle,
  readResourceInputSchema,
} from "./mcp_resources"
// MCP tasks tools (ADR-0196). Caller-wired: registered only when the apps
// layer wires a `TasksHandle`; not part of `defaultTools`. Mirrors the
// `shadow*` / `branch_search` pattern — default-OFF + byte-identical.
export {
  type CancelTaskInput,
  cancelMcpTaskTool,
  cancelTaskInputSchema,
  type GetTaskInput,
  getMcpTaskTool,
  getTaskInputSchema,
  type ListTasksInput,
  listMcpTasksTool,
  listTasksInputSchema,
  mcpTasksTools,
  type TasksCancelResult,
  type TasksHandle,
  type TasksListOutcome,
  type TasksListPage,
  type TasksTaskInfo,
  type TasksTaskResult,
  type TasksTaskState,
} from "./mcp_tasks"
// N2 — MCP connector discovery tools. Caller-wired via
// `DefaultToolPorts.mcpConnectors` (default-OFF; `QUANTA_MCP_CONNECTORS`). The
// duck-typed `McpConnectorDiscoveryPort` keeps `@/tool` fence-clean.
export {
  type McpConnectorDiscoveryPort,
  type McpConnectorEntryView,
  type McpConnectorInstallInput,
  type McpConnectorListInput,
  type McpInstallOutcome,
  mcpConnectorInstallInputSchema,
  mcpConnectorListInputSchema,
  mcpConnectorTools,
} from "./mcp-connector"
// ADR-0471 Substrate-B — tool-origin provenance substrate. The closed origin
// enum + pure `deriveProvenance` (call-site truth, NOT name-guessing). The
// `Provenance` union is string-identical to `@/agent/untrusted-envelope`'s
// `UntrustedSource`; dispatch #2 maps it with the identity (keeps @/tool a leaf).
export {
  deriveProvenance,
  type Provenance,
  TOOL_ORIGINS,
  type ToolOrigin,
} from "./origin"
export {
  classifyFrame,
  type FailureFrame,
  type FrameTier,
  parseTestFailure,
  parseTestFailureTool,
} from "./parse-test-failure"
export {
  buildPlanTools,
  createPlanTool,
  currentPlanTool,
  removeTodosTool,
  updatePlanTool,
  updateTodosTool,
} from "./plan"
export { planErrorMessage, planFailure } from "./plan/error-mapping"
// `poll_deferred` tool (ADR-0287). Caller-wired: the composition root builds it
// over a `DefaultDeferredResultRegistry` ONLY when `runtimeConfig().asyncTools`
// is true (default-OFF). NOT part of `defaultTools` — same pattern as
// `mcp_tasks_*` / `shadow_*` / `subagent_*_bg`. The factory + input schema/type
// are re-exported so a composition root can opt in with one line.
export {
  type PollDeferredInput,
  pollDeferredInputSchema,
  pollDeferredTool,
} from "./poll_deferred"
export { ToolRegistry } from "./registry"
export { requestPlanExitTool } from "./request-plan-exit"
export { requestUserInputTool } from "./request-user-input"
// `search_codebase` tool (ADR-0278). Caller-wired: surfaces register the tool
// when they own a concrete workspace search pipeline. The product surface now
// defaults to lexical repo search and upgrades to hybrid when `QUANTA_INDEX=on`,
// but the tool still stays OUT of `defaultTools()` because the wiring depends
// on cwd + optional indexer lifecycle.
export {
  type SearchCodebaseInput,
  searchCodebaseInputSchema,
  searchCodebaseTool,
} from "./search-codebase"
// `session_config` tool — agent's self-inspection / self-mutation seam.
// Registered unconditionally in `buildDefaultTools` (returns a typed
// `not_wired` failure when the composition root has not bound the seam).
export {
  SESSION_CONFIG_EFFORT_LEVELS,
  type SessionConfigEffortLevel,
  type SessionConfigInput,
  sessionConfigInputSchema,
  sessionConfigTool,
} from "./session_config"
// Shadow-store tools (ADR-0119 + ADR-0122). Built only when the assembly seam
// wires `AgentConfig.shadowOdb`; NOT part of `defaultTools` — see tier1/shadow.ts.
export type {
  ShadowRestorePartialInput,
  ShadowRewindInput,
  ShadowSnapshotsInput,
} from "./shadow"
export {
  shadowRestorePartialInputSchema,
  shadowRestorePartialTool,
  shadowRewindInputSchema,
  shadowRewindTool,
  shadowSnapshotsInputSchema,
  shadowSnapshotsTool,
  shadowTools,
} from "./shadow"
export { composeShellObservers, noopShellObserver } from "./shell-exec-observers"
export type { ShellExecEvent, ShellExecObserver } from "./shell-exec-types"
// N1 — background side-agent management tools. Caller-wired via tier1
// `buildSideAgentBlock` on `AgentConfig.sideAgentDaemons` (default-OFF;
// `QUANTA_SIDE_AGENT`). Duck-typed `SideAgentDaemonPort` keeps `@/tool`
// fence-clean (no `@/side-agent` import).
export {
  type SideAgentDaemonPort,
  type SideAgentFindingsInput,
  type SideAgentListInput,
  type SideAgentSnapshotView,
  type SideAgentSpawnInput,
  type SideAgentStopInput,
  sideAgentFindingsInputSchema,
  sideAgentListInputSchema,
  sideAgentSpawnInputSchema,
  sideAgentStopInputSchema,
  sideAgentTools,
} from "./side-agent"
// Background subagent tools (ADR-0130). Caller-wire: registered only when
// `AgentConfig.subagentBackground` is set; not part of `defaultTools`. The
// `subagentBgTools(scheduler)` factory + per-tool exports + duck-typed port
// are re-exported here so composition roots can wire without reaching into
// the slice directory.
export type {
  BackgroundSubagentSchedulerPort,
  SubagentAwaitInput,
  SubagentBgHandleId,
  SubagentBgResult,
  SubagentBgSpec,
  SubagentBgStatus,
  SubagentForkInput,
  SubagentPollInput,
} from "./subagent-bg"
export {
  subagentAwaitInputSchema,
  subagentAwaitTool,
  subagentBgTools,
  subagentForkInputSchema,
  subagentForkTool,
  subagentPollInputSchema,
  subagentPollTool,
} from "./subagent-bg"
export type {
  BlockerSurface,
  DeferredHandle,
  DeferredToolResult,
  GitWriteGuard,
  HITLTier,
  NextAction,
  PlanDeltaKind,
  PlanExitRequester,
  PlanExitToolDecision,
  PlanExitToolOutcome,
  PlanMutationErrorCode,
  PlanMutationResult,
  PlanMutator,
  PlanMutatorNewTodo,
  PlanMutatorTodoPatch,
  PlanReadonlyView,
  ProgressSink,
  ProgressUpdateMirror,
  SandboxViolationReason,
  SessionConfigSeam,
  ShellSnapshotRestoreSeam,
  Tool,
  ToolContext,
  ToolDiffSink,
  ToolEvent,
  ToolFailure,
  ToolResult,
  ToolResultEvidence,
  ToolSpec,
  UserInputOutcome,
  UserInputRequester,
  WorkingStateHandle,
  WorkingStatePatch,
  WorkingStateSnapshot,
} from "./types"
export { createUpdateWorkingStateTool } from "./update-working-state"
// `web_*` cluster (ADR-0127): `web_fetch` (always-on, factory binds
// globalThis.fetch unless a fake fetcher is injected) + `web_search`
// (provider-gated — closed-port DI via AgentConfig.webSearch.provider; the
// builder lives in src/agent/tier1/web-search.ts). Neither is part of
// `defaultTools` today — see ADR-0127 §"Default-OFF" for the registration
// posture (mirrors `read_image` / `shadow*` caller-wired pattern).
export {
  htmlToMarkdown,
  WEB_FETCH_DEFAULT_MAX_BYTES,
  WEB_FETCH_MAX_BYTES_CEILING,
  WEB_FETCH_MAX_OUTPUT,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_QUERY_MAX,
  WEB_SEARCH_SNIPPET_MAX,
  type WebFetchInput,
  type WebFetchOptions,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchProvider,
  webFetchInputSchema,
  webFetchTool,
  webSearchInputSchema,
  webSearchTool,
} from "./web"

/**
 * STRUCTURAL CONTRACT: composition roots (`src/apps/**`) MUST call
 * `buildDefaultTools(ports)` and NOT import the eager `defaultTools` singleton
 * directly — the singleton is retained ONLY as a test / back-compat default.
 * The factory is the DIP seam: every port flows in here.
 *
 * Injectable ports for the default tool set (DIP). The composition root can
 * substitute any port; every field is OPTIONAL and falls back to the same
 * default the standalone exports use, so `buildDefaultTools()` (no args) is
 * byte-identical — same tool ids, same runtime behavior — to the pre-factory
 * `defaultTools` array literal.
 *
 *   - `fs`: backs `read` / `write` / `edit` (the `make*Tool(fs)` builders).
 *           Defaults to `defaultFileSystemPort` inside each builder.
 *   - `diagnostics`: backs the `diagnostics` tool. Defaults to the
 *           `nullDiagnosticsProvider` (clean no-op) until the CLI injects a
 *           real LSP-backed provider.
 *
 * NOTE: `git` / `lsp_nav` tools are NOT part of the default set; the CLI wires
 * them via `gitTools(runner)` / `lspNavTools(provider)` separately, so they
 * are intentionally absent here.
 */
export interface DefaultToolPorts {
  fs?: FileSystemPort
  diagnostics?: DiagnosticsProvider
  /** ADR-0280 — when a host-wired `AutomationEnginePort` is passed,
   *  `automation_update` is appended to the default tool set. Absent ⇒
   *  the tool is NOT registered (byte-identical default tools). The
   *  composition root passes this only when `QUANTA_AUTOMATION === "on"`
   *  (see `src/apps/agent/index.ts` + `src/scheduler/runtime-wire.ts`). */
  automationEngine?: AutomationEnginePort
  /** ADR-0295 — sandbox-driven HITL. The bash tool's `hitlTier` closes over
   *  the operator-chosen `QUANTA_SANDBOX` profile (resolved at boot by
   *  `src/apps/cli/sandbox-wire.ts`) — no command-string heuristic. When
   *  absent the bash tool degrades to the conservative `always-confirm`
   *  tier for ALL commands (intended posture: no sandbox = unknown risk).
   *  Hosts that wire a profile MUST thread it through here. */
  sandboxProfile?: OsSandboxProfile
  /** ADR-0464 — when true, append `apply_patch_structured` (per-file-isolated
   *  V4A apply with self-correction `messageForModel` hints). Absent/false ⇒
   *  tool NOT registered (byte-identical default menu). The composition root
   *  passes this only when `QUANTA_ENABLE_STRUCTURED_PATCH === "1"` (see
   *  src/apps/agent/index.ts). No port to inject — the tool builds an
   *  `FsJailFileSystemPort` from `ctx.cwd` per call, identical to `apply_patch`. */
  structuredPatch?: boolean
  /** ADR-0165 — when true, append `coverage_check` (read-only V8-coverage
   *  reporter + optional threshold gate). Absent/false ⇒ tool NOT registered
   *  (byte-identical default menu). The composition root passes this only when
   *  `QUANTA_COVERAGE_TOOL === "1"` (see src/apps/cli/internal.ts). No port to
   *  inject — the tool builds its own `defaultV8CoverageSource()` per call and
   *  resolves the coverage JSON through the same FS-jail chokepoint `read` uses. */
  coverageCheck?: boolean
  /** H14a — when set, append `image_gen` (text→image generation + edit; the
   *  FIRST binary-artifact-GENERATION tool). Absent ⇒ tool NOT registered
   *  (byte-identical default menu). The composition root passes a KEY-BOUND
   *  provider port here only when `QUANTA_IMAGE_GEN` is on AND a provider key
   *  resolves (via `openAiImagePort({ apiKey })`, the key sourced from the same
   *  runtime-config `OPENAI_API_KEY` the LLM factory uses — never hardcoded).
   *  The port itself is closed-DI: a key-less port yields a typed `no_key`
   *  failure rather than crashing, so wiring it is always safe. */
  imageGen?: ImageGenPort
  /** H14b — when true, append the Office document AUTHORING tools (`xlsx_write`
   *  + `docx_write` + `pptx_write`): generate real `.xlsx` / `.docx` / `.pptx`
   *  files via pure-TS STORED-ZIP + OOXML (NO office dependency). Absent/false ⇒ tools NOT
   *  registered (byte-identical default menu). The composition root passes this
   *  only when `QUANTA_OFFICE_AUTHORING` is on. No port to inject — each tool
   *  serializes in-memory and writes through the same FS-jail chokepoint the
   *  readers use; an existing target is written to a versioned `-vN` sibling. */
  officeAuthoring?: boolean
  /** C1 — when set, append the artifact (Canvas) read/manage tools
   *  (`artifact_list` / `artifact_get` / `artifact_destroy`) bound to the
   *  session artifact registry. Absent ⇒ tools NOT registered (byte-identical).
   *  The composition root passes a `createArtifactRegistry()` (from `@/artifact`,
   *  structurally compatible with the duck-typed `ArtifactRegistryPort`) only
   *  when `QUANTA_ARTIFACT_STORE` is on. `register` is host-side (the generation
   *  tools register their outputs); the model only lists/inspects/destroys. */
  artifactRegistry?: ArtifactRegistryPort
  /** N2 — when set, append the MCP connector discovery tools
   *  (`mcp_connector_list` / `mcp_connector_install`). Absent ⇒ tools NOT
   *  registered (byte-identical). The composition root wires a discovery port
   *  (catalog source + `toMcpServerConfig` transform + `.mcp.json` writer) only
   *  when `QUANTA_MCP_CONNECTORS` is on. */
  mcpConnectors?: McpConnectorDiscoveryPort
  /** N3 — when set, append the MCP resource/prompt tools (`mcp_list_resources` /
   *  `mcp_read_resource` / `mcp_list_prompts` / `mcp_get_prompt`). Absent ⇒ tools
   *  NOT registered (byte-identical). The composition root wires a `ResourcesHandle`
   *  (the duck-typed mirror of `@/mcp/resources` `McpResourcesPort`, adapted over a
   *  live `McpClient` via the H19-landed `resources/*` + `prompts/*` methods) only
   *  when `QUANTA_MCP_RESOURCES` is on AND a connected server advertises
   *  resources/prompts. Output is mcp-origin ⇒ the H2 untrusted-source envelope
   *  wraps it at dispatch. */
  mcpResources?: ResourcesHandle
  /** C2 (jun-4-communicate-update.md) — when true, append `communicate_update`
   *  (read-only structured mid-turn progress report). Absent/false ⇒ tool NOT
   *  registered (byte-identical default menu). The composition root passes this
   *  only when `QUANTA_PROGRESS_UPDATE === "1"`. No port to inject here — the
   *  tool reads its `ProgressSink` from `ToolContext.progressSink` (surfaced by
   *  the dispatch seam from `AgentConfig.progressSink`); absent sink ⇒ the emit
   *  is a no-op and the model still gets `ok:true` (best-effort observability). */
  progressUpdate?: boolean
  /** N6 (jun-4-pty-attach.md) — when a `PtySessionPort` is wired, append the 6
   *  `pty_*` tools (attach/list/write/read/resize/kill to a long-lived PTY or
   *  named tmux session). Absent ⇒ tools NOT registered (byte-identical). The
   *  composition root wires the port (tmux/Bun backend) only when
   *  `QUANTA_PTY_ATTACH === "1"`. */
  ptySession?: PtySessionPort
}

export { automationUpdateTool } from "./automation_update"
// N6 (jun-4-pty-attach.md) — PTY/tmux session attach tools + the tmux backend.
// Caller-wired via `DefaultToolPorts.ptySession` (default-OFF; host wires a
// backend when `QUANTA_PTY_ATTACH === "1"`). `createTmuxAdapter` is the MVP-A
// zero-dep tmux backend; the slice's port is fence-clean (injected exec).
export {
  createTmuxAdapter,
  type PtyHandleInfo,
  type PtySessionPort,
  ptyTools,
  type TmuxExec,
} from "./pty"

/**
 * Build the built-in tool set: Phase 1 six + Phase 2 localize / test_runner +
 * the Phase-3 `diagnostics` tool — with INJECTABLE ports (DIP) so the
 * composition root can substitute the filesystem / diagnostics seams instead
 * of relying on the module-load singletons. Called with no args this is
 * identical (ids + behavior) to the historical `defaultTools` literal; the
 * exported `defaultTools` below is exactly `buildDefaultTools()`.
 */
export const buildDefaultTools = (ports: DefaultToolPorts = {}): Tool[] => {
  const base: Tool[] = buildBaseDefaultTools(ports)
  // ADR-0280 — conditional registration of automation_update. Absent
  // engine ⇒ default set is byte-identical (the model never sees the
  // tool). Present ⇒ closure-over-engine tool is appended.
  if (ports.automationEngine !== undefined) {
    base.push(automationUpdateTool(ports.automationEngine) as Tool)
  }
  // ADR-0464 — conditional registration of apply_patch_structured. Absent/false
  // ⇒ default set is byte-identical. Present ⇒ per-file-isolated apply tool is
  // appended (builds the FsJail port from ctx.cwd per call, like apply_patch).
  if (ports.structuredPatch === true) {
    base.push(makeApplyPatchStructuredTool() as Tool)
  }
  // ADR-0165 — conditional registration of coverage_check. Absent/false ⇒
  // default set is byte-identical. Present ⇒ read-only V8-coverage reporter
  // is appended (self-contained: builds its own coverage source per call).
  if (ports.coverageCheck === true) {
    base.push(coverageCheckTool as Tool)
  }
  // H14a — conditional registration of image_gen. Absent port ⇒ default set is
  // byte-identical (the model never sees the tool). Present ⇒ a tool bound to
  // the host's key-resolved provider port is appended (mutating; writes a
  // versioned-sibling artifact through the FS jail).
  if (ports.imageGen !== undefined) {
    // C1 — when the artifact registry is ALSO wired, the generated image is
    // best-effort registered (default-OFF ⇒ port absent ⇒ byte-identical).
    base.push(
      imageGenTool({
        port: ports.imageGen,
        ...(ports.artifactRegistry !== undefined
          ? { artifactRegistry: ports.artifactRegistry }
          : {}),
      }) as Tool,
    )
  }
  // H14b — conditional registration of the Office authoring tools. Absent/false
  // ⇒ default set is byte-identical. Present ⇒ `xlsx_write` + `docx_write` are
  // appended (mutating; pure-TS OOXML serialize + FS-jail write, versioned
  // sibling on an existing target).
  if (ports.officeAuthoring === true) {
    // C1 — when the artifact registry is ALSO wired, each authored file is
    // best-effort registered (default-OFF ⇒ port absent ⇒ byte-identical: the
    // `make*WriteTool()` factory with no registry === the historical const tool).
    const authoringOpts =
      ports.artifactRegistry !== undefined ? { artifactRegistry: ports.artifactRegistry } : {}
    base.push(makeXlsxWriteTool(authoringOpts) as Tool)
    base.push(makeDocxWriteTool(authoringOpts) as Tool)
    // H14 PPTX follow-up — same gate: generate real .pptx (PresentationML).
    base.push(makePptxWriteTool(authoringOpts) as Tool)
  }
  // C1 — conditional registration of the artifact (Canvas) read/manage tools.
  // Absent registry ⇒ default set is byte-identical (the model never sees them).
  // Present ⇒ `artifact_list` / `artifact_get` / `artifact_destroy` bound to the
  // host's session registry are appended.
  if (ports.artifactRegistry !== undefined) {
    base.push(...artifactTools(ports.artifactRegistry))
  }
  // N2 — conditional registration of the MCP connector discovery tools. Absent
  // port ⇒ default set byte-identical. Present ⇒ `mcp_connector_list` /
  // `mcp_connector_install` bound to the host's catalog+installer are appended.
  if (ports.mcpConnectors !== undefined) {
    base.push(...mcpConnectorTools(ports.mcpConnectors))
  }
  // N3 — conditional registration of the MCP resource/prompt tools. Absent port
  // ⇒ default set byte-identical. Present ⇒ `mcp_list_resources` /
  // `mcp_read_resource` / `mcp_list_prompts` / `mcp_get_prompt` bound to the
  // host's `ResourcesHandle` are appended (mcp-origin ⇒ H2 envelope at dispatch).
  if (ports.mcpResources !== undefined) {
    base.push(...mcpResourcesTools(ports.mcpResources))
  }
  // C2 — conditional registration of communicate_update. Absent/false ⇒ default
  // set is byte-identical (the model never sees the tool). Present ⇒ the
  // read-only structured progress-report tool is appended (it reads its sink
  // from ctx.progressSink; absent sink degrades to a no-op + ok:true).
  if (ports.progressUpdate === true) {
    base.push(createCommunicateUpdateTool() as Tool)
  }
  // N6 — conditional registration of the 6 pty_* tools. Absent port ⇒ default
  // set byte-identical. Present ⇒ attach/list/write/read/resize/kill bound to
  // the host's PTY/tmux backend are appended (exec-risk; foreign-tmux gated).
  if (ports.ptySession !== undefined) {
    base.push(...ptyTools(ports.ptySession))
  }
  return base
}

const buildBaseDefaultTools = (ports: DefaultToolPorts): Tool[] => [
  (ports.fs !== undefined ? makeReadTool(ports.fs) : readTool) as Tool,
  (ports.fs !== undefined ? makeWriteTool(ports.fs) : writeTool) as Tool,
  (ports.fs !== undefined ? makeEditTool(ports.fs) : editTool) as Tool,
  // Phase 4: `scripted_replace` is registered by default — the LLM only routes
  // to it when `edit` surfaces a strategy hint or the prompt calls for bulk
  // substitution. Sessions that never invoke it see byte-identical behavior.
  scriptedReplaceTool as Tool,
  // V4A apply_patch (Wave C): multi-file atomic patch against session cwd via
  // FsJail-confined port. Same mutating posture as edit/write/scripted_replace;
  // sessions that never route to it are byte-identical. Reuses whatever
  // `apply-patch.ts` exports — that file is owned elsewhere and untouched.
  applyPatchTool as Tool,
  // ADR-0297 — `bash` is factory-built so its `hitlTier` closes over the
  // composition-root-resolved sandbox profile (NOT command-string regex).
  // Absent profile ⇒ conservative `always-confirm` for ALL commands.
  // ADR-0295 (mode) + ADR-0296 (timeout_behavior) compose into the same factory.
  makeBashTool(
    ports.sandboxProfile !== undefined ? { sandboxProfile: ports.sandboxProfile } : {},
  ) as Tool,
  // ADR-0296 — async-shell siblings to `bash`. `bash_await` is read-only +
  // concurrency-safe (pure polling); `bash_kill` is mutating (signals a
  // background process). Both consult the module-level bg registry; sessions
  // that never opt into `timeout_behavior:"background"` never populate the
  // registry, so registering these by default costs nothing.
  bashAwaitTool as Tool,
  bashKillTool as Tool,
  grepTool as Tool,
  globTool as Tool,
  localizeTool as Tool,
  // Fault-localization aids (Codex signal absorption): file_tree_summary for
  // Stage-1 structure, parse_test_failure for Stage-3 log→file:line. Both
  // read-only + concurrency-safe; sessions that never call them are unchanged.
  fileTreeSummaryTool as Tool,
  parseTestFailureTool as Tool,
  testRunnerTool as Tool,
  diagnosticsTool(ports.diagnostics ?? nullDiagnosticsProvider) as Tool,
  // ADR-0126: vision input. Read-only + concurrency-safe; safe in defaults.
  readImageTool as Tool,
  // ADR-0132 / ADR-0146 — vision input from HTTPS URL. Read-only +
  // concurrency-safe; parallel to `read_image` (FS) and `web_fetch` (HTTP).
  // Factory binds global `fetch` by default (`readImageUrlTool({fetcher})`
  // injects a test double); SSRF + 5 MB cap + magic-byte sniffing live inside
  // the tool. No host-side port to inject ⇒ always-on default-tool slot.
  readImageUrlTool() as Tool,
  // ADR-0127: web fetch (SSRF denylist + size cap inside). Read-only + concurrency-safe.
  webFetchTool() as Tool,
  // ADR-0133/0137 + ADR-0142 wire: structured-data + native-document readers.
  // All five are read-only + concurrency-safe (pure parse-and-render of disk
  // content; no FS writes, no shell, no network). Classified `null` in
  // MUTATING_TOOL_TABLE in the same change so plan-mode cross-check passes.
  csvReadTool as Tool,
  ndjsonReadTool as Tool,
  yamlReadTool as Tool,
  pdfReadTool as Tool,
  xlsxReadTool as Tool,
  // jun-04 — `docx_read` (real WordprocessingML reader, sibling to the now-real
  // xlsx_read). Read-only + concurrency-safe; pure unzip + XML parse.
  docxReadTool as Tool,
  // H14 PPTX follow-up — `pptx_read` (real PresentationML reader, sibling to
  // xlsx_read / docx_read). Read-only + concurrency-safe; pure unzip + XML parse.
  // BASE (always-on) — only the AUTHORING tool (`pptx_write`) is knob-gated.
  pptxReadTool as Tool,
  // `session_config` — agent self-inspection / self-mutation over its own
  // SDK posture (effort tier, identity mode, tool profile, model, provider).
  // Always registered: when the composition root has not wired the seam,
  // the tool yields a typed `not_wired` failure. Read+write split: `op:get`
  // reads, `op:set_effort` mutates the session effort (mirrors `/effort`).
  sessionConfigTool as Tool,
]

/**
 * Built-in tool set with default ports. Kept as a stable, eagerly-evaluated
 * export so existing callers (`apps/*`, smoke runner, tests) that import
 * `defaultTools` are unchanged. Equivalent to `buildDefaultTools()`.
 */
export const defaultTools: Tool[] = buildDefaultTools()

// jun-03 — tool-surface SSOT (managed catalog of the LLM tool-access axis:
// gate + per-surface default). Companion to the feature catalog; pinned by
// tests/unit/tool-surface-manifest-hellgate.test.ts (two-way drift guard).
export {
  ALL_MANIFEST_TOOL_NAMES,
  BASE_TOOL_NAMES,
  entryToolNames,
  GATED_TOOLS,
  seedEnvVarsForSurface,
  shouldSeedOn,
  surfaceDefaultFor,
  TOOL_SURFACES,
  type ToolDefault,
  type ToolGate,
  type ToolRisk,
  type ToolSurface,
  type ToolSurfaceEntry,
} from "./surface/manifest"
