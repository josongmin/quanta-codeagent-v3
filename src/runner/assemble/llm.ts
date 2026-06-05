import { createAutoClassifierPort, RetryingLLM } from "@/agent"
import {
  type CreateMulticloudOptions,
  type CredentialSource,
  createCredentialSource,
  createLLM,
  createMulticloudLLM,
  DEFAULT_MODEL,
  FallbackLLM,
  type FallbackMetricSink,
  type Provider as LLMFactoryProvider,
  type LLMPort,
  pickProvider as pickProviderFactory,
  type ShellExecResult,
  withLiveUsage,
} from "@/llm"
import type { StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode } from "@/permission"
import { runShell } from "@/runtime"

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
  /** Optional metrics sink — wired into the `FallbackLLM` so that swap /
   *  attempt / exhausted counters are emitted to the same registry the rest
   *  of the agent uses. Default-OFF: when omitted the wrapper falls back to
   *  its internal noop sink (byte-identical to the pre-instrumentation
   *  decorator). Structural typing — a `MetricsRegistry` from
   *  `@/observability/metrics` satisfies the shape without coupling. */
  fallbackMetrics?: FallbackMetricSink
  /** Default-OFF live output-token meter (the rising "· N tokens" spinner
   *  counter). When `true`, the composed stack is wrapped OUTERMOST with
   *  {@link withLiveUsage} so it observes the fully-normalized event stream
   *  (including `stream_reset` from fallback) and emits `output_progress`. The
   *  surface ties this to its UI being able to render it — the CLI passes
   *  `true` only when the turn-indicator is enabled (interactive TTY). When
   *  omitted / `false` the stack is byte-identical. NOTE: applied AFTER the
   *  `auto` classifier is attached, so the classifier's internal calls use the
   *  un-wrapped port and never emit progress. */
  liveUsage?: boolean
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
      ...(input.fallbackMetrics !== undefined ? { metrics: input.fallbackMetrics } : {}),
    })
    input.slog.info("llm.fallback.on", { models: input.fallbackModelIds })
  }
  if (input.mode === "auto") {
    input.permission.classify = createAutoClassifierPort({ llm: finalLLM })
    input.slog.info("permission.auto.on")
  }
  // Outermost wrap: live output-token meter. Placed AFTER the classifier so
  // the classifier's internal calls use the un-wrapped port (no stray
  // `output_progress` from permission classification). Identity when OFF.
  if (input.liveUsage === true) {
    finalLLM = withLiveUsage(finalLLM, { enabled: true })
    input.slog.info("llm.live_usage.on")
  }
  return finalLLM
}

// ─────────────────── H7 — rotating cloud credentials (knob-read) ────────────
//
// The FINAL composition-root step that makes the proven `createMulticloudLLM`
// credentialSource INJECTION SEAM live end-to-end. The `@/llm` slice is
// closed-port (imports only `@/shared`), so the executable shell + the trust
// predicate are dependency-injected HERE — `@/runner` is allowed to reach
// `@/runtime` (`runShell`) and `@/permission`, so this is the correct seam to
// wire the real ports the helper expects.
//
// SECURITY — a credential helper / `*AuthRefresh` is ARBITRARY COMMAND
// EXECUTION, so the source is built ONLY when (a) at least one H7 knob is set
// AND (b) the workspace is trusted (the injected `isTrusted` predicate). The
// predicate FAILS CLOSED: an unconfigured / untrusted environment yields a
// source whose `isTrusted()` is `false`, so the helper module refuses to shell
// out and surfaces a typed `untrusted` decline — it never silently runs an
// operator-supplied command in an untrusted workspace.
//
// DEFAULT-OFF BYTE-IDENTITY — when no H7 knob is set, {@link buildCredentialSource}
// returns `undefined`, {@link buildMulticloudLLMCore} passes NO `credentialSource`,
// and the Bedrock/Vertex adapters shell ZERO times (byte-identical to the
// pre-H7 SDK default credential chain). The four legacy providers are never
// routed here at all.

/** The four H7 knobs the composition root reads off `runtimeConfig()` and the
 *  trust signal. A SUBSET of `RuntimeConfig` (the surface passes only the H7
 *  fields) plus the injected trust predicate + clock — this keeps `@/runner`
 *  free of a direct `process.env` read (the surface owns that via
 *  `runtimeConfig()`) and free of a bare `Date.now()` in the cred path. */
export interface CredentialSourceInput {
  /** `QUANTA_API_KEY_HELPER` — mint command. Absent ⇒ no mint capability. */
  apiKeyHelper: string | undefined
  /** `QUANTA_API_KEY_HELPER_TTL_MS` — TTL for mint cache + refresh throttle. */
  apiKeyHelperTtlMs: number | undefined
  /** `QUANTA_AWS_AUTH_REFRESH` — Bedrock pre-call refresh command. */
  awsAuthRefresh: string | undefined
  /** `QUANTA_GCP_AUTH_REFRESH` — Vertex pre-call refresh command. */
  gcpAuthRefresh: string | undefined
  /** Injected workspace-trust predicate. A shell-command credential helper is
   *  arbitrary code execution, so the source refuses to shell out unless this
   *  returns `true`. MUST fail closed: an unconfigured surface passes a
   *  predicate that returns `false` ⇒ typed `untrusted` decline, never a run.
   *  The surface wires the real trust check (`@/permission`). */
  isTrusted: () => boolean
  /** Injected clock for the TTL cache (no bare `Date.now()` in the cred path).
   *  Absent ⇒ `Date.now` (the composition root owns wall-clock policy). */
  now?: () => number
  /** Injected shell-exec port — TEST SEAM. Production omits ⇒ the real
   *  `runShell(command, { inheritEnv: true })` is used (the helper needs the
   *  parent env to find `aws`/`gcloud` + their cred files; this is the
   *  operator's explicit, trust-gated opt-in). */
  shellExec?: (command: string) => Promise<ShellExecResult>
}

/** The real shell closure handed to the credential helper. `inheritEnv: true`
 *  is REQUIRED so the helper finds `aws`/`gcloud` and their on-disk credential
 *  files — this is the operator's explicit, trust-gated opt-in (the source only
 *  reaches this after `isTrusted()` returns true). Maps `ShellResult` →
 *  `ShellExecResult` (structural subset; drops `timedOut`). */
const realShellExec = async (command: string): Promise<ShellExecResult> => {
  const r = await runShell(command, { inheritEnv: true })
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

/** Build a trust-gated {@link CredentialSource} from the H7 knobs, or
 *  `undefined` when NONE of the four knobs is set (default-OFF ⇒ no source ⇒
 *  byte-identical). When ANY knob IS set the source is always built — the trust
 *  gate lives INSIDE the source (`isTrusted` is consulted at shell time, so an
 *  untrusted workspace produces a typed `untrusted` decline rather than a
 *  silent no-op that would hide a misconfiguration). */
export const buildCredentialSource = (
  input: CredentialSourceInput,
): CredentialSource | undefined => {
  const configured =
    input.apiKeyHelper !== undefined ||
    input.awsAuthRefresh !== undefined ||
    input.gcpAuthRefresh !== undefined
  if (!configured) return undefined
  return createCredentialSource({
    ...(input.apiKeyHelper !== undefined ? { apiKeyHelper: input.apiKeyHelper } : {}),
    ...(input.apiKeyHelperTtlMs !== undefined
      ? { apiKeyHelperTtlMs: input.apiKeyHelperTtlMs }
      : {}),
    ...(input.awsAuthRefresh !== undefined ? { awsAuthRefresh: input.awsAuthRefresh } : {}),
    ...(input.gcpAuthRefresh !== undefined ? { gcpAuthRefresh: input.gcpAuthRefresh } : {}),
    shellExec: input.shellExec ?? realShellExec,
    isTrusted: input.isTrusted,
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}

/** Inputs to {@link buildMulticloudLLMCore}. A superset of the multicloud
 *  factory options the surface already owns (transport id / model / auth /
 *  stream guards) plus the H7 credential input. The surface maps its ENV / HTTP
 *  / IPC payload into this once. */
export interface MulticloudAssembleInput {
  /** Forwarded verbatim to {@link createMulticloudLLM} (transport id, model,
   *  auth, beta, stream guards, test client factories). The `credentialSource`
   *  field is OVERWRITTEN by the H7 builder below — callers set it via
   *  `credential`, not here. */
  opts: Omit<CreateMulticloudOptions, "credentialSource">
  /** Env source for transport selection / auth resolution (the factory reads
   *  only the cloud-SDK cred-chain env keys from it). */
  env: EnvLike
  /** H7 credential input. When the four knobs are all unset, NO source is
   *  built and the multicloud adapter shells ZERO times (byte-identical). */
  credential: CredentialSourceInput
}

/** Build a cloud-transport (Bedrock/Vertex/…) LLM with the H7 rotating
 *  credential source injected when configured. The single composition-root
 *  entry that makes the proven injection seam live end-to-end.
 *
 *  HONESTY (see report): selecting a multicloud transport is NOT yet routed by
 *  the main `buildLLMCore` provider ladder — `buildLLMCore` resolves only the
 *  four legacy `Provider`s. This entry is the tested seam a surface calls when
 *  it has decided (via a future provider-selection knob) to use a cloud
 *  transport; the H7 credential source is fully live on THIS path. */
export const buildMulticloudLLMCore = (input: MulticloudAssembleInput): LLMPort => {
  const credentialSource = buildCredentialSource(input.credential)
  const opts: CreateMulticloudOptions = {
    ...input.opts,
    ...(credentialSource !== undefined ? { credentialSource } : {}),
  }
  return createMulticloudLLM(opts, input.env)
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
