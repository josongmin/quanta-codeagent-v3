import { type AgentConfig, memoryTools } from "@/agent"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { StructuredLogger } from "@/observability"
import type { OsSandboxProfile } from "@/runtime"
import { buildDefaultTools, type Tool, ToolRegistry } from "@/tool"

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
}

/** Assemble the tool registry and aggregate the per-run config dependencies.
 *
 * Behavior parity vs prior `internal.ts#buildTooling`:
 *   - Same tool-merge order plus caller extras:
 *     defaultTools → mcp → memory → lsp-diagnostics → lsp-nav → git → extra
 *     (last-write-wins via `ToolRegistry`'s Map).
 *   - Same memory-self-edit gate: registered only when a `store` exists and
 *     `memoryConfig.selfEditTools !== false`.
 *   - Same per-config gate logs (`slog.info("subagent.on", …)` etc.).
 *   - Same optional `memory on (…)` info-line emission when both
 *     `memoryKindLabel` and `onMemoryReady` are supplied.
 *
 * When every opt-in tool array is empty and no config block is set, the
 * registry is byte-identical to a plain `new ToolRegistry(buildDefaultTools())`. */
export const buildToolingCore = (input: ToolingAssembleInput): Tooling => {
  if (input.store && input.memoryKindLabel !== undefined && input.onMemoryReady !== undefined) {
    input.onMemoryReady(
      `memory on (kind=${input.memoryKindLabel}, embed=${input.embedder ? "on" : "off"}, session=${input.sessionId})`,
    )
  }
  if (input.subagentConfig) input.slog.info("subagent.on", input.subagentConfig)
  if (input.skillsConfig) input.slog.info("skills.on", input.skillsConfig)
  if (input.compactionBreakerConfig)
    input.slog.info("compaction.breaker.config", input.compactionBreakerConfig)
  if (input.verifyGuardConfig) input.slog.info("verify.guard.on", input.verifyGuardConfig)
  // Self-edit memory tools: only when a store exists and `memory.selfEditTools`
  // is not opted out.
  const memTools: Tool[] =
    input.store && input.memoryConfig?.selfEditTools !== false
      ? memoryTools({
          store: input.store,
          ...(input.embedder ? { embedder: input.embedder } : {}),
        })
      : []
  const registry = new ToolRegistry([
    ...buildDefaultTools(
      input.sandboxProfile !== undefined ? { sandboxProfile: input.sandboxProfile } : {},
    ),
    ...input.mcpTools,
    ...memTools,
    ...input.lspTools,
    ...input.lspNavTools,
    ...input.gitToolList,
    ...(input.extraTools ?? []),
  ])
  return {
    store: input.store,
    embedder: input.embedder,
    sessionId: input.sessionId,
    registry,
    ...(input.searchPipeline !== undefined ? { searchPipeline: input.searchPipeline } : {}),
    memoryConfig: input.memoryConfig,
    subagentConfig: input.subagentConfig,
    skillsConfig: input.skillsConfig,
    compactionBreakerConfig: input.compactionBreakerConfig,
    verifyGuardConfig: input.verifyGuardConfig,
  }
}
