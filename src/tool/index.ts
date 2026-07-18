import { defaultFileSystemPort } from "@/storage"
import { applyPatchTool } from "./apply-patch"
import { makeApplyPatchStructuredTool } from "./apply-patch-structured-tool"
import { appshotVerifyTool } from "./appshot"
import { artifactTools } from "./artifact"
import { askUserTool } from "./ask-user"
import { automationUpdateTool } from "./automation_update"
import { makeBashTool } from "./bash"
import { bashAwaitTool } from "./bash/await"
import { bashKillTool } from "./bash/kill"
import { codeCellTool } from "./codemode-tool"
import { createCommunicateUpdateTool } from "./communicate-update"
import { containerExecTool, containerWriteFileTool } from "./container-exec"
import { coverageCheckTool } from "./coverage_check"
import { makeDebugInspectTool } from "./debug/tool"
import { makeNodeReplTool } from "./node-repl"
import type { DefaultToolPorts } from "./default-tool-ports"
import { diagnosticsTool, nullDiagnosticsProvider } from "./diagnostics"
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
import { makeCollectEvidenceTool } from "./evidence/tool"
import { fetchRulesTool } from "./fetch-rules"
import { makeFileHistoryRewindTool } from "./file-history"
import { fileTreeSummaryTool } from "./file-tree-summary"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { makeReadImageTool, readImageUrlTool } from "./image"
import { imageGenTool } from "./image-gen"
import { localizeTool } from "./localize"
import { mcpResourcesTools } from "./mcp_resources"
import { mcpConnectorTools } from "./mcp-connector"
import { makeNotebookEditTool } from "./notebook-edit/tool"
import { parseTestFailureTool } from "./parse-test-failure"
import { permissionProposeTools } from "./permission-propose"
import { projectsKbTool } from "./projects-kb"
import { ptyTools } from "./pty"
import { makeReadTool, readTool } from "./read"
import { reflectTool } from "./reflect"
import { scriptedReplaceTool } from "./scripted-replace"
import { sessionConfigTool } from "./session_config"
import { testRunnerTool } from "./test-runner"
import { makeRunTestsTool } from "./testrun/tool"
import { threadsHandoffTool } from "./threads_handoff"
import type { Tool } from "./types"
import { webFetchTool } from "./web"
import { makeWriteTool, writeTool } from "./write"

export { applyPatchTool, FsJailViolationError } from "./apply-patch"
export { makeApplyPatchStructuredTool } from "./apply-patch-structured-tool"
// `appshot` cluster (G1, RFC jun-6) — the CLOSED generation→verification loop
// (`appshot_verify`): spec → scaffold → render → screenshot → LLM-judge →
// iterate (bounded). Composes the existing browser_* + jailed-write +
// artifact-store ends, all effects injected via `AppshotPort`. Caller-wired +
// default-OFF: registered only when `DefaultToolPorts.appshot` is set (the
// composition root passes a port wired to the real BrowserPort + LLM-judge +
// jailed scaffold when `QUANTA_APPSHOT` is on).
export {
  APPSHOT_MAX_ITER,
  APPSHOT_MAX_SCREENSHOT_BYTES,
  APPSHOT_MIN_ITER,
  type AppSpec,
  type AppshotArtifactSink,
  type AppshotAvailability,
  type AppshotPort,
  type AppshotRequest,
  type AppshotResult,
  type AppshotToolOptions,
  type AppshotVerifyInput,
  appshotVerifyInputSchema,
  appshotVerifyTool,
  clampIter as appshotClampIter,
  isRealJudgePass,
  judgeVerdict,
  makeJailedScaffold,
  renderScaffoldHtml,
  runAppshotLoop,
  type ScaffoldResult,
  type ScaffoldWritePort,
  type VerifyVerdict,
} from "./appshot"
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
// ast_grep — structural code search via ast-grep patterns (QUANTA_AST_GREP opt-in).
// Caller-wired: registered by the composition root when QUANTA_AST_GREP is on
// AND ast-grep is present on PATH (the tool self-probes and returns an install
// hint if the binary is missing). Read-only + concurrency-safe.
export { astGrepTool } from "./ast-grep"
export { automationUpdateTool } from "./automation_update"
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
// code-mode (RFC jun-6-code-mode, Phase 1) — the gated `code_cell` tool. Default-OFF:
// registered only when `DefaultToolPorts.codeMode === true` (QUANTA_CODE_MODE on AND
// the host wired `AgentConfig.codeCellDispatchFactory`). The dispatch port arrives
// per-call via `ToolContext.codeCellDispatch`; the QuickJS-WASM module is lazily
// imported inside `@/codemode` only when the tool runs.
export {
  type CodeCellInput,
  codeCellInputSchema,
  codeCellTool,
} from "./codemode-tool"
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
// jun-6 tool-interrupt-behavior — PURE per-call interrupt-routing helper wrapped
// by the dispatch abort-router for `"block"` tools (clock + scheduler injected;
// no ambient state). The composition root in `@/agent` constructs one per call.
export {
  type CriticalSectionScheduler,
  type InterruptRouter,
  type InterruptRouterObserver,
  type MakeInterruptRouterArgs,
  makeInterruptRouter,
} from "./critical-section"
// `DefaultToolPorts` + `AppshotSlot` — the DIP seam type cluster (the injectable
// ports for the default tool set). Extracted to a sibling for module-size; the
// COMPLETE public surface is re-exported here so `@/tool` consumers are unchanged.
export type { AppshotSlot, DefaultToolPorts } from "./default-tool-ports"
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
export { enterPlanModeTool } from "./enter-plan-mode"
// Keystone — Evidence Packet Builder public surface (the cross-slice
// enrichment bridge in @/agent consumes StaticEvidence/RuntimeEvidence).
export {
  buildEvidence,
  type EvidencePacket,
  type EvidenceSources,
  type FailureEvidence,
  type RuntimeEvidence,
  type RuntimeFrame,
  type RuntimeVar,
  type StaticEvidence,
} from "./evidence"
export type { DefineToolSpec, StreamingInputStep } from "./factory"
export {
  defineTool,
  driveStreamingInput,
  enforceOutputSchema,
  renderModelOutput,
  validateToolOutput,
} from "./factory"
// file_history_rewind — the per-file snapshot store + sink the composition root
// mints ONCE per session (when QUANTA_FILE_HISTORY is on) and threads to BOTH
// `DefaultToolPorts.fileHistory` (the tool read side) and `AgentConfig.fileHistory`
// (the write/edit capture sink). Default-OFF: nothing constructs them otherwise.
export {
  createFileHistorySink,
  createFileHistoryStore,
  type FileHistoryStore,
} from "./file-history"
export {
  aggregate as aggregateFileTree,
  fileTreeSummaryTool,
  inferNextAction,
  render as renderFileTree,
  type TreeAgg,
} from "./file-tree-summary"
// Caller-wired: registered by the bench driver when the localize grounding steer
// is on (find_references is the timeout-immune ripgrep replacement for the
// steer's lsp_references recommendation — pyright references is intractable on
// large repos, measured jun-19). Read-only + concurrency-safe.
export { findReferencesTool } from "./find-refs"
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
  gitCoChangeTool,
  gitCommitTool,
  gitConflictInspectTool,
  gitDiffTool,
  gitLogTool,
  gitMovedCodeTool,
  gitStatusTool,
  gitTools,
  gitUpstreamCheckTool,
  parseCommitGroups,
  rankBlame,
  rankChurn,
  rankCoChange,
  rankCoChangePairs,
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
  CodeActionPort,
  CodeActionPortAction,
  CodeActionPortDocumentEdit,
  CodeActionPortKind,
  CodeActionPortPos,
  CodeActionPortRange,
  CodeActionPortTextEdit,
  CodeActionPortWorkspaceEdit,
  FormatPort,
  FormatPortPos,
  FormatPortRange,
  FormatPortTextEdit,
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
  SignatureHelpPort,
  SignatureHelpPortInfo,
  SignatureHelpPortParameter,
} from "./lsp_nav"
export {
  isCheapLspNavTool,
  LSP_NAV_EXPENSIVE_TOOL_NAMES,
  lspCodeActionTool,
  lspFormatTool,
  lspNavTools,
  lspRenameApplyTool,
  lspSignatureHelpTool,
  nullLspNavProvider,
} from "./lsp_nav"
// N3 — MCP resource/prompt tools (`mcp_list_resources` / `mcp_read_resource` /
// `mcp_list_prompts` / `mcp_get_prompt`). Caller-wired + default-OFF: registered
// only when `DefaultToolPorts.mcpResources` is wired (the duck-typed
// `ResourcesHandle` keeps `@/tool` fence-clean; the host adapts a live McpClient
// over the H19-landed `resources/*` + `prompts/*` methods). Output is mcp-origin
// ⇒ the H2 untrusted-source envelope wraps it at dispatch.
export {
  type CapturedResourceChild,
  type CapturedResourceDir,
  createMcpResourceCaptureHolder,
  DEFAULT_MCP_RESOURCE_CAPTURE_CAP,
  filterDirectChildren,
  type GetPromptInput,
  getPromptInputSchema,
  type HandleResult as ResourcesHandleResult,
  type ListPromptsInput,
  type ListResourcesInput,
  type ListResourceTemplatesInput,
  listPromptsInputSchema,
  listResourcesInputSchema,
  listResourceTemplatesInputSchema,
  type McpResourceCaptureHolder,
  mcpGetPromptTool,
  mcpListPromptsTool,
  mcpListResourcesTool,
  mcpListResourceTemplatesTool,
  mcpReadResourceDirTool,
  mcpReadResourceTool,
  mcpResourcesTools,
  type PromptEntry,
  type PromptMessage,
  type PromptResult,
  type ReadResourceDirInput,
  type ReadResourceInput,
  type ResourceBlock,
  type ResourceEntry,
  type ResourcesFailureReason,
  type ResourcesHandle,
  type ResourceTemplateEntry,
  readResourceDirInputSchema,
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
// CLUSTER D #5 — model-facing permission self-propose tool
// (`permission_propose_pattern`). Caller-wired via
// `DefaultToolPorts.permissionPatternPropose` (default-OFF; the host wires a
// port adapting `@/permission`'s `recordProposedPattern` over a per-session
// `PatternGrantStore` ONLY when `QUANTA_REMEMBER_PATTERNS` is on). The duck-typed
// `PermissionPatternProposePort` keeps `@/tool` fence-clean (no `@/permission`
// import). NO-WIDEN / NO-SELF-GRANT enforced by the port; tool routes EXCLUSIVELY
// through it.
export {
  type PermissionPatternProposePort,
  type PermissionProposePatternInput,
  PROPOSE_PATTERN_MAX,
  type ProposePortInput,
  type ProposePortResult,
  type ProposeRejectReason as PermissionProposeRejectReason,
  permissionProposePatternInputSchema,
  permissionProposeTools,
} from "./permission-propose"
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
// A3 — Projects knowledge-base (context-offloading KB leaf). Caller-wired via
// `DefaultToolPorts.projectsKb` (default-OFF; the composition root mints a
// `createProjectsKbStore()` and threads the slot when `QUANTA_PROJECTS_KB` is
// on). The store + slot + knob-default constants are re-exported here so the
// composition root wires the slot with ONE `@/tool` import (mirrors
// `createFileHistoryStore`). The "never enters context" invariant lives in the
// tool: project_write returns ONLY metadata (doc_uuid + byte size).
export {
  createProjectsKbStore,
  DEFAULT_PROJECTS_KB_MAX_KNOWLEDGE_BYTES,
  DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES,
  type ProjectsKbBackendPort,
  type ProjectsKbDocMeta,
  type ProjectsKbHit,
  type ProjectsKbInput,
  type ProjectsKbKnowledge,
  type ProjectsKbSlot,
  type ProjectsKbStore,
  type ProjectsKbStoreOpts,
  projectsKbTool,
  renderKnowledge as renderProjectsKbKnowledge,
} from "./projects-kb"
// N6 (jun-4-pty-attach.md) — PTY/tmux session attach tools + the tmux backend.
// Caller-wired via `DefaultToolPorts.ptySession` (default-OFF; host wires a
// backend when `QUANTA_PTY_ATTACH === "1"`). `createTmuxAdapter` is the MVP-A
// zero-dep tmux backend; the slice's port is fence-clean (injected exec).
export {
  type BunPtyAdapter,
  type BunPtySpawnOpts,
  createBunPtyAdapter,
  createTmuxAdapter,
  type PtyChildHandle,
  type PtyFactoryPort,
  type PtyHandleInfo,
  type PtySessionPort,
  type PtyTerminalHandle,
  ptyTools,
  type TmuxExec,
} from "./pty"
export type { ReadOutlineParserPort } from "./read"
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
// B2 — cross-surface handoff leaf tool (shares the automation-engine gate).
export { threadsHandoffTool } from "./threads_handoff"
export type {
  ActiveWorktree,
  BlockerSurface,
  CodeCellDispatchSeam,
  CriticalSectionHandle,
  CriticalSectionSeam,
  DeferredHandle,
  DeferredToolResult,
  FileHistorySink,
  GitWriteGuard,
  HITLTier,
  NextAction,
  PlanDeltaKind,
  PlanEntryRequester,
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
  ToolInterruptPolicy,
  ToolResult,
  ToolResultEvidence,
  ToolSpec,
  UserInputOutcome,
  UserInputRequester,
  WorkingStateHandle,
  WorkingStatePatch,
  WorkingStateSnapshot,
  WorktreeSlotHandle,
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
// ticket-11 (P8) — git-worktree AGENT tools (default-OFF, gate
// `QUANTA_WORKTREE_TOOL` + session-scoped slot). The 3 tools (enter/exit/status)
// + the names list + the cwd-override helpers the bash/edit tools consume.
export {
  enterWorktreeTool,
  exitWorktreeTool,
  WORKTREE_TOOL_NAMES,
  worktreeStatusTool,
  worktreeTools,
} from "./worktree"
export { resolveBashCwd, resolveEditBase } from "./worktree/cwd-override"

/** A port-gated tool-group builder: returns the tool(s) to register for the
 *  given ports, or `[]` when its port is absent. Adding a conditionally-
 *  registered tool is ONE entry in {@link CONDITIONAL_REGISTRATIONS} — never a new
 *  `if (ports.x)` arm (OCP). The array ORDER is the registration order
 *  (byte-identical to the historical if-ladder), and each builder self-guards on
 *  its own port (the ternary narrows the port type, so no `!` assertion is
 *  needed and an absent port is a no-op `[]`). */
type ConditionalRegistration = (ports: DefaultToolPorts) => Tool[]

const CONDITIONAL_REGISTRATIONS: readonly ConditionalRegistration[] = [
  // ADR-0280 — automation_update (+ B2 cross-surface threads_handoff, sharing the
  // engine gate; both pure leaf tools). Absent engine ⇒ never registered.
  (p) =>
    p.automationEngine !== undefined
      ? [automationUpdateTool(p.automationEngine) as Tool, threadsHandoffTool() as Tool]
      : [],
  // ADR-0464 — apply_patch_structured (per-file-isolated apply, FsJail from ctx.cwd).
  (p) => (p.structuredPatch === true ? [makeApplyPatchStructuredTool() as Tool] : []),
  // ADR-0165 — coverage_check (read-only V8-coverage reporter, self-contained).
  (p) => (p.coverageCheck === true ? [coverageCheckTool as Tool] : []),
  // H14a — image_gen bound to the host provider port (mutating; versioned-sibling
  // FS-jail write). C1: best-effort artifact registration when that registry is wired.
  (p) =>
    p.imageGen !== undefined
      ? [
          imageGenTool({
            port: p.imageGen,
            ...(p.artifactRegistry !== undefined ? { artifactRegistry: p.artifactRegistry } : {}),
          }) as Tool,
        ]
      : [],
  // H14b — Office authoring xlsx/docx/pptx (mutating; pure-TS OOXML serialize +
  // FS-jail write). C1: same artifact-registry best-effort registration.
  (p) => {
    if (p.officeAuthoring !== true) return []
    const opts = p.artifactRegistry !== undefined ? { artifactRegistry: p.artifactRegistry } : {}
    return [
      makeXlsxWriteTool(opts) as Tool,
      makeDocxWriteTool(opts) as Tool,
      makePptxWriteTool(opts) as Tool,
    ]
  },
  // C1 — artifact (Canvas) list/get/destroy bound to the host session registry.
  (p) => (p.artifactRegistry !== undefined ? [...artifactTools(p.artifactRegistry)] : []),
  // ADR-0494 — ask_user structured elicitation bound to the host prompter (read-only).
  (p) => (p.askUser !== undefined ? [askUserTool(p.askUser) as Tool] : []),
  // ADR-0504 (GAP 11) — reflect mid-turn self-correction (LLM-backed, quota-enforced).
  (p) => (p.reflect !== undefined ? [reflectTool(p.reflect) as Tool] : []),
  // ADR-0509 (GAP 6) — fetch_rules agent-requested-rules retrieval.
  (p) => (p.fetchRules !== undefined ? [fetchRulesTool(p.fetchRules) as Tool] : []),
  // file_history_rewind — per-file snapshot list/restore (mutating on restore; jailed).
  (p) =>
    p.fileHistory !== undefined
      ? [makeFileHistoryRewindTool(p.fileHistory, p.fs ?? defaultFileSystemPort) as Tool]
      : [],
  // W6 — notebook_edit cell editor bound to the SAME jailed FS port (atomic write-back).
  (p) =>
    p.notebookEdit === true ? [makeNotebookEditTool(p.fs ?? defaultFileSystemPort) as Tool] : [],
  // W5 (DAP) — debug_inspect (high-risk: runs the program under a debug adapter).
  (p) => (p.debugTools === true ? [makeDebugInspectTool() as Tool] : []),
  // ADR-0249 — node_repl (high-risk: arbitrary Node code in a persistent kernel).
  // Registered ONLY when the host wires the stateful NodeReplKernel port.
  (p) => (p.nodeRepl !== undefined ? [makeNodeReplTool(p.nodeRepl) as Tool] : []),
  // Epic-2 — run_tests structured test-runner (high-risk: runs project test code).
  (p) =>
    p.testRunner === true ? [makeRunTestsTool({ fs: p.fs ?? defaultFileSystemPort }) as Tool] : [],
  // Keystone — collect_evidence Evidence Packet Builder (high-risk: runs the suite).
  (p) =>
    p.evidence !== undefined
      ? [makeCollectEvidenceTool({ fs: p.fs ?? defaultFileSystemPort, ...p.evidence }) as Tool]
      : [],
  // CLUSTER D #5 — permission_propose_pattern bound to the host no-widen recording port.
  (p) =>
    p.permissionPatternPropose !== undefined
      ? [...permissionProposeTools(p.permissionPatternPropose)]
      : [],
  // N2 — MCP connector discovery (mcp_connector_list / _install).
  (p) => (p.mcpConnectors !== undefined ? [...mcpConnectorTools(p.mcpConnectors)] : []),
  // N3 — MCP resource/prompt tools (mcp-origin ⇒ H2 envelope at dispatch).
  (p) => (p.mcpResources !== undefined ? [...mcpResourcesTools(p.mcpResources)] : []),
  // C2 — communicate_update read-only progress report (reads sink from ctx.progressSink).
  (p) => (p.progressUpdate === true ? [createCommunicateUpdateTool() as Tool] : []),
  // N6 — the 6 pty_* tools bound to the host PTY/tmux backend (exec-risk).
  (p) => (p.ptySession !== undefined ? [...ptyTools(p.ptySession)] : []),
  // code-mode — code_cell gated tool (reads dispatch port from ctx.codeCellDispatch).
  (p) => (p.codeMode === true ? [codeCellTool() as Tool] : []),
  // G1 — appshot_verify bound to the host verify-loop port + clock (mutating).
  (p) =>
    p.appshot !== undefined
      ? [
          appshotVerifyTool({
            port: p.appshot.port,
            now: p.appshot.now,
            ...(p.appshot.artifactSink !== undefined
              ? { artifactSink: p.appshot.artifactSink }
              : {}),
          }) as Tool,
        ]
      : [],
  // A3 — projects_kb bound to the host session KB store (metadata-only, never enters context).
  (p) => (p.projectsKb !== undefined ? [projectsKbTool(p.projectsKb) as Tool] : []),
]

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
  // Data-driven port-gated registration (byte-identical to the historical
  // if-ladder: same order, same guards). Absent ports ⇒ the model never sees
  // the tool. Adding a tool = one CONDITIONAL_REGISTRATIONS entry.
  for (const register of CONDITIONAL_REGISTRATIONS) base.push(...register(ports))
  return base
}

const buildBaseDefaultTools = (ports: DefaultToolPorts): Tool[] => [
  (ports.fs !== undefined || ports.readOutlineParser !== undefined
    ? makeReadTool(ports.fs ?? defaultFileSystemPort, ports.readOutlineParser)
    : readTool) as Tool,
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
  // gap-other-agent GAP 1 — the downsample codec (if wired via
  // DefaultToolPorts.imageDownsample) lets read_image shrink oversized images
  // instead of rejecting; absent ⇒ byte-identical (reject over-cap as before).
  makeReadImageTool(ports.imageDownsample) as Tool,
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

/**
 * The `terminal` ToolSurface registry (RFC jun-29, spec S2) — a terminal
 * operator drives a live container terminal, so its tool set is the `pty_*` family ONLY and
 * deliberately does NOT inherit the BASE repo-edit/host-exec tools ({@link buildBaseDefaultTools}
 * = read/write/edit/apply_patch/bash/grep/test_runner…). Assembled by an EXPLICIT builder
 * (not `buildDefaultTools` with surface-default overrides) precisely so BASE can never leak in.
 * Container-bound exec is enforced by wiring `ports.ptySession` over a container-bound
 * {@link ./pty/docker-exec-tmux} TmuxExec (host bash is never registered — spec S3). No port ⇒
 * empty (fail-safe; never falls back to the BASE set).
 */
export const buildTerminalTools = (ports: DefaultToolPorts = {}): Tool[] => [
  // one-shot container exec (the workhorse — exit-code completion, non-interactive steps)
  ...(ports.containerExec !== undefined ? [containerExecTool(ports.containerExec)] : []),
  // B2 (RFC jul-3, default-OFF via composition root): exact-byte file authoring over the same
  // container transport — the heredoc-mangle escape hatch for file-is-the-deliverable tasks.
  ...(ports.containerWriteFile !== undefined
    ? [containerWriteFileTool(ports.containerWriteFile)]
    : []),
  // interactive tmux pane (vim/REPL/TUI)
  ...(ports.ptySession !== undefined ? ptyTools(ports.ptySession) : []),
]

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
// Capability guidance the terminal entry-point injects alongside the surface tools (RFC §4.5 /
// §13 #5 — closes the #1 failure, exe-not-in-PATH). General operator habits, no answer-key.
export {
  SELF_TEST_DISCIPLINE,
  TERMINAL_OPERATOR_GUIDE,
  terminalOperatorGuide,
} from "./terminal-capability-guide"
