import { type AgentConfig, type MemoryToolsDeps, type MemoryWriteGuard, memoryTools } from "@/agent"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import { instrumentToolsForExport, type StructuredLogger } from "@/observability"
import type { OsSandboxProfile } from "@/runtime"
import { buildDefaultTools, type Tool, type ToolOrigin, ToolRegistry } from "@/tool"

/**
 * Surface-agnostic tooling assembly. The pre-split `internal.ts#buildTooling`
 * mixed THREE concerns:
 *   1. Build store + embedder from env (now {@link ../store}).
 *   2. Build memory/subagent/skill/breaker/verify configs from env (now
 *      ../{memory,subagent,skill,compaction,verify}).
 *   3. Wire those plus the opt-in tool arrays into a single `ToolRegistry`.
 *
 * This file is the third concern only — the surface layer (CLI shim, or a
 * future Web/Tauri surface) calls the per-builder cores above to get the
 * inputs, then calls {@link buildToolingCore} to wire everything.
 */

/** The memory store + tool registry + per-run config knobs, resolved once.
 *  Re-exported through the runner barrel so a future Web/Tauri surface
 *  depends on the slice contract, not a CLI-local shim. */
export interface Tooling {
  store: PersistentStorePort | undefined
  embedder: EmbedderPort | undefined
  sessionId: string
  registry: ToolRegistry
  searchPipeline?: AgentConfig["searchPipeline"]
  /** Per-session teardown for THE wire this tooling built (L5 M-11). The
   *  surface registers it on its session close stack so the delta-scan
   *  `setInterval` + indexer this session owns are released on session close —
   *  threaded per-session, NOT via a module singleton (so two concurrent
   *  sessions each dispose their OWN wire). Absent ⇒ no search wire was built
   *  (kill-switch / lexical-only), so nothing to tear down. */
  searchPipelineDispose?: () => void
  memoryConfig: AgentConfig["memory"] | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
}

/** Inputs to {@link buildToolingCore}. The surface resolves each field via
 *  the per-builder cores ({@link ../store}, {@link ../memory}, etc.) and the
 *  opt-in tool arrays via its own feature-loader. */
export interface ToolingAssembleInput {
  store: PersistentStorePort | undefined
  embedder: EmbedderPort | undefined
  /** Pre-minted session id (`crypto.randomUUID()` at the surface). Kept as an
   *  input so a Web/Tauri surface can mint the id off-thread and pass it
   *  through (e.g. for telemetry correlation). */
  sessionId: string
  memoryConfig: AgentConfig["memory"] | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
  /** Opt-in tool groups (MCP / LSP / git). The surface resolves each from its
   *  own input (env / settings) — `[]` ⇒ nothing appended (byte-identical). */
  mcpTools: Tool[]
  lspTools: Tool[]
  lspNavTools: Tool[]
  gitToolList: Tool[]
  /** Surface-owned caller-wired tools appended after the standard groups.
   *  Intended for productized facades like `search_codebase` whose concrete
   *  implementation depends on cwd/indexer lifecycle rather than a static
   *  default-tool constructor. */
  extraTools?: Tool[]
  /** Optional helper-only `SearchPipeline` slot the surface may thread into
   *  `AgentConfig` alongside `extraTools`. The loop does not read it directly;
   *  future retrieval-aware helpers can. */
  searchPipeline?: AgentConfig["searchPipeline"]
  /** Per-session teardown for the search wire the surface built (L5 M-11).
   *  The surface passes `searchWire.dispose` so the resulting `Tooling`
   *  carries the THIS-session disposer up to its close stack. Absent ⇒ no
   *  wire was built. */
  searchPipelineDispose?: () => void
  /** Structured logger for per-config gate logs. The shape mirrors the prior
   *  inline `slog.info(...)` calls in `internal.ts#buildTooling` 1:1. */
  slog: StructuredLogger
  /** Optional descriptor that lets the runner emit the same prior
   *  `memory on (kind=…, embed=…, session=…)` info line. The CLI shim passes
   *  `process.env.QUANTA_MEMORY`; absent ⇒ the line is suppressed (Web/Tauri
   *  surfaces typically prefer structured-only logs). */
  memoryKindLabel?: string | undefined
  /** Optional log sink for the `memory on (…)` line — same `console.info`-shaped
   *  signature as `@/shared#logger.info`. Absent ⇒ no log. Decouples this slice
   *  from `@/shared#logger` so a non-CLI surface can route it elsewhere. */
  onMemoryReady?: ((line: string) => void) | undefined
  /** ADR-0297 — operator-chosen OS sandbox profile, threaded through to the
   *  bash tool factory so its HITL tier closes over the closed-enum profile
   *  (NOT a command-string heuristic). Absent ⇒ conservative `always-confirm`
   *  default. CLI shim resolves via `resolveSandboxProfileFromEnv(process.env)`
   *  from `QUANTA_SANDBOX`; non-CLI surfaces pass directly. */
  sandboxProfile?: OsSandboxProfile | undefined
  /** ADR-0464 — when true, the structured per-file `apply_patch_structured`
   *  tool (self-correcting V4A apply) is appended to the default set. The
   *  SURFACE owns the env read (`QUANTA_ENABLE_STRUCTURED_PATCH`); this slice
   *  never touches `process.env`. Absent/false ⇒ byte-identical tool menu. */
  structuredPatch?: boolean | undefined
  /** ADR-0432 — live 0..100 remaining-budget signal for the self-edit memory
   *  write-guard. ONLY consulted when `memoryConfig.writeGuardMinRemainingPercent`
   *  is set. The surface supplies the closure over its `BudgetMeter`
   *  (ADR-0138); this slice never imports the budget module (hexagonal
   *  boundary). Absent + guard configured ⇒ the guard is inert (no meter ⇒ no
   *  block) so the write proceeds; absent + no guard ⇒ byte-identical. */
  budgetRemainingPercent?: (() => number) | undefined
  /** jul-03 B3 — live PROVIDER rate-limit remaining percentage (0..100), or
   *  `undefined` when the provider has not reported one. SEPARATE from the local
   *  cost fraction above: the surface supplies a closure over its live provider
   *  rate-limit source (`BudgetMeter.providerRateLimitRemainingPercent()` fed
   *  from `x-ratelimit-*` headers). ONLY consulted when the write-guard threshold
   *  is set. Absent ⇒ the provider arm is never armed (byte-identical to the
   *  cost-only guard); the memory slice never imports the budget module. */
  providerRateLimitRemainingPercent?: (() => number | undefined) | undefined
}

/** Assemble the tool registry and aggregate the per-run config dependencies.
 *
 * Behavior parity vs prior `internal.ts#buildTooling`:
 *   - Same tool-merge order plus caller extras:
 *     defaultTools → mcp → memory → lsp-diagnostics → lsp-nav → git → extra
 *     (last-write-wins via `ToolRegistry`'s Map).
 *   - Same memory-self-edit gate: registered only when a `store` exists and
 *     `memoryConfig.selfEditTools !== false`.
 *   - Same per-config gate logs (`slog.debug("subagent.on", …)` etc. — demoted
 *     to DEBUG jun-10: machine diagnostics, the welcome banner owns first paint).
 *   - Same optional `memory on (…)` info-line emission when both
 *     `memoryKindLabel` and `onMemoryReady` are supplied.
 *
 * When every opt-in tool array is empty and no config block is set, the
 * registry is byte-identical to a plain `new ToolRegistry(buildDefaultTools())`. */
/** L5 M-11 — the two search slots (helper-only `searchPipeline` + the
 *  per-session `searchPipelineDispose`) are prepared together so the
 *  `buildToolingCore` `return` carries a SINGLE spread (keeps that function
 *  under biome's cognitive-complexity cap). Each key is omitted when absent so
 *  `exactOptionalPropertyTypes` never sees a literal `undefined`. */
const buildSearchSlots = (
  input: Pick<ToolingAssembleInput, "searchPipeline" | "searchPipelineDispose">,
): Pick<Tooling, "searchPipeline" | "searchPipelineDispose"> => ({
  ...(input.searchPipeline !== undefined ? { searchPipeline: input.searchPipeline } : {}),
  ...(input.searchPipelineDispose !== undefined
    ? { searchPipelineDispose: input.searchPipelineDispose }
    : {}),
})

/** ADR-0432 — project the `AgentConfig.memory` extras (threadMode /
 *  lineCitations / write-guard threshold) into the matching
 *  {@link MemoryToolsDeps} slots. Each key is omitted when its config field is
 *  absent so `memoryTools` sees no literal `undefined` (exactOptionalPropertyTypes)
 *  AND the absent-config path is byte-identical to the legacy call.
 *
 *  The write-guard is only built when BOTH the threshold is set AND a live
 *  `remainingPercent` closure is supplied — keeping the budget signal injected
 *  (the memory slice never imports `@/agent/budget`). Threshold set but no
 *  closure ⇒ guard omitted ⇒ writes proceed (inert, fail-open). */
const buildMemoryExtras = (
  memoryConfig: AgentConfig["memory"] | undefined,
  budgetRemainingPercent: (() => number) | undefined,
  providerRateLimitRemainingPercent: (() => number | undefined) | undefined,
  slog: StructuredLogger,
): Pick<MemoryToolsDeps, "threadMode" | "lineCitations" | "writeGuard"> => {
  if (memoryConfig === undefined) return {}
  const guard: MemoryWriteGuard | undefined =
    memoryConfig.writeGuardMinRemainingPercent !== undefined && budgetRemainingPercent !== undefined
      ? {
          minRemainingPercent: memoryConfig.writeGuardMinRemainingPercent,
          remainingPercent: budgetRemainingPercent,
          // jul-03 B3 — thread the REAL provider rate-limit tap onto the guard,
          // SEPARATE from the local cost fraction. Omitted when absent so the
          // provider arm stays unarmed (byte-identical to the cost-only guard).
          ...(providerRateLimitRemainingPercent !== undefined
            ? { providerRateLimitRemainingPercent }
            : {}),
          // jul-03 B3 audit — wire the arm-state telemetry to the SAME
          // StructuredLogger the assembler uses for config-liveness (mirrors
          // `slog.debug("subagent.on", …)`). Without this the guard's fail-open
          // is silently inert in PRODUCTION (only tests passed `onArm`); emitting
          // it makes "provider arm unarmed / cost arm blocked" observable in a
          // real run. Only wired when the guard itself exists (byte-identical
          // when no threshold knob is set).
          onArm: (arm) => slog.debug("memory.write_guard.arm", { ...arm }),
        }
      : undefined
  return {
    ...(memoryConfig.threadMode !== undefined ? { threadMode: memoryConfig.threadMode } : {}),
    ...(memoryConfig.lineCitations !== undefined
      ? { lineCitations: memoryConfig.lineCitations }
      : {}),
    ...(guard !== undefined ? { writeGuard: guard } : {}),
  }
}

/** ADR-0471 Substrate-B — tag each tool by the SOURCE ARRAY it came from so a
 *  consumer (dispatch #2) derives provenance from the call site, not the name.
 *  Built ONCE here at assembly: `originOf` then does an O(1) read. Built-in +
 *  memory + subagent tools stay `builtin` (the registry default), so they are
 *  intentionally OMITTED from the map — the registry treats an absent name as
 *  `builtin`, keeping the OFF / no-opt-in path byte-identical. */
const buildOriginMap = (
  groups: ReadonlyArray<readonly [Tool[], ToolOrigin]>,
): ReadonlyMap<string, ToolOrigin> => {
  const map = new Map<string, ToolOrigin>()
  for (const [tools, origin] of groups) {
    for (const t of tools) map.set(t.name, origin)
  }
  return map
}

export const buildToolingCore = (input: ToolingAssembleInput): Tooling => {
  if (input.store && input.memoryKindLabel !== undefined && input.onMemoryReady !== undefined) {
    input.onMemoryReady(
      `memory on (kind=${input.memoryKindLabel}, embed=${input.embedder ? "on" : "off"}, session=${input.sessionId})`,
    )
  }
  if (input.subagentConfig) input.slog.debug("subagent.on", input.subagentConfig)
  if (input.skillsConfig) input.slog.debug("skills.on", input.skillsConfig)
  if (input.compactionBreakerConfig)
    input.slog.debug("compaction.breaker.config", input.compactionBreakerConfig)
  if (input.verifyGuardConfig) input.slog.debug("verify.guard.on", input.verifyGuardConfig)
  // Self-edit memory tools: only when a store exists and `memory.selfEditTools`
  // is not opted out.
  const memTools: Tool[] =
    input.store && input.memoryConfig?.selfEditTools !== false
      ? memoryTools({
          store: input.store,
          ...(input.embedder ? { embedder: input.embedder } : {}),
          ...buildMemoryExtras(
            input.memoryConfig,
            input.budgetRemainingPercent,
            input.providerRateLimitRemainingPercent,
            input.slog,
          ),
        })
      : []
  // Origin map tags only the non-builtin source arrays (mcp / lsp / git).
  // base + memory + subagent tools are `builtin` by the registry default — they
  // are deliberately not listed, so the map is empty when no opt-in group is
  // supplied and the origin surface is byte-identical to the legacy registry.
  const originMap = buildOriginMap([
    [input.mcpTools, "mcp"],
    [input.lspTools, "lsp"],
    [input.lspNavTools, "lsp"],
    [input.gitToolList, "git"],
  ])
  const registry = new ToolRegistry(
    // ADR-0268 metric egress: wrap each tool with a per-call counter+duration
    // instrument WHEN OTLP export is live (process-default metric sink set);
    // byte-identical (verbatim tools) otherwise. `instrumentTool` spreads the
    // tool so names are preserved — `originMap` (keyed by name) still matches.
    instrumentToolsForExport([
      ...buildDefaultTools({
        ...(input.sandboxProfile !== undefined ? { sandboxProfile: input.sandboxProfile } : {}),
        ...(input.structuredPatch === true ? { structuredPatch: true } : {}),
      }),
      ...input.mcpTools,
      ...memTools,
      ...input.lspTools,
      ...input.lspNavTools,
      ...input.gitToolList,
      ...(input.extraTools ?? []),
    ]),
    originMap,
  )
  return {
    store: input.store,
    embedder: input.embedder,
    sessionId: input.sessionId,
    registry,
    ...buildSearchSlots(input),
    memoryConfig: input.memoryConfig,
    subagentConfig: input.subagentConfig,
    skillsConfig: input.skillsConfig,
    compactionBreakerConfig: input.compactionBreakerConfig,
    verifyGuardConfig: input.verifyGuardConfig,
  }
}
