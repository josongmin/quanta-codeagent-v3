import type { AgentConfig } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"

/**
 * Per-turn `AgentConfig` assembly — extracted from `internal.ts` (ADR-0024
 * split). PURE composition: every conditional default-OFF spread is preserved
 * verbatim from the prior inline block. The function reads NO env/argv — the
 * caller resolves all knobs (provider, persona-derived `system`, store, etc.)
 * via the env accessors that stay in `internal.ts` and passes them as
 * {@link SessionDeps}.
 *
 * `internal.ts` re-exports every symbol here so existing importers
 * (`index.ts`, tests) are unaffected.
 */

/** Inputs the per-turn `AgentConfig` is assembled from. Grouping the optional
 *  default-OFF knobs keeps `assembleConfig` a single cohesive site and lifts
 *  the conditional-spread chain out of `main`. */
export interface SessionDeps {
  llm: LLMPort
  registry: ToolRegistry
  stream: StreamPort
  permission: PermissionContext
  /** Already-built system prompt (`buildSystemPrompt(cwd, { persona })`).
   *  Resolved by the caller so this module stays env-free (the persona is
   *  read from env in `internal.ts#pickPersona`). */
  system: string
  cwd: string
  maxTurns: number
  signal: AbortSignal
  onConfirm: (action: ToolAction) => Promise<boolean>
  store: PersistentStorePort | undefined
  sessionId: string
  embedder: EmbedderPort | undefined
  memoryConfig: AgentConfig["memory"] | undefined
  planMode: boolean
  metrics: Metrics | undefined
  run: RunContext | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
  summarizerLlm: LLMPort | undefined
  /** ADR-0081 shell-output-delta observer composed by the CLI surface
   *  (painter + OTel exporter). Absent ⇒ runShell stays on its legacy
   *  buffered path (byte-identical). */
  onShellEvent: AgentConfig["onShellEvent"] | undefined
  /** ADR-0064 L4 per-turn work-metrics sink. The CLI builds a default
   *  stderr-summary sink gated on the `QUANTA_METRICS` knob (same gate as the
   *  cost dashboard). Absent ⇒ the loop allocates no collector and emits
   *  nothing (byte-identical default-OFF). */
  workMetricsSink: AgentConfig["workMetricsSink"] | undefined
}

/** Compaction config dependency. Present when memory/store is on (preserving
 *  the prior `compaction: {}` default) OR a dedicated summarizer model is set;
 *  carries `summarizerLlm` when configured. Absent when neither ⇒ omitted
 *  entirely (byte-identical to the pre-knob default path). */
export const compactionDep = (d: {
  store: PersistentStorePort | undefined
  summarizerLlm: LLMPort | undefined
}): AgentConfig["compaction"] | undefined => {
  if (!d.store && !d.summarizerLlm) return undefined
  return d.summarizerLlm ? { summarizerLlm: d.summarizerLlm } : {}
}

/** The memory store + tool registry + per-run config knobs, resolved once.
 *  PURE type alias — `buildTooling` (the producer) stays in `internal.ts` next
 *  to the env reads that drive it. */
export interface Tooling {
  store: PersistentStorePort | undefined
  embedder: EmbedderPort | undefined
  sessionId: string
  registry: ToolRegistry
  memoryConfig: AgentConfig["memory"] | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
}

/** Assemble the per-turn `AgentConfig`. Every conditional spread is preserved
 *  verbatim (same keys, same gating) — this is a pure relocation so the wired
 *  knobs are byte-identical; it only moves the chain off `main`/`session`. */
export const assembleConfig = (messages: Message[], d: SessionDeps): AgentConfig => {
  const compaction = compactionDep(d)
  return {
    llm: d.llm,
    registry: d.registry,
    stream: d.stream,
    permission: d.permission,
    messages,
    system: d.system,
    cwd: d.cwd,
    maxTurns: d.maxTurns,
    signal: d.signal,
    onConfirm: d.onConfirm,
    // Store/sessionId gated on memory; compaction is now decoupled so a
    // dedicated summarizer model works without a store. Store-only ⇒
    // `compaction: {}` exactly as before (byte-identical).
    ...(d.store ? { store: d.store, sessionId: d.sessionId } : {}),
    ...(compaction ? { compaction } : {}),
    ...(d.embedder ? { embedder: d.embedder } : {}),
    ...(d.memoryConfig ? { memory: d.memoryConfig } : {}),
    ...(d.planMode ? { planMode: true } : {}),
    ...(d.metrics ? { metrics: d.metrics } : {}),
    ...(d.run ? { run: d.run } : {}),
    ...(d.subagentConfig ? { subagent: d.subagentConfig } : {}),
    ...(d.skillsConfig ? { skills: d.skillsConfig } : {}),
    ...(d.compactionBreakerConfig ? { compactionBreaker: d.compactionBreakerConfig } : {}),
    ...(d.verifyGuardConfig ? { verifyGuard: d.verifyGuardConfig } : {}),
    ...(d.onShellEvent !== undefined ? { onShellEvent: d.onShellEvent } : {}),
    ...(d.workMetricsSink !== undefined ? { workMetricsSink: d.workMetricsSink } : {}),
  }
}
