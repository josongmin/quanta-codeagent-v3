/**
 * `@/runner/assemble` — surface-agnostic factories that turn plain typed
 * config into built collaborators (LLM, Store, Memory, …) for the agent loop.
 *
 * SLICE INVARIANT: NONE of these read `process.env` / `process.argv`. The
 * surface entry (CLI/Web/Tauri) maps its own input source (ENV / HTTP / IPC)
 * to the typed input first, then calls the factory. This is what lets the
 * same builders back a future Web/Tauri front end without a fork.
 *
 * See also the biome rule on `src/runner/**` — `apps/**` imports are forbidden,
 * and so are `@/rules` / `@/patch` / `@/migration` (they reach this slice via
 * `@/agent`).
 */

export {
  buildCompactionBreakerConfigCore,
  buildSummarizerLlmCore,
  type CompactionBreakerAssembleInput,
  type SummarizerLlmAssembleInput,
} from "./compaction"
/** {@link assembleConfig} — pure composer that turns built collaborators +
 *  message history into the immutable per-turn `AgentConfig`. Distinct from
 *  the `build*Core` factory family, which each instantiate ONE collaborator;
 *  see the JSDoc on `assembleConfig` for the "assemble" vs "build" rationale. */
export {
  assembleConfig,
  compactionDep,
  type SessionDeps,
} from "./config"
export {
  buildLLMCore,
  type ComposeLlmInput,
  composeLLMCore,
  DEFAULT_MODEL,
  type EnvLike,
  type LlmAssembleInput,
  type PickProviderInput,
  type Provider,
  parseFallbackModels,
  pickProviderCore,
} from "./llm"
export {
  buildMemoryConfigCore,
  type MemoryConfigAssembleInput,
  parseRecallTiers,
} from "./memory"
export {
  buildSkillsConfigCore,
  type SkillsConfigAssembleInput,
} from "./skill"
export {
  buildEmbedderCore,
  buildStoreCore,
  type EmbedderAssembleInput,
  type StoreAssembleInput,
} from "./store"
export {
  buildStreamingCore,
  type StreamingAssembleInput,
  type StreamingResult,
} from "./streaming"
export {
  buildSubagentConfigCore,
  type SubagentConfigAssembleInput,
} from "./subagent"
export {
  buildToolingCore,
  type Tooling,
  type ToolingAssembleInput,
} from "./tooling"
export {
  buildVerifyGuardConfigCore,
  type VerifyGuardConfigAssembleInput,
} from "./verify"
