import { createAutoClassifierPort, RetryingLLM } from "@/agent"
import type { EndpointSecretRef, OpenAIEndpointOptions } from "@/config"
import {
  type CreateLLMOptions,
  type CreateMulticloudOptions,
  type CredentialSource,
  createCredentialSource,
  createLLM,
  createMulticloudLLM,
  DEFAULT_MODEL,
  FallbackLLM,
  type FallbackMetricSink,
  type FallbackTransition,
  type Provider as LLMFactoryProvider,
  type LLMPort,
  type ProviderEnv,
  pickProvider as pickProviderFactory,
  resolveProvider,
  resolveVendorApiKey,
  type ShellExecResult,
  withEmptyStreamCircuitBreaker,
  withLiveUsage,
  withStreamProgressTrace,
} from "@/llm"
import {
  buildEndpointFetch,
  type EndpointFetch,
  type ResolvedEndpoint,
} from "@/llm/endpoint-transport"
import type { StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode } from "@/permission"
import { runShell } from "@/runtime"
import { runtimeConfig } from "@/shared"
import type { HostResolver } from "@/shared/net/ssrf"
import type { AgentEvent, ModelRouteReason } from "@/stream"

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

/** jun-6 (RFC jun-6-byok-apikey-helper) — async BYOK variant of
 *  {@link buildLLMCore}. The factory stays SYNCHRONOUS; this seam `await`s the
 *  single async pre-resolution step (`resolveVendorApiKey`) that may replace the
 *  vendor env key with an H7 `apiKeyHelper` mint, then calls the sync
 *  `createLLM` with the (possibly key-augmented) opts.
 *
 *  Default-OFF / byte-identity: `source === undefined` (the composition root
 *  passes it only when `runtimeConfig().apiKeyHelperLegacyVendor` is on AND an
 *  H7 `CredentialSource` was built) ⇒ `resolveVendorApiKey` returns the same
 *  opts ⇒ this is byte-identical to {@link buildLLMCore}. */
export const buildLLMWithByokCore = async (
  input: LlmAssembleInput & { source?: CredentialSource },
): Promise<LLMPort> => {
  const baseOpts: CreateLLMOptions = { model: input.model }
  const opts = await resolveVendorApiKey(input.provider, baseOpts, input.source)
  return createLLM(input.provider, opts, input.env)
}

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
    input.slog.debug("llm.fallback.on", { models: input.fallbackModelIds })
  }
  if (input.mode === "auto") {
    input.permission.classify = createAutoClassifierPort({ llm: finalLLM })
    input.slog.debug("permission.auto.on")
  }
  // Outermost wrap: live output-token meter. Placed AFTER the classifier so
  // the classifier's internal calls use the un-wrapped port (no stray
  // `output_progress` from permission classification). Identity when OFF.
  if (input.liveUsage === true) {
    finalLLM = withLiveUsage(finalLLM, { enabled: true })
    input.slog.debug("llm.live_usage.on")
  }
  // jun-26 RCA (cassette /tmp/g55-traj.jsonl): a content-LESS stream — only the
  // `llm_continuation` telemetry then an idle timeout — is classified transient
  // and retried with the SAME request, each retry burning the full idle window
  // (~120s) producing zero content → the bench box sits idle for minutes. The
  // consecutive-empty circuit breaker converts that silent burn into a TERMINAL
  // (non-retryable) error after K content-less streams. This is a failure-path
  // SAFETY guard, NOT a posture knob: it is byte-identical for any stream that
  // produces content (it never trips), so the healthy path is unaffected.
  // OUTERMOST so it observes the fully-normalized event stream (incl. fallback
  // `stream_reset`). Env override: QUANTA_LLM_EMPTY_STREAM_BREAKER_K.
  const breakerK = runtimeConfig().llmEmptyStreamBreakerK
  finalLLM = withEmptyStreamCircuitBreaker(
    finalLLM,
    breakerK !== undefined ? { maxConsecutiveEmpty: breakerK } : {},
  )
  // jun-26 observability — per-stream PROGRESS HEARTBEAT. The bench run.log only
  // gets a line when a TOOL ACTION completes, so a turn stalled INSIDE the LLM
  // stream (content-less stream awaiting data, or a very slow turn) is invisible
  // — "troubleshooting blind". This decorator emits a periodic heartbeat DURING
  // stream consumption that keeps firing while the async generator awaits the
  // next event, so a stall shows up as idle climbing with content frozen, plus a
  // one-line summary on completion. Telemetry ONLY — events pass through
  // byte-identically (no add/drop/reorder/delay), so it is safe DEFAULT-ON (the
  // whole point is visibility; healthy fast turns finish before the first
  // interval and stay silent). Wired OUTERMOST — around the breaker — so it
  // observes the fully-normalized event stream AND surfaces the breaker's own
  // terminal throw as an `error:` summary. Env override: QUANTA_LLM_STREAM_TRACE_MS
  // (0 ⇒ disabled; absent ⇒ DEFAULT_STREAM_TRACE_INTERVAL_MS).
  const traceMs = runtimeConfig().llmStreamTraceMs
  finalLLM = withStreamProgressTrace(finalLLM, traceMs !== undefined ? { intervalMs: traceMs } : {})
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
 *  REACHABILITY: this entry is now ROUTED by the main agent via
 *  {@link buildMainLLMCore} + {@link selectLlmTransport} — `buildLLMCore` still
 *  resolves only the four legacy `Provider`s, but the surface picks between the
 *  two paths based on the `QUANTA_LLM_TRANSPORT` knob / registry env signals, so
 *  a cloud transport (and the H7 credential source on it) is reachable by config
 *  rather than only by an explicit `buildMulticloudLLMCore` call. */
export const buildMulticloudLLMCore = (input: MulticloudAssembleInput): LLMPort => {
  const credentialSource = buildCredentialSource(input.credential)
  const opts: CreateMulticloudOptions = {
    ...input.opts,
    ...(credentialSource !== undefined ? { credentialSource } : {}),
  }
  return createMulticloudLLM(opts, input.env)
}

// ─────────────── H7 / ADR-0139 — MAIN-AGENT transport SELECTION + ROUTING ────
//
// THE PREVIOUSLY-MISSING LAYER. Until now `createMulticloudLLM` (and the H7
// rotating-credential injection it carries) was a fully-tested seam that NOTHING
// in the main agent path reached: the CLI's `buildLLM` resolved only the four
// legacy vendor `Provider`s, so the entire bedrock/vertex/foundry + rotation
// path was LIVE-BUT-UNREACHABLE by config. These two helpers are the
// surface-agnostic SELECTION/ROUTING layer that closes that gap:
//
//   - {@link selectLlmTransport} reuses the PROVEN registry precedence ladder
//     (`resolveProvider`) — explicit `QUANTA_LLM_TRANSPORT` knob wins, else the
//     `ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL` / `*_RESOURCE` / `*_USE_*`
//     env signals decide. NO parallel selection mechanism is invented; this is
//     the single source of truth the `createMulticloudLLM` path already uses.
//   - {@link buildMainLLMCore} routes: a `default` resolution builds the legacy
//     vendor adapter BYTE-IDENTICALLY (`buildLLMCore`); a cloud resolution
//     routes through `buildMulticloudLLMCore` with the H7 credential input.
//
// DEFAULT-OFF BYTE-IDENTITY: when `transport` is unset AND no cloud env signal
// is present, {@link selectLlmTransport} returns `{ kind: "legacy" }` and
// {@link buildMainLLMCore} calls `buildLLMCore` verbatim — the four vendor
// providers and their adapter ctor args are untouched.

/** The transport SELECTION decision. `legacy` ⇒ the four vendor providers via
 *  `createLLM` (byte-identical). `multicloud` ⇒ a cloud transport via
 *  `createMulticloudLLM` (the H7 rotating-credential path), carrying the
 *  resolved transport id for the multicloud factory. */
export type LlmTransportSelection =
  | { readonly kind: "legacy" }
  | { readonly kind: "multicloud"; readonly providerId: string }

/** Inputs to {@link selectLlmTransport}. The surface passes the explicit
 *  selector knob (`QUANTA_LLM_TRANSPORT`, already mirrored off `runtimeConfig()`)
 *  and the env record the registry ladder consults — keeping `@/runner` free of
 *  a direct `process.env` read. */
export interface SelectTransportInput {
  /** `QUANTA_LLM_TRANSPORT` — explicit `default|bedrock|vertex|foundry|mantle`.
   *  Empty/undefined ⇒ fall through to the env precedence ladder. */
  transport: string | undefined
  /** Env record forwarded to `resolveProvider` for the env precedence ladder
   *  (`ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL` / `*_RESOURCE` / `*_USE_*`). */
  env: ProviderEnv
}

/** Decide whether the MAIN agent LLM uses a cloud transport. Reuses the
 *  registry's deterministic precedence ladder (explicit knob wins, else env
 *  signals) so there is ONE selection mechanism. A `default` resolution ⇒
 *  `legacy` (byte-identical vendor path); any other resolved id ⇒ `multicloud`.
 *
 *  NOTE: an UNKNOWN explicit id (e.g. `QUANTA_LLM_TRANSPORT=typo`) resolves to a
 *  non-`default` id whose multicloud factory lazy-throws `provider-unsupported`
 *  at first stream — the operator's typo surfaces loudly rather than silently
 *  falling back to the vendor path (matching the registry's documented
 *  unknown-id contract). */
export const selectLlmTransport = (input: SelectTransportInput): LlmTransportSelection => {
  const resolved = resolveProvider(input.transport, input.env)
  if (resolved.id === "default") return { kind: "legacy" }
  return { kind: "multicloud", providerId: resolved.id }
}

/** Inputs to {@link buildMainLLMCore} — the single composition-root entry the
 *  surface calls to build the MAIN agent LLM with transport selection + H7
 *  rotation routed end-to-end. A superset of {@link LlmAssembleInput} (the
 *  legacy path) plus the transport selector + the H7 credential input (consulted
 *  only on the multicloud path). */
export interface MainLlmAssembleInput {
  /** Legacy vendor provider (`pickProviderCore` result). Used ONLY on the
   *  `legacy` branch — the multicloud branch derives its model from the
   *  transport's default unless `model` is pinned. */
  provider: Provider
  /** Model id (CLI `QUANTA_MODEL`). On the multicloud branch a transport-pinned
   *  model wins; an empty string ⇒ the transport default is used. */
  model: string
  /** Env-record forwarded to BOTH the legacy `createLLM` (api-key / baseURL) and
   *  the multicloud auth / transport resolution. */
  env: EnvLike
  /** The transport SELECTION (from {@link selectLlmTransport}). Surface decides;
   *  `legacy` ⇒ byte-identical vendor path. */
  selection: LlmTransportSelection
  /** H7 credential input — consulted ONLY on the multicloud branch. When all
   *  four H7 knobs are unset, NO source is built and the cloud adapter shells
   *  ZERO times (byte-identical to the SDK default credential chain). */
  credential: CredentialSourceInput
  /** Test-only DI seams — forwarded verbatim to {@link buildMulticloudLLMCore}
   *  on the multicloud branch so a hellgate can drive `.stream()` over a faked
   *  cloud client (bypassing the lazy cloud-SDK import). Production omits. */
  multicloudOpts?: Pick<
    CreateMulticloudOptions,
    "auth" | "bedrockClientFactory" | "vertexClientFactory"
  >
  /** RFC05-2 — a SELECTED configured OpenAI endpoint (from
   *  {@link resolveConfiguredEndpoint}). When present, the LEGACY branch routes
   *  through the OpenAI-wire adapter with the endpoint's `baseUrl` + explicit
   *  `surface` + guarded `fetchImpl` (composed by {@link composeEndpointCreateLLMOptions})
   *  instead of the default vendor path. The surface resolves the endpoint's
   *  symbolic secret refs and passes it here. ABSENT ⇒ byte-identical vendor path
   *  (the four providers + their adapter ctor args are untouched). The multicloud
   *  branch ignores it (Anthropic-grammar transports are a separate axis). */
  endpoint?: ResolvedEndpoint
}

/** Build the MAIN agent LLM, routing to the multicloud + H7 path when a cloud
 *  transport is selected, else the byte-identical legacy vendor path. THE entry
 *  that makes the multicloud + rotation seam reachable by config.
 *
 *  legacy ⇒ {@link buildLLMCore} (four vendor providers, untouched).
 *  multicloud ⇒ {@link buildMulticloudLLMCore} with `providerId` pinned to the
 *  resolved transport + the H7 credential input. A non-empty `model` overrides
 *  the transport default (CLI `QUANTA_MODEL`); an empty `model` lets the
 *  multicloud factory pick the transport-appropriate default slug. */
export const buildMainLLMCore = (input: MainLlmAssembleInput): LLMPort => {
  if (input.selection.kind === "legacy") {
    // RFC05-2 — a SELECTED configured OpenAI endpoint routes the legacy branch
    // through the OpenAI-wire adapter with the endpoint's baseUrl + explicit
    // surface + guarded fetch. ABSENT ⇒ byte-identical vendor path below.
    if (input.endpoint !== undefined) {
      const opts = composeEndpointCreateLLMOptions({
        endpoint: input.endpoint,
        model: input.model,
      })
      return createLLM("openai", opts, input.env)
    }
    return buildLLMCore({ provider: input.provider, model: input.model, env: input.env })
  }
  return buildMulticloudLLMCore({
    opts: {
      providerId: input.selection.providerId,
      ...(input.model.length > 0 ? { model: input.model } : {}),
      ...(input.multicloudOpts ?? {}),
    },
    env: input.env,
    credential: input.credential,
  })
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

// ───────────── RFC05-2 (D1 follower) — configured-endpoint SELECTION ─────────
//
// The `@/runner` composition adapter that turns a CONFIGURED named OpenAI
// endpoint profile (`OpenAIEndpointOptions`, from central config, RFC05-0) into
// a resolved endpoint contract and COMPOSES it into `createLLM`. This is the
// deferred selection hunk of RFC05-2: RFC05-core already shipped the resolved
// data-plane (`buildEndpointFetch`, `ResolvedEndpoint`) + the Chat/Responses
// `fetchImpl?` seam; here we SELECT a named profile, materialize its symbolic
// secret refs to concrete VALUES (host composition — never on a config record),
// and hand `createLLM` the `baseURL` + explicit `surface` + guarded `fetchImpl`.
//
// SEPARATION (README shared-write-set rule): this is a DISTINCT dep from the
// RFC02-3 route-transition observation below — the two share NO argument type
// (selection takes {name,endpoints,secrets}; route observation takes a
// `FallbackTransition`) and neither wraps the other. NO retry/fallback
// controller is added, NO provider/endpoint registry, NO URL-shape wire
// inference (the profile's EXPLICIT `wireApi` drives the surface).
//
// DEFAULT-OFF BYTE-IDENTITY: an absent / unknown configured name ⇒
// {@link resolveConfiguredEndpoint} returns `undefined` ⇒
// {@link composeEndpointCreateLLMOptions} adds NO `baseURL`/`surface`/`fetchImpl`
// ⇒ the composed options are byte-identical to today's legacy `{ model }` shape
// and `createLLM` constructs the adapter exactly as before (default global fetch
// + api-key). The route-transition callback is untouched on this path.

/** Inputs to {@link resolveConfiguredEndpoint}. `secrets` is the host-resolved
 *  map from the fixed {@link EndpointSecretRef} allowlist to concrete VALUES —
 *  the surface resolves these from its secret store; they never live on a config
 *  record. A ref declared by the profile but ABSENT here fails closed. */
export interface ResolveConfiguredEndpointInput {
  /** The configured endpoint name to select (e.g. `QUANTA_LLM_ENDPOINT`).
   *  Empty / undefined / not-in-map ⇒ no selection (gate-OFF). */
  name: string | undefined
  /** The trust-gated named endpoint profiles from resolved central config
   *  (`ResolvedSettings.openaiEndpoints`). */
  endpoints: Readonly<Record<string, OpenAIEndpointOptions>>
  /** Host-resolved symbolic-ref → concrete secret VALUE map. A ref the profile
   *  references but that is absent here ⇒ fail-closed (no endpoint). */
  secrets: Readonly<Partial<Record<EndpointSecretRef, string>>>
}

/** SELECT a configured named endpoint and materialize its symbolic secret refs
 *  into a {@link ResolvedEndpoint} (concrete header VALUES). Returns `undefined`
 *  when the name is absent/unknown OR a referenced secret cannot be resolved
 *  (fail-closed — never a silent unauthenticated stream). PURE: no env / clock
 *  reads; the caller injects `endpoints` (trust-gated) and `secrets` (resolved).
 *
 *  `authRef` ⇒ `Authorization: Bearer <value>`; each `headerRefs[name]` ⇒ that
 *  header set to the resolved value. Static `query` is carried through
 *  verbatim (non-secret). This is the ONLY place the symbolic refs become
 *  concrete VALUES — they leave here only on the outgoing request (via the
 *  guarded fetch) and never onto a diagnostic (see `redactEndpointForDiagnostics`). */
export const resolveConfiguredEndpoint = (
  input: ResolveConfiguredEndpointInput,
): ResolvedEndpoint | undefined => {
  const { name, endpoints, secrets } = input
  if (name === undefined || name === "") return undefined
  const profile = endpoints[name]
  if (profile === undefined) return undefined

  const headers: Record<string, string> = {}
  // authRef ⇒ Bearer auth header. Fail closed if the ref is unresolved.
  if (profile.authRef !== undefined) {
    const value = secrets[profile.authRef]
    if (value === undefined) return undefined
    headers.authorization = `Bearer ${value}`
  }
  // headerRefs ⇒ each maps a header name to a symbolic ref; fail closed on any
  // unresolved ref (never emit a partially-authed request silently).
  for (const [headerName, ref] of Object.entries(profile.headerRefs ?? {})) {
    const value = secrets[ref]
    if (value === undefined) return undefined
    headers[headerName] = value
  }

  return {
    id: name,
    baseUrl: profile.baseUrl,
    wireApi: profile.wireApi,
    model: profile.model,
    // `EndpointNetworkPolicy` and the ssrf `NetworkPolicy` are the SAME closed
    // union today; assign WITHOUT a cast so a future divergence between the two
    // vocabularies is a compile error here (drift guard), not a silent widening.
    networkPolicy: profile.networkPolicy,
    headers,
    query: { ...(profile.query ?? {}) },
  }
}

/** Inputs to {@link composeEndpointCreateLLMOptions}. `endpoint` is the SELECTED
 *  resolved endpoint (or `undefined` for the gate-OFF legacy path). `fetchInner`
 *  / `resolveHost` are test-only DI seams forwarded to {@link buildEndpointFetch}
 *  (production omits ⇒ the guard wraps the global `fetch` + node DNS). */
export interface ComposeEndpointOptionsInput {
  /** The selected endpoint, or `undefined` ⇒ byte-identical legacy options. */
  endpoint: ResolvedEndpoint | undefined
  /** Caller model id (CLI `QUANTA_MODEL`). Non-empty wins; empty ⇒ the
   *  endpoint's declared model is used. On the legacy path it is passed through. */
  model: string
  /** TEST SEAM — inner fetcher the guarded fetch wraps. Production omits. */
  fetchInner?: typeof fetch
  /** TEST SEAM — DNS resolver forwarded to the guard. Production omits. */
  resolveHost?: HostResolver
}

/** COMPOSE the selected endpoint into a {@link CreateLLMOptions} fragment: the
 *  `baseURL`, the EXPLICIT `surface` (from the profile's `wireApi` — never a
 *  base-URL inference), and the guarded `fetchImpl`. When `endpoint` is
 *  `undefined` the result is byte-identical to the legacy `{ model }` shape (no
 *  `baseURL`/`surface`/`fetchImpl` key), so `createLLM` constructs the adapter
 *  exactly as before. This is the composition front door — the caller spreads
 *  the result into `createLLM(provider, { apiKey?, ...opts }, env)`. */
export const composeEndpointCreateLLMOptions = (
  input: ComposeEndpointOptionsInput,
): CreateLLMOptions => {
  const { endpoint, model } = input
  if (endpoint === undefined) return { model }
  const fetchImpl: EndpointFetch = buildEndpointFetch(endpoint, {
    ...(input.fetchInner !== undefined ? { inner: input.fetchInner } : {}),
    ...(input.resolveHost !== undefined ? { resolveHost: input.resolveHost } : {}),
  })
  return {
    // Caller model wins when non-empty; else the profile's declared model (a
    // custom endpoint has no port-level default).
    model: model.length > 0 ? model : endpoint.model,
    baseURL: endpoint.baseUrl,
    // EXPLICIT wire — a chat-only custom endpoint never silently gets `responses`
    // (audit A4). Map the closed `wireApi` union to the factory's surface union.
    surface: endpoint.wireApi === "responses" ? "responses" : "chat-completions",
    // `createLLM("openai", …)` requires an SDK apiKey EVEN THOUGH the guarded
    // fetch already carries the resolved auth header. Feed the SAME resolved
    // token so the SDK's own `Authorization: Bearer <key>` matches (and the
    // guarded fetch's header-merge is a no-op — it only sets headers not already
    // present). A no-auth loopback preset (D2) has no token, so a fixed
    // NON-SECRET sentinel satisfies the SDK ctor; the local server ignores it
    // (RFC05-3 local no-auth contract). This is NOT read from a config record —
    // the token is the host-resolved value on the in-memory endpoint only. */
    apiKey: bearerTokenOf(endpoint.headers.authorization) ?? ENDPOINT_NO_AUTH_SENTINEL,
    fetchImpl,
  }
}

/** Fixed NON-SECRET placeholder the SDK client accepts for a no-auth (loopback)
 *  endpoint. Never a real credential — the local server ignores it. Kept as a
 *  named constant so it is greppable and obviously not a secret. */
const ENDPOINT_NO_AUTH_SENTINEL = "sk-local-no-auth"

/** Extract the raw token from an `Authorization: Bearer <token>` header value,
 *  or `undefined` when the header is absent / not a Bearer scheme. Used to feed
 *  the SDK client the SAME resolved key that the guarded fetch carries. */
const bearerTokenOf = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined) return undefined
  const prefix = "Bearer "
  return authorization.startsWith(prefix) ? authorization.slice(prefix.length) : undefined
}

// ─────────────── RFC02-3 (A8) — FALLBACK route-transition OBSERVATION ────────
//
// The `@/runner` adapter that converts a `FallbackLLM` structural transition
// (`FallbackTransition`, `@/llm`) into a `model_route_changed` AgentEvent
// (`@/stream`). This is DELIBERATELY a SEPARATE function/dep from the endpoint-
// selection + `composeLLMCore` stack (README shared-write-set rule: "route
// observation과 endpoint selection을 별도 함수/dep로 유지; wrapper nesting/retry
// 추가 금지"). It adds NO wrapper to the LLM stack — the caller wires the pure
// mapper below to `FallbackLLMOptions.onTransition` and pushes the resulting
// event onto the SAME AgentEvent stream the loop already emits. `FallbackLLM`
// OWNS the route reason (it is the only party that knows WHY it swapped — the
// triggering `LLMError.kind`); this maps that onto the closed `ModelRouteReason`.

/** Map the fallback swap's `LLMError.kind` onto the closed `ModelRouteReason`.
 *  Exhaustive over the FOUR kinds the fallback classifier swaps on
 *  (`isFallbackKind` → `fallback_provider`); any other string fails CLOSED to
 *  `provider_server_error` (a fallback swap always has a provider-side cause, so
 *  a not-yet-mapped kind is still a provider fault, never a mislabelled operator
 *  action). Kept as a `Record` so a new fallback kind that should surface
 *  distinctly is a visible edit here. */
const FALLBACK_KIND_TO_ROUTE_REASON: Readonly<Record<string, ModelRouteReason>> = Object.freeze({
  overloaded: "provider_overloaded",
  server_error: "provider_server_error",
  network: "provider_network",
  not_implemented: "provider_not_implemented",
})

/** Convert a `FallbackLLM` {@link FallbackTransition} into a
 *  `model_route_changed` AgentEvent. Pure: `now`/`turnId`/`provider` are
 *  injected by the caller (no bare clock read here). `routeKind` is fixed to
 *  `provider_fallback` — this adapter is FALLBACK-specific; the operator-retry
 *  and scheduler callers project their OWN events with their own `routeKind`. */
export const fallbackTransitionToRouteEvent = (
  t: FallbackTransition,
  ctx: { readonly at: number; readonly turnId?: string; readonly provider?: string },
): Extract<AgentEvent, { type: "model_route_changed" }> => ({
  type: "model_route_changed",
  fromModel: t.fromModel,
  toModel: t.toModel,
  reason: FALLBACK_KIND_TO_ROUTE_REASON[t.kind] ?? "provider_server_error",
  routeKind: "provider_fallback",
  at: ctx.at,
  ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
  ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
})

export { DEFAULT_MODEL }
