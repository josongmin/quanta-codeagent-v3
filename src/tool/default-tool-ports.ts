import type { OsSandboxProfile } from "@/runtime"
import type { AutomationEnginePort } from "@/scheduler/automation-engine"
import type { FileSystemPort } from "@/storage"
import type { AppshotArtifactSink, AppshotPort } from "./appshot"
import type { ArtifactRegistryPort } from "./artifact"
import type { AskUserPort } from "./ask-user"
import type { DiagnosticsProvider } from "./diagnostics"
import type { EvidenceToolDeps } from "./evidence/tool"
import type { FetchRulesPort } from "./fetch-rules"
import type { FileHistoryStore } from "./file-history"
import type { ImageDownsamplePort } from "./image"
import type { ImageGenPort } from "./image-gen"
import type { ResourcesHandle } from "./mcp_resources"
import type { McpConnectorDiscoveryPort } from "./mcp-connector"
import type { PermissionPatternProposePort } from "./permission-propose"
import type { PtySessionPort } from "./pty"
import type { ReflectPort } from "./reflect"

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
  /** W6 (NotebookEdit P17) — when set, append `notebook_edit` (cell-level
   *  str_replace/insert/delete on `.ipynb`, reusing the same FS jail `edit`
   *  uses). Host sets this iff `QUANTA_NOTEBOOK_EDIT` is on; absent ⇒ tool not
   *  registered (byte-identical default menu). No port — the editor is pure. */
  notebookEdit?: boolean
  /** W5 (DAP) — when set, append `debug_inspect` (run a program under a Debug
   *  Adapter Protocol adapter, stop at the first breakpoint, report stack +
   *  variables). Host sets this iff `QUANTA_DEBUG_TOOLS` is on; absent ⇒ tool
   *  not registered (byte-identical). High-risk (executes user code). */
  debugTools?: boolean
  /** Epic-2 — when set, append `run_tests` (detect toolchain + run suite +
   *  normalized pass/fail evidence). Host sets this iff `QUANTA_TEST_RUNNER` is
   *  on; absent ⇒ tool not registered (byte-identical). High-risk (runs test code). */
  testRunner?: boolean
  /** Keystone — when set (even `{}`), append `collect_evidence` (Evidence Packet
   *  Builder). The object carries the OPTIONAL cross-slice enrichment ports the
   *  host injects (LSP static / DAP runtime / changed-files); `{}` ⇒ failure +
   *  repo evidence only. Host sets this iff `QUANTA_EVIDENCE` is on; absent ⇒
   *  tool not registered (byte-identical). High-risk (runs the suite). */
  evidence?: Omit<EvidenceToolDeps, "fs" | "testPort">
  /** C1 — when set, append the artifact (Canvas) read/manage tools
   *  (`artifact_list` / `artifact_get` / `artifact_destroy`) bound to the
   *  session artifact registry. Absent ⇒ tools NOT registered (byte-identical).
   *  The composition root passes a `createArtifactRegistry()` (from `@/artifact`,
   *  structurally compatible with the duck-typed `ArtifactRegistryPort`) only
   *  when `QUANTA_ARTIFACT_STORE` is on. `register` is host-side (the generation
   *  tools register their outputs); the model only lists/inspects/destroys. */
  artifactRegistry?: ArtifactRegistryPort
  /** ADR-0494 — when set, append `ask_user` (generalized structured elicitation:
   *  free-text / yes-no / number / single- or multi-select). Absent ⇒ tool NOT
   *  registered (byte-identical default menu). The composition root wires a
   *  prompter (adapting the existing `@/mcp/elicitation` host prompter to the
   *  `AskUserPort` shape) ONLY when `QUANTA_ASK_USER` is on; a headless host
   *  passes a port that returns typed `headless-denied`, so wiring is always safe. */
  askUser?: AskUserPort
  /** ADR-0504 (gap GAP 11) — when set, append `reflect` (mid-turn self-correction
   *  consult). Absent ⇒ tool NOT registered (byte-identical). The composition root
   *  wires an LLM-backed `ReflectPort` ONLY when `QUANTA_REFLECT` is on (like the
   *  advisor port). The tool enforces a per-session quota (reflect is expensive). */
  reflect?: ReflectPort
  /** ADR-0509 (gap GAP 6) — when set, append `fetch_rules` (agent-requested
   *  description-only rule retrieval). Absent ⇒ tool NOT registered (byte-identical).
   *  The composition root wires a port over the requestable-rules index + matcher
   *  ONLY when `QUANTA_FETCH_RULES` is on AND the index is non-empty. */
  fetchRules?: FetchRulesPort
  /** gap-other-agent GAP 1 — when set, `read_image` downsamples an oversized image
   *  (> MAX_IMAGE_BYTES) via this codec instead of rejecting. Absent ⇒ over-cap
   *  images are rejected exactly as before (byte-identical). The composition root
   *  wires a WASM/native codec port ONLY when `QUANTA_IMAGE_DOWNSAMPLE` is on
   *  (quanta ships no pure-TS image codec, so it is always host-provided). */
  imageDownsample?: ImageDownsamplePort
  /** file_history_rewind — when set, append `file_history_rewind` (per-file
   *  session-snapshot list/restore) bound to this session's history store.
   *  Absent ⇒ tool NOT registered (byte-identical default menu). The
   *  composition root mints ONE `createFileHistoryStore()` (from
   *  `@/tool/file-history`) and passes it here ONLY when `QUANTA_FILE_HISTORY`
   *  is on — the SAME store it wires onto `AgentConfig.fileHistory` (so the
   *  write/edit capture sink records into exactly what this tool reads). The
   *  tool's FS writer is `ports.fs ?? defaultFileSystemPort` (the same jailed
   *  port write/edit use), so a restore is confined to cwd. */
  fileHistory?: FileHistoryStore
  /** CLUSTER D #5 — when set, append `permission_propose_pattern` (the model-
   *  facing RECORDING half of ADR-0061's remember-patterns seam). Absent ⇒ tool
   *  NOT registered (byte-identical default menu). The composition root wires a
   *  port adapting `@/permission`'s `recordProposedPattern` over a per-session
   *  `PatternGrantStore` ONLY when `QUANTA_REMEMBER_PATTERNS` is on AND it can
   *  construct the store. The duck-typed port keeps `@/tool` fence-clean; the
   *  no-widen / no-self-grant invariant is enforced inside the port (the tool
   *  routes EXCLUSIVELY through it, never a raw store write). */
  permissionPatternPropose?: PermissionPatternProposePort
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
  /** code-mode (RFC jun-6-code-mode, Phase 1) — when true, append the gated
   *  `code_cell` tool (run a model-authored JS program whose every `tools.X(args)`
   *  re-enters the REAL dispatchTool). Absent/false ⇒ tool NOT registered
   *  (byte-identical default menu; the QuickJS-WASM module is never instantiated,
   *  it is lazily imported only when the tool runs). The composition root passes
   *  this only when `QUANTA_CODE_MODE` is on AND it ALSO wires
   *  `AgentConfig.codeCellDispatchFactory` (the security binding from
   *  `@/agent/codemode-wire.ts`) — the tool reads its dispatch port from
   *  `ToolContext.codeCellDispatch` (surfaced by the dispatch seam from that
   *  factory); an unwired port yields a typed `not_wired` failure. */
  codeMode?: boolean
  /** G1 (RFC jun-6-appgen-appshot, Phase 1) — when set, append `appshot_verify`
   *  (the closed spec→scaffold→render→screenshot→LLM-judge verify loop). Absent
   *  ⇒ tool NOT registered (byte-identical default menu). The composition root
   *  passes a port wired to the real `BrowserPort` (render/screenshot) + an
   *  LLM-judge (verify) + the jailed scaffold writer, plus an injected clock
   *  (`now`), only when `QUANTA_APPSHOT` is on. ALL effects ride the injected
   *  port; the slice imports no `@/browser`/`@/agent`/`@/llm`. */
  appshot?: AppshotSlot
}

/** Host-wired appshot slot (G1) — the verify-loop port + injected clock + an
 *  OPTIONAL artifact sink. The composition root builds this; tests inject fakes. */
export interface AppshotSlot {
  readonly port: AppshotPort
  /** Injected clock — the ONLY time source (no `Date.now()` in-slice). */
  readonly now: () => number
  /** Optional artifact sink — when the artifact store is ALSO wired, the final
   *  scaffold is registered. Absent ⇒ no registration (byte-identical). */
  readonly artifactSink?: AppshotArtifactSink
}
