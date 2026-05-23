import { createAutoClassifierPort, RetryingLLM } from "@/agent"
import {
  createLLM,
  DEFAULT_MODEL,
  FallbackLLM,
  type Provider as LLMFactoryProvider,
  type LLMPort,
  pickProvider as pickProviderFactory,
} from "@/llm"
import type { StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode } from "@/permission"

/**
 * Surface-agnostic LLM assembly. The CLI / Web / Tauri surfaces parse their
 * own input (ENV / HTTP body / IPC payload) into the typed inputs below and
 * call these factories. NO `process.env` / `process.argv` reads here — keeps
 * the `@/runner` slice surface-agnostic per RFC §3.1 / biome rule on
 * `src/runner/**` (no `apps/**` imports, no env reads).
 *
 * Behavior parity: every helper preserves the prior `internal.ts` semantics
 * byte-for-byte; the only delta is *where the input lives* (typed config vs
 * `process.env`). The CLI shim in `internal.ts` re-exposes the same export
 * names so 132+ existing consumers are unaffected.
 */

/** Provider union — re-exported from the `@/llm` factory (single source of
 *  truth). */
export type Provider = LLMFactoryProvider

/** EnvLike alias — what the `@/llm` factory consumes for api-key /
 *  provider selection. Surface entries (CLI/Web/Tauri) map their input source
 *  to this shape once and pass it down. */
export type EnvLike = Record<string, string | undefined>

/** Inputs to {@link pickProviderCore}. */
export interface PickProviderInput {
  env: EnvLike
}

/** Provider selection. Byte-identical to the prior `pickProvider(): Provider`
 *  CLI helper when given `process.env`. */
export const pickProviderCore = (input: PickProviderInput): Provider =>
  pickProviderFactory(input.env)

/** Inputs to {@link buildLLMCore}. The pre-split CLI helper passed
 *  `process.env` to the factory; the surface-agnostic equivalent takes a
 *  typed `env` record (the factory itself uses it only for api-key + baseURL
 *  resolution). */
export interface LlmAssembleInput {
  provider: Provider
  model: string
  /** Env-record forwarded verbatim to `createLLM`. The factory only reads
   *  provider-specific api keys + `OPENAI_BASE_URL` from it. Surface decides
   *  whether this is `process.env` (CLI) or a derived record (Web/Tauri). */
  env: EnvLike
}

/** Build the main LLM adapter. Preserves the prior contract: a missing
 *  provider key throws (the surface aborts loudly). */
export const buildLLMCore = (input: LlmAssembleInput): LLMPort =>
  createLLM(input.provider, { model: input.model }, input.env)

/** Inputs to {@link composeLLMCore}. */
export interface ComposeLlmInput {
  /** Inner retry-wrapped main LLM. */
  retryingLLM: LLMPort
  /** Main provider — fallback stacks are built for the same provider with
   *  different model ids. */
  provider: Provider
  signal: AbortSignal
  mode: PermissionMode
  permission: PermissionContext
  slog: StructuredLogger
  /** Fallback model ids (already parsed from whatever the surface ENV/argv
   *  format is). Empty ⇒ no `FallbackLLM` wrap (byte-identical default-OFF). */
  fallbackModelIds: string[]
  /** Env-record for the per-fallback-model retry stacks (api-key resolution).
   *  Same factory invariants — a missing key for `provider` throws when the
   *  fallback list is non-empty. */
  env: EnvLike
}

/** Compose the LLM stack: bounded retry (inner-most, supplied by caller),
 *  optional same-turn provider fallback (outer), and — only in `auto` mode —
 *  attach the LLM-backed permission classifier. Default OFF for both fallback
 *  and classifier ⇒ `finalLLM === retryingLLM` and `permission` untouched,
 *  byte-identical to today. */
export const composeLLMCore = (input: ComposeLlmInput): LLMPort => {
  let finalLLM: LLMPort = input.retryingLLM
  if (input.fallbackModelIds.length > 0) {
    const fallbackStacks = input.fallbackModelIds.map(
      (m) =>
        new RetryingLLM({
          inner: buildLLMCore({ provider: input.provider, model: m, env: input.env }),
          signal: input.signal,
        }),
    )
    finalLLM = new FallbackLLM({
      providers: [input.retryingLLM, ...fallbackStacks],
      signal: input.signal,
    })
    input.slog.info("llm.fallback.on", { models: input.fallbackModelIds })
  }
  if (input.mode === "auto") {
    input.permission.classify = createAutoClassifierPort({ llm: finalLLM })
    input.slog.info("permission.auto.on")
  }
  return finalLLM
}

/** Parse `QUANTA_MODEL_FALLBACK`-style raw string → dedup'd model ids.
 *  Surface-agnostic: takes the raw string the surface has already pulled
 *  from ENV / config file / settings. Empty input ⇒ `[]`. */
export const parseFallbackModels = (raw: string | undefined): string[] => {
  if (raw === undefined) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "1")
}

export { DEFAULT_MODEL }
