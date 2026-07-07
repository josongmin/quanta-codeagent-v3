/**
 * `host/runtime/agent-arg-builder/gated-tool-ports.ts` — extracted from
 * `agent-arg-builder.ts` (god-module split). The composition-root gated-tool
 * registry cluster: the hermetic {@link CompositionSeams}, the two SHARED
 * per-session slices (permission-pattern + file-history), the spread-ready slot
 * helpers, the gated `DefaultToolPorts` resolver ({@link buildGatedToolPorts}),
 * and the base {@link ToolRegistry} builder ({@link buildBaseRegistry}). Every
 * gate is `{}` when its knob is OFF so the assembled tool menu is byte-identical
 * to today's default-OFF path; the public surface is re-exported from
 * `agent-arg-builder.ts`.
 */

import { join as joinPath } from "node:path"
import { evidenceLspStatic, reflectConsultFromLLM } from "@/agent"
import { createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import type { LLMPort } from "@/llm"
import { instrumentToolsForExport } from "@/observability"
import { PatternGrantStore, recordProposedPattern } from "@/permission"
import type { buildSearchPipelineFromEnv } from "@/runner/assemble"
import type { resolveSandboxProfileFromEnv } from "@/runtime"
import type { AutomationEngineSlot } from "@/scheduler/runtime-wire"
import { gateOn, type PtyBackend, runtimeConfig } from "@/shared"
import {
  type AppshotPort,
  buildDefaultTools,
  createFileHistorySink,
  createFileHistoryStore,
  createProjectsKbStore,
  createTmuxAdapter,
  type DefaultToolPorts,
  type FileHistorySink,
  type FileHistoryStore,
  openAiImagePort,
  pollDeferredTool,
  type TmuxExec,
  type Tool,
  ToolRegistry,
} from "@/tool"
import { DefaultDeferredResultRegistry } from "@/tool/deferred/default-registry"
import { buildMcpConnectorDiscoveryPort } from "../mcp-connector-wire"
import { buildPtyBackend } from "../pty-backend"
import { sipsImageDownsamplePort } from "../sips-image-downsample"

/** Hermetic test seams for the composition root (mirrors the H7 `seams?`
 *  precedent on {@link AssembleRequest}). Absent ⇒ every wire uses its REAL
 *  composition-layer backend, so a caller that passes no seams (production +
 *  every existing test) gets a byte-identical `AgentConfig.base`. The shape is
 *  presence-only; the builders only ever consult a field when its gate is ALSO
 *  on, so an injected seam can never WIDEN the tool menu past what the knob
 *  already enabled — it only swaps the leaf effect (e.g. the `tmux` subprocess)
 *  for a deterministic fake. */
export interface CompositionSeams {
  /** N6 — replace the real `tmux` subprocess runner ({@link bunTmuxExec}) at the
   *  LEAF of the pty backend. Consulted ONLY when `QUANTA_PTY_ATTACH=1` already
   *  registered the 6 `pty_*` tools; the SAME production `createTmuxAdapter`
   *  (allow-prefix jail + `--` flag-injection guard) wraps it, so an e2e drives
   *  the entire composition + dispatch + permission path against a fake tmux. */
  ptyExec?: TmuxExec
  /** G1 — inject a complete {@link AppshotPort} (scaffold/render/screenshot/
   *  verify) at the appshot slot. Consulted ONLY when `QUANTA_APPSHOT=1` already
   *  gated the tool. In production the real port (BrowserPort render/screenshot +
   *  LLM-judge verify) is assembled in `agent-config-assembler` (where the
   *  BrowserPort actually lives); at THIS pre-assembler layer no BrowserPort is
   *  reachable, so the slot is minted ONLY when a host/e2e injects the port here.
   *  This drives the REAL `buildGatedToolPorts` registration + dispatch path
   *  against a deterministic fake — no Chrome, no network. */
  appshotPort?: AppshotPort
}

/** N6 — resolve the spread-ready `ptySession` slot (`{}` when the knob is OFF
 *  so the tool menu stays byte-identical). When ON, the leaf `tmux` runner is
 *  the real `bunTmuxExec` UNLESS a hermetic `seams.ptyExec` is injected, in
 *  which case the SAME production `createTmuxAdapter` (allow-prefix jail + `--`
 *  flag guard) wraps the fake — so an e2e drives the real adapter against a fake
 *  tmux. Extracted so the nested choice does NOT add to `buildGatedToolPorts`'s
 *  cognitive complexity. */
const resolvePtySessionSlot = (
  ptyAttach: boolean,
  ptyBackend: PtyBackend,
  seams: CompositionSeams | undefined,
): { ptySession: NonNullable<DefaultToolPorts["ptySession"]> } | Record<string, never> => {
  if (!ptyAttach) return {}
  const exec = seams?.ptyExec
  // A hermetic e2e seam ALWAYS drives the real tmux adapter against a fake tmux
  // (backend selection is irrelevant to that path). Otherwise route through the
  // QUANTA_PTY_BACKEND selector (tmux/bun/both — bun falls back to tmux when
  // Bun.Terminal is unavailable). The jail root is the workspace cwd.
  if (exec !== undefined) return { ptySession: createTmuxAdapter({ exec }) }
  return { ptySession: buildPtyBackend(ptyBackend, process.cwd()) }
}

/**
 * CLUSTER D #5 — the SHARED per-session permission slice (store + propose port).
 *
 * BASELINE-SEED RESIDUAL — CLOSED. The store is the SINGLE instance threaded to
 * BOTH consumers so the model can only refine what the USER already approved:
 *
 *   1. {@link buildBaseFromArgs} sets it on `AgentConfig.permissionPatternStore`,
 *      so the admissibility-gate's user-approval path (`cascadeOnApprove` →
 *      `grantAndCascade` → `store.grant(...)`) writes USER/POLICY-approved
 *      patterns INTO THIS store's `baseline`, and the gate's `autoPassByPatterns`
 *      reads coverage FROM the same store.
 *   2. {@link buildGatedToolPorts} wires `permission_propose_pattern` over the
 *      SAME store, so `recordProposedPattern`'s `isBaseline` check is meaningful:
 *      a model proposal is recorded ONLY when every pattern is in the baseline
 *      the gate grew via user approvals. The baseline is therefore seeded LIVE,
 *      at runtime, by the user — never fabricated from a guessed allow-list.
 *
 * SECURITY (load-bearing): the propose port writes via `recordProposed` (the
 * `allowed`-only, no-widen-gated half) — it NEVER calls `store.grant`, so a model
 * proposal can never seed the baseline (no self-grant, no chain-widen: a recorded
 * `allowed` pattern is not baseline, so refining IT is still `would_widen`).
 * Dangerous gating stays CLOSED (`allowDangerous: false`) — no operator opt-in
 * knob is wired here.
 *
 * Default-OFF: returns `undefined` unless `QUANTA_REMEMBER_PATTERNS === "1"`. The
 * store is allocated ONCE per `buildBaseFromArgs` call (per session) and reused by
 * both consumers — never two divergent empty-baseline stores.
 */
export interface PermissionPatternSlice {
  readonly store: PatternGrantStore
  readonly proposePort: {
    recordProposed: (input: {
      proposed: readonly string[]
      isMaybeDangerous?: boolean
    }) => ReturnType<typeof recordProposedPattern>
  }
}

export const resolvePermissionPatternSlice = (): PermissionPatternSlice | undefined => {
  if (runtimeConfig().rememberPatterns !== true) return undefined
  // CLUSTER D #5 residual — operator opt-in to RECORD dangerous-flagged
  // proposals. Default false ⇒ `allowDangerous: false` (a dangerous proposal is
  // always rejected, byte-identical). ON ⇒ `allowDangerous: true` lifts ONLY the
  // dangerous-gate. SECURITY: the no-widen gate inside `recordProposedPattern` is
  // independent of `allowDangerous`, so a dangerous-AND-uncovered proposal is
  // still `would_widen` rejected — the knob can NEVER seed a new capability.
  const allowDangerous = runtimeConfig().rememberPatternsDangerous === true
  // ONE per-session store. The gate grows its baseline via user approvals
  // (`store.grant`); the propose port refines within it via `recordProposed`.
  const store = new PatternGrantStore()
  return {
    store,
    proposePort: {
      recordProposed: (input: { proposed: readonly string[]; isMaybeDangerous?: boolean }) =>
        recordProposedPattern(
          store,
          {
            proposed: input.proposed,
            ...(input.isMaybeDangerous !== undefined
              ? { isMaybeDangerous: input.isMaybeDangerous }
              : {}),
          },
          // Dangerous-gate state from the operator knob; the no-widen gate is
          // unaffected (it always rejects an uncovered proposal).
          { allowDangerous },
        ),
    },
  }
}

/** file_history_rewind — the SHARED per-file snapshot slice. The store is the
 *  read side (`DefaultToolPorts.fileHistory`, backing `file_history_rewind`); the
 *  sink is the write side (`AgentConfig.fileHistory`, surfaced onto
 *  `ctx.fileHistory` so write/edit record each new file version into the SAME
 *  store). One store per session — both sides MUST share it, so we mint once
 *  here and thread both, exactly like the permission-pattern slice. */
export interface FileHistorySlice {
  readonly store: FileHistoryStore
  readonly sink: FileHistorySink
}

/** Mint the shared file-history slice when `QUANTA_FILE_HISTORY` is on (strict
 *  `=== "1"` via `runtimeConfig().fileHistory`). Absent ⇒ `undefined` ⇒ no store,
 *  no sink, no tool — byte-identical. Bounds default to the store's bounded ring
 *  (per-path version + byte cap); the injected clock is the real `Date.now`
 *  (the ONLY time source — no clock in the pure store). */
export const resolveFileHistorySlice = (): FileHistorySlice | undefined => {
  if (runtimeConfig().fileHistory !== true) return undefined
  const store = createFileHistoryStore({ now: () => Date.now() })
  return { store, sink: createFileHistorySink(store) }
}

/** A2 — mint the SHARED per-session artifact registry when `QUANTA_ARTIFACT_STORE`
 *  is on (strict gate via `gateOn`). The SAME instance is threaded into BOTH
 *  {@link buildGatedToolPorts} (backs the `artifact_*` tools + the appshot/office
 *  `artifactSink`) AND `base.artifactRegistry` (the capability bit + the turn
 *  runner's `artifact.ready` drain). Absent ⇒ `undefined` ⇒ capability false, no
 *  producer, tools omitted — byte-identical default-OFF. Real clock + monotonic
 *  id factory (the pure registry takes both injected). */
export const resolveArtifactRegistrySlice = (
  env: NodeJS.ProcessEnv,
): ReturnType<typeof createArtifactRegistry> | undefined =>
  gateOn(env, "QUANTA_ARTIFACT_STORE")
    ? createArtifactRegistry({ now: () => Date.now(), idFactory: monotonicIdFactory() })
    : undefined

/** A2 — the effective registry `buildGatedToolPorts` uses: the SHARED instance
 *  threaded from the composition root when present, else a gate-driven mint (the
 *  legacy byte-identical fallback for callers that do not share one). Extracted
 *  so the (shared × gate) choice adds no cognitive-complexity to the builder. */
const resolveEffectiveArtifactRegistry = (
  shared: ReturnType<typeof createArtifactRegistry> | undefined,
): ReturnType<typeof createArtifactRegistry> | undefined =>
  shared ?? resolveArtifactRegistrySlice(process.env)

/** A3 — resolve the spread-ready `projectsKb` slot (`{}` when the knob is OFF so
 *  the tool menu stays byte-identical). When `QUANTA_PROJECTS_KB` is on, mint ONE
 *  per-session `createProjectsKbStore()` (real `Date.now` clock + the store's own
 *  monotonic `pkb-<seq>` id factory + measure-first knob-DEFAULTED thresholds) and
 *  set it as `DefaultToolPorts.projectsKb.store`. The optional KB-namespace
 *  `SearchPipeline` is NOT reachable at this pre-assembler layer (like appshot's
 *  BrowserPort), so it is intentionally omitted — the tool falls back to the
 *  store's body-FREE lexical search (fail-soft), still leak-safe. Wiring the real
 *  KB-scoped pipeline where the retrieval index lives is the remaining
 *  adapter-assembly step (REPORTED). Extracted so the (knob × mint) choice adds no
 *  cognitive-complexity to `buildGatedToolPorts`. */
const resolveProjectsKbSlot = (
  env: NodeJS.ProcessEnv,
): { projectsKb: NonNullable<DefaultToolPorts["projectsKb"]> } | Record<string, never> =>
  gateOn(env, "QUANTA_PROJECTS_KB")
    ? { projectsKb: { store: createProjectsKbStore({ now: () => Date.now() }) } }
    : {}

/** Spread-ready `DefaultToolPorts.fileHistory` slot (the tool read side). `{}`
 *  when the slice is absent ⇒ `buildGatedToolPorts` literal carries no branch. */
const fileHistoryPortSlot = (
  slice: FileHistorySlice | undefined,
): { fileHistory: FileHistoryStore } | Record<string, never> =>
  slice !== undefined ? { fileHistory: slice.store } : {}

/** Spread-ready `AgentConfig.fileHistory` slot (the write/edit capture side).
 *  `{}` when off ⇒ the base literal carries no branch and `ctx.fileHistory` stays
 *  absent (capture is a no-op, byte-identical). */
export const fileHistorySinkSlot = (
  slice: FileHistorySlice | undefined,
): { fileHistory: FileHistorySink } | Record<string, never> =>
  slice !== undefined ? { fileHistory: slice.sink } : {}

/** Spread-ready `AgentConfig.permissionPatternStore` slot for the shared slice
 *  ({@link resolvePermissionPatternSlice}). `{}` when the slice is absent (knob
 *  OFF) ⇒ the base literal carries NO extra branch (keeps `buildBaseFromArgs`
 *  under biome's cognitive-complexity cap; mirrors `networkProxySlot` /
 *  `prewarmSlot`). Present ⇒ the gate reads/writes THE SAME store the propose
 *  tool received. */
export const permissionPatternStoreSlot = (
  slice: PermissionPatternSlice | undefined,
): { permissionPatternStore: PatternGrantStore } | Record<string, never> =>
  slice !== undefined ? { permissionPatternStore: slice.store } : {}

/** Spread-ready `DefaultToolPorts.permissionPatternPropose` slot. `{}` when the
 *  shared slice is absent (knob OFF / not threaded) ⇒ the gated-ports literal in
 *  {@link buildGatedToolPorts} carries NO extra branch (keeps that function under
 *  biome's cognitive-complexity cap; mirrors the other spread-ready slots).
 *  Present ⇒ the tool refines the SAME baseline the gate grows. */
const permissionProposePortSlot = (
  slice: PermissionPatternSlice | undefined,
): { permissionPatternPropose: PermissionPatternSlice["proposePort"] } | Record<string, never> =>
  slice !== undefined ? { permissionPatternPropose: slice.proposePort } : {}

export const buildGatedToolPorts = (
  env: NodeJS.ProcessEnv,
  seams?: CompositionSeams,
  /** CLUSTER D #5 — the SHARED permission slice built once by
   *  {@link buildBaseFromArgs} and threaded to BOTH the gate
   *  (`AgentConfig.permissionPatternStore`) and the propose tool here. Absent ⇒
   *  the `permission_propose_pattern` slot is omitted (byte-identical). NEVER
   *  construct a fresh store here — that would give the tool an empty baseline
   *  divergent from the gate's grown one. */
  permissionPatternSlice?: PermissionPatternSlice,
  /** file_history_rewind — the SHARED file-history slice minted by
   *  {@link buildBaseFromArgs}. The store half wires `file_history_rewind`;
   *  the SAME store's sink wires `AgentConfig.fileHistory` (write/edit capture).
   *  Absent ⇒ the tool slot is omitted (byte-identical). */
  fileHistorySlice?: FileHistorySlice,
  /** gap GAP 11 (ADR-0504) — the assembled main LLM, used to build the LLM-backed
   *  `reflect` port when `QUANTA_REFLECT` is on. `null` (no provider) ⇒ no reflect
   *  port ⇒ tool absent (byte-identical). */
  llm?: LLMPort | null,
  /** A2 — the SHARED per-session artifact registry, minted ONCE at the
   *  composition root ({@link resolveArtifactRegistrySlice}) so the SAME instance
   *  backs BOTH the tool ports here AND `base.artifactRegistry` (capability bit +
   *  turn-drain producer). Absent ⇒ this builder mints its own from the gate (the
   *  legacy byte-identical behaviour for callers that do not thread a shared
   *  instance). */
  sharedArtifactRegistry?: ReturnType<typeof createArtifactRegistry>,
): DefaultToolPorts => {
  const cfg = runtimeConfig()
  // C1/A2 — ONE per-session artifact registry when the Canvas store is enabled.
  // Prefer the SHARED instance threaded from the composition root (so the SAME
  // registry backs the capability bit + turn-drain); fall back to minting our own
  // from the gate for callers that do not thread one. Resolved by the extracted
  // helper so the (shared × gate) choice adds no complexity here. Absent ⇒ both
  // the `artifactRegistry` slot AND the appshot sink stay omitted (byte-identical).
  const artifactRegistry = resolveEffectiveArtifactRegistry(sharedArtifactRegistry)
  return {
    // ADR-0464 — gated structured-apply tool. Default-OFF: tool menu is
    // byte-identical unless QUANTA_ENABLE_STRUCTURED_PATCH === "1".
    ...(gateOn(process.env, "QUANTA_ENABLE_STRUCTURED_PATCH") ? { structuredPatch: true } : {}),
    // ADR-0165 — gated coverage_check tool. Default-OFF: tool menu is
    // byte-identical unless QUANTA_COVERAGE_TOOL === "1".
    ...(gateOn(process.env, "QUANTA_COVERAGE_TOOL") ? { coverageCheck: true } : {}),
    // C1 — gated artifact (Canvas) tools. Default-OFF: tool menu byte-identical
    // unless QUANTA_ARTIFACT_STORE === "1". Mints ONE per-session registry
    // (real clock + monotonic id factory) shared by the artifact_* tools.
    ...(artifactRegistry !== undefined ? { artifactRegistry } : {}),
    // CLUSTER D #5 — gated permission_propose_pattern tool over the SHARED
    // per-session store built by `buildBaseFromArgs` (BASELINE-SEED RESIDUAL
    // CLOSED). The SAME store backs `AgentConfig.permissionPatternStore`, so the
    // model can only refine patterns the USER already approved via the gate's
    // `store.grant(...)` path. We NEVER construct a fresh empty-baseline store
    // here. Spread-ready slot (`{}` when off ⇒ tool not registered ⇒
    // byte-identical).
    ...permissionProposePortSlot(permissionPatternSlice),
    // file_history_rewind — gated per-file snapshot list/restore tool over the
    // SHARED session store (the SAME store whose sink wires AgentConfig.fileHistory
    // so write/edit record into exactly what this tool reads). Default-OFF: `{}`
    // when QUANTA_FILE_HISTORY is off ⇒ tool not registered ⇒ byte-identical.
    ...fileHistoryPortSlot(fileHistorySlice),
    // N2 — gated MCP connector discovery tools (mcp_connector_list/_install).
    // Default-OFF: tool menu byte-identical unless QUANTA_MCP_CONNECTORS === "1".
    // The port lists the bundled reference catalog and installs a chosen server
    // into the project `.mcp.json` (QUANTA_MCP_CONFIG override, else cwd) via the
    // atomic merge writer — the same file `readMcpConfig` ingests next launch.
    ...(cfg.mcpConnectors
      ? {
          mcpConnectors: buildMcpConnectorDiscoveryPort({
            configPath:
              process.env.QUANTA_MCP_CONFIG?.trim() || joinPath(process.cwd(), ".mcp.json"),
          }),
        }
      : {}),
    // H14a — gated image_gen tool. Default-OFF: tool menu byte-identical unless
    // QUANTA_IMAGE_GEN === "1". The provider port is KEY-BOUND from the same
    // `OPENAI_API_KEY` the LLM factory reads (NEVER hardcoded); a key-less port
    // yields a typed `no_key` outcome rather than crashing, so wiring is always
    // safe. The OpenAI base-url / model knobs the factory honors are honored too.
    ...(cfg.imageGen
      ? {
          imageGen: openAiImagePort({
            ...(env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY !== ""
              ? { apiKey: env.OPENAI_API_KEY }
              : {}),
            ...(env.OPENAI_BASE_URL !== undefined && env.OPENAI_BASE_URL !== ""
              ? { baseUrl: env.OPENAI_BASE_URL }
              : {}),
          }),
        }
      : {}),
    // image downsample (gap GAP 1, ADR-0507) — gated macOS `sips`-backed codec so
    // read_image SHRINKS oversized images instead of rejecting. PLATFORM-BOUND
    // (darwin only) + default-OFF: absent ⇒ over-cap images rejected as before
    // (byte-identical). Non-macOS / gate-off ⇒ no port.
    ...(process.platform === "darwin" && gateOn(env, "QUANTA_IMAGE_DOWNSAMPLE")
      ? { imageDownsample: sipsImageDownsamplePort() }
      : {}),
    // reflect (gap GAP 11, ADR-0504) — gated LLM-backed self-correction tool.
    // Default-OFF: tool menu byte-identical unless QUANTA_REFLECT is on AND a real
    // LLM is present (a one-shot critique turn rides the main LLM, no tools offered).
    ...(llm != null && gateOn(env, "QUANTA_REFLECT")
      ? { reflect: reflectConsultFromLLM({ llm }) }
      : {}),
    // H14b — gated Office authoring tools (xlsx_write/docx_write/pptx_write).
    // Default-OFF: tool menu byte-identical unless QUANTA_OFFICE_AUTHORING === "1".
    // Boolean port — the tools serialize pure-TS OOXML + write through the same
    // FS-jail chokepoint the readers use; no adapter to construct.
    ...(cfg.officeAuthoring ? { officeAuthoring: true } : {}),
    // W6 (NotebookEdit P17) — gated `notebook_edit` cell editor. Default-OFF:
    // tool menu byte-identical unless QUANTA_NOTEBOOK_EDIT === "1". Pure editor
    // over the shared FS jail; boolean flag (no adapter to construct).
    ...(cfg.notebookEdit ? { notebookEdit: true } : {}),
    // W5 (DAP) — gated `debug_inspect` debugger tool. Default-OFF: tool menu
    // byte-identical unless QUANTA_DEBUG_TOOLS === "1". Boolean flag — the tool
    // owns the real spawn port; high-risk (always-confirm tier).
    ...(cfg.debugTools ? { debugTools: true } : {}),
    // Epic-2 — gated `run_tests` structured test-runner. Default-OFF: tool menu
    // byte-identical unless QUANTA_TEST_RUNNER === "1". High-risk (always-confirm).
    ...(cfg.testRunner ? { testRunner: true } : {}),
    // Keystone — gated `collect_evidence` (Evidence Packet Builder). Default-OFF
    // unless QUANTA_EVIDENCE === "1". The `lspStatic` enrichment port is wired
    // LIVE here from the LSP bridge (`evidenceLspStatic`), so the packet's
    // `static` section is real in production (not just test-local). DAP `runtime`
    // remains a follow-up port (test-under-debugger orchestration).
    ...(cfg.evidence ? { evidence: { lspStatic: evidenceLspStatic() } } : {}),
    // C2 — gated communicate_update tool. Default-OFF: tool menu byte-identical
    // unless QUANTA_PROGRESS_UPDATE === "1". Boolean port — the tool reads its
    // `ProgressSink` from `ctx.progressSink` (surfaced by the dispatch seam from
    // `AgentConfig.progressSink`); absent sink ⇒ a no-op + ok:true.
    ...(cfg.progressUpdate ? { progressUpdate: true } : {}),
    // code-mode (RFC jun-6-code-mode, Phase 1) — gated `code_cell` tool. Default-OFF:
    // tool menu byte-identical unless QUANTA_CODE_MODE === "1". The tool reads its
    // per-cell dispatch port from `ctx.codeCellDispatch` (surfaced by the dispatch
    // seam from `AgentConfig.codeCellDispatchFactory`, wired by
    // `wireOptionalAgentPorts`). The QuickJS-WASM module is lazily imported so the
    // OFF binary never instantiates it; an unwired factory ⇒ typed `not_wired`.
    // Slot extracted to a helper so this builder stays under the complexity cap.
    ...codeModePortSlot(cfg.codeMode),
    // N6 — gated pty_* tools (attach/list/write/read/resize/kill). Default-OFF:
    // tool menu byte-identical unless QUANTA_PTY_ATTACH === "1". The tmux backend
    // (`Bun.spawn(["tmux", …])`, argv-array, no shell) is constructed at the
    // composition layer (`pty-backend.ts`) and injected as the `PtySessionPort`;
    // construction is IO-free (no spawn until a pty tool dispatches). Resolved by
    // the extracted helper so the (knob × seam) choice adds no complexity here.
    ...resolvePtySessionSlot(cfg.ptyAttach, cfg.ptyBackend, seams),
    // G1 (RFC jun-6-appgen-appshot) — gated `appshot_verify` slot. Default-OFF:
    // tool menu byte-identical unless QUANTA_APPSHOT === "1". The slice's render/
    // screenshot arrows ride a real `BrowserPort`, which at THIS pre-assembler
    // layer is NOT reachable (the CDP browser is wired later in
    // `agent-config-assembler` only when a system Chrome exists). So the slot is
    // minted ONLY when a host/e2e injects a complete `seams.appshotPort` here;
    // production assembly of the BrowserPort+LLM-judge-backed port is the
    // remaining adapter-assembly step (REPORTED). When minted, the injected clock
    // is the real `Date.now` and — when the artifact store is ALSO on — the SAME
    // registry is the artifact sink (final scaffold registered as a Canvas item).
    ...resolveAppshotSlot(cfg.appshot, seams, artifactRegistry),
    // A3 (Projects knowledge-base) — gated `projects_kb` context-offloading tool.
    // Default-OFF: tool menu byte-identical unless QUANTA_PROJECTS_KB is on. Mints
    // ONE per-session KB store (real clock; the store owns its bounded oldest-
    // evicted ring + measure-first byte thresholds). The optional KB-namespace
    // SearchPipeline is not reachable at this layer ⇒ omitted (lexical fallback).
    // The "never enters context" invariant lives in the tool (project_write
    // returns ONLY metadata). Resolved by the extracted helper so the (knob × mint)
    // choice adds no complexity here.
    ...resolveProjectsKbSlot(env),
  }
}

/** code-mode (RFC jun-6-code-mode, Phase 1) — spread-ready `code_cell` tool slot.
 *  `{}` when `QUANTA_CODE_MODE` is off ⇒ tool not registered ⇒ byte-identical menu
 *  AND the QuickJS-WASM module never instantiated. Extracted so `buildGatedToolPorts`
 *  stays under biome's cognitive-complexity cap. */
const codeModePortSlot = (codeMode: boolean): { codeMode: true } | Record<string, never> =>
  codeMode ? { codeMode: true } : {}

/** G1 — resolve the spread-ready `appshot` slot (`{}` when the knob is OFF or no
 *  port is injectable, so the tool menu stays byte-identical). When ON AND a
 *  complete {@link AppshotPort} is injected (`seams.appshotPort`), mint the slot
 *  with the real `Date.now` clock and — when the Canvas registry is present — the
 *  SAME registry as the artifact sink. Extracted so the (knob × seam × registry)
 *  choice adds no complexity to `buildGatedToolPorts`. */
const resolveAppshotSlot = (
  appshot: boolean,
  seams: CompositionSeams | undefined,
  artifactRegistry: ReturnType<typeof createArtifactRegistry> | undefined,
): { appshot: NonNullable<DefaultToolPorts["appshot"]> } | Record<string, never> => {
  if (!appshot) return {}
  const port = seams?.appshotPort
  // No BrowserPort+judge-backed port is reachable at this layer in production; a
  // host/e2e may inject one. Absent ⇒ slot omitted (byte-identical) — the
  // remaining step is to assemble the real port where the BrowserPort lives.
  if (port === undefined) return {}
  return {
    appshot: {
      port,
      now: () => Date.now(),
      ...(artifactRegistry !== undefined ? { artifactSink: artifactRegistry } : {}),
    },
  }
}

export const buildBaseRegistry = (args: {
  readonly env: NodeJS.ProcessEnv
  readonly automationSlot: AutomationEngineSlot | null
  readonly sandboxProfile: ReturnType<typeof resolveSandboxProfileFromEnv>
  readonly searchWire: ReturnType<typeof buildSearchPipelineFromEnv>
  /** Required key, value MAY be `undefined` (no conditional spread at the call
   *  site ⇒ no added branch). Absent ⇒ every gated port uses its real backend. */
  readonly seams: CompositionSeams | undefined
  /** CLUSTER D #5 — the SHARED permission slice (store + propose port) so the
   *  `permission_propose_pattern` tool refines the SAME baseline the gate grows
   *  via `AgentConfig.permissionPatternStore`. Absent ⇒ tool omitted. */
  readonly permissionPatternSlice: PermissionPatternSlice | undefined
  /** file_history_rewind — the SHARED file-history slice; its store half wires
   *  `file_history_rewind` here (the sink half wires `AgentConfig.fileHistory`).
   *  Absent ⇒ the tool is omitted (byte-identical). */
  readonly fileHistorySlice: FileHistorySlice | undefined
  /** gap GAP 11 (ADR-0504) — assembled main LLM for the gated `reflect` port.
   *  `null` ⇒ no reflect port (byte-identical). */
  readonly llm: LLMPort | null
  /** A2 — the SHARED per-session artifact registry ({@link resolveArtifactRegistrySlice}),
   *  threaded so the tool ports here AND `base.artifactRegistry` reference the SAME
   *  instance. Absent ⇒ `buildGatedToolPorts` falls back to its gate-driven mint
   *  (byte-identical for callers that do not share one). */
  readonly artifactRegistry: ReturnType<typeof createArtifactRegistry> | undefined
}): ToolRegistry =>
  // ADR-0268 metric egress — wrap tools with per-call instruments WHEN OTLP
  // export is live (process-default metric sink set); byte-identical otherwise.
  new ToolRegistry(
    instrumentToolsForExport([
      ...buildDefaultTools({
        ...(args.automationSlot !== null ? { automationEngine: args.automationSlot.engine } : {}),
        ...(args.sandboxProfile !== undefined ? { sandboxProfile: args.sandboxProfile } : {}),
        ...buildGatedToolPorts(
          args.env,
          args.seams,
          args.permissionPatternSlice,
          args.fileHistorySlice,
          args.llm,
          args.artifactRegistry,
        ),
      }),
      ...(args.searchWire !== null ? [args.searchWire.tool] : []),
      // ADR-0287 — async-tools `poll_deferred`. Default-OFF: registered ONLY when
      // `runtimeConfig().asyncTools` is true (QUANTA_ASYNC_TOOLS). Without it the
      // registry is byte-identical and the LLM never sees the tool. The
      // `DefaultDeferredResultRegistry` is bounded by `runtimeConfig().deferredCap`
      // (QUANTA_DEFERRED_CAP) so a long session cannot grow the handle map
      // unbounded; the tool closes over THIS registry instance — the same one a
      // future `defineToolAsync` caller would register deferred work into.
      ...buildAsyncDeferredTools().tools,
    ]),
  )

/** ADR-0287 — build the `poll_deferred` tool over a freshly-constructed
 *  {@link DefaultDeferredResultRegistry} when async-tools are enabled. Returns
 *  `{ tools, asyncDeferredRegistry }`: `tools` contains the `poll_deferred` tool
 *  (empty when OFF); `asyncDeferredRegistry` is the SHARED instance the tool was
 *  built from (undefined when OFF). Hoisting the registry as a named field lets a
 *  future `defineToolAsync` producer share the SAME instance (B5: prevents two
 *  independent mints that would make poll_deferred miss producer handles).
 *  Default-OFF byte-identical path: `tools === []`, `asyncDeferredRegistry === undefined`. */
const buildAsyncDeferredTools = (): {
  tools: Tool[]
  asyncDeferredRegistry: DefaultDeferredResultRegistry | undefined
} => {
  const cfg = runtimeConfig()
  if (!cfg.asyncTools) return { tools: [], asyncDeferredRegistry: undefined }
  // B5 (shared-registry hoist): name the registry `asyncDeferredRegistry` so the
  // call-site destructuring `const { tools, asyncDeferredRegistry } = buildAsyncDeferredTools()`
  // exposes the SAME instance to any future `defineToolAsync` producer — preventing
  // two independent `new DefaultDeferredResultRegistry()` mints that would make
  // poll_deferred unable to find producer-registered handles.
  const asyncDeferredRegistry = new DefaultDeferredResultRegistry(
    cfg.deferredCap !== undefined ? { cap: cfg.deferredCap } : {},
  )
  return { tools: [pollDeferredTool(asyncDeferredRegistry) as Tool], asyncDeferredRegistry }
}
