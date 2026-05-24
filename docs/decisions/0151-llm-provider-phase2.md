# ADR-0151: LLM provider transports — Phase 2 (Bedrock + Vertex real streams)

- Status: Accepted
- Date: 2026-05-24
- Related: [ADR-0139](./0139-llm-provider-fork.md) (Phase 1 typed-stub follow-up)

## Context

ADR-0139 carved the transport fork (`default | bedrock | vertex | foundry`)
out of the vendor adapter (`@/llm/adapters/anthropic.ts`) and shipped Phase 1
as typed stubs: the two enterprise adapters (`bedrock`, `vertex`) constructed
cleanly, the registry resolved by env precedence, but every `stream()` call
threw `ProviderError("provider-missing-dependency")` because the optional
`@anthropic-ai/{bedrock,vertex}-sdk` packages were not installed.

Phase 2 graduates Bedrock and Vertex to real wire impls. Foundry stays
Phase 1 stub — Anthropic has not yet shipped a first-party Foundry helper.

## Decision

### SDK call pattern

Mirror `@/llm/adapters/anthropic.ts` verbatim. Both Bedrock and Vertex
SDKs (`AnthropicBedrock`, `AnthropicVertex`) extend `BaseAnthropic` and expose
the same `messages.create({ ..., stream: true })` surface, returning an
async-iterable of `RawMessageStreamEvent`. We:

1. Resolve toolChoice via the shared `toAnthropicToolChoice` helper (exported
   from `@/llm/adapters/anthropic`).
2. Open `client.messages.create({ model, max_tokens, stream:true, system?,
   thinking?, messages, tools, tool_choice? }, { signal? })`.
3. Wrap the raw stream with the shared `withStreamTimeout` decorator
   (`firstChunkMs` / `idleMs` resolved once at construction via the shared
   `resolveAdapterStreamTimeouts`).
4. Decode each raw event through the shared `mapRawEvent` — single source of
   truth for the Messages SSE grammar. Bedrock and Vertex are pure transport
   substitutions; the wire grammar is byte-identical to the public path.

### Env-driven auth

Bedrock: forward only the auth fields that were explicitly supplied
(`awsAccessKey` / `awsSecretKey` / `awsSessionToken` / `awsRegion`). When all
four are absent, the SDK resolves via the AWS default credential chain (env
vars → SSO → EC2 IMDS → ECS IRSA). We deliberately do NOT impose a
construction-time `awsRegion` check — the SDK's own resolution (env
`AWS_REGION`) covers that case, and forcing a constructor throw would break
the legitimate "empty auth, full env" path that test HELL-A4 pins.

Vertex: REQUIRE both `gcpProjectId` and `gcpLocation` at construction —
either missing throws `ProviderError("provider-misconfigured")` with
`auth-failed` in the message. The Vertex URL is
`projects/{id}/locations/{loc}/...`, so missing either field is unrecoverable
at the wire layer; we surface the typed-fail at factory wiring rather than at
first call. `gcpAccessToken` is optional — when absent, the SDK resolves via
`google-auth-library` (Application Default Credentials,
`GOOGLE_APPLICATION_CREDENTIALS` env or workload identity).

### Signal forwarding

Caller-supplied `StreamInput.signal` is threaded into BOTH layers:

1. `messages.create(params, { signal })` — covers the create()/TTFT phase
   (the same path the public `Anthropic` SDK uses, since both SDKs extend
   `BaseAnthropic`).
2. `withStreamTimeout(raw, { signal })` — covers the post-create() streaming
   phase. Either layer firing aborts the upstream symmetrically.

### Error mapping

- SDK throws on `messages.create()` → `LLMError.fromSdkError("anthropic", e)`.
  `provider="anthropic"` is correct: the vendor IS Anthropic; only the
  transport differs, so the error classifier (status code → kind) is
  vendor-grammar-agnostic.
- `ProviderError` instances thrown from a DI factory or from the lazy SDK
  resolve path are passed through UNTOUCHED — the loop's classifier branches
  on `.code`, and re-wrapping would lose the typed dependency / config signal.
- Lazy-import failure → `ProviderError("provider-missing-dependency")`
  (unchanged from Phase 1).
- SDK constructor throw on bad credentials → `ProviderError("provider-
  misconfigured")` with `auth-failed:` prefix; the underlying SDK error is
  threaded as `cause`.

### DI seam for tests

Each adapter accepts an optional `options.clientFactory` (`BedrockClientFactory`
/ `VertexClientFactory`). When supplied, the lazy SDK import is bypassed and
the factory's return value is used as the client. Production callers (the
registry) construct adapters with `new Adapter(config)` (one-arg), so the seam
is invisible on the live path — only the hellgate tests use it to inject a
fake `messages.create` and validate wire shape without touching AWS / GCP.

### Default-OFF

The legacy `@/llm/factory` path keeps wrapping `Anthropic` directly. Callers
opt in to transport routing by either:

- Setting `ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_VERTEX_BASE_URL` (registry
  precedence ladder picks the transport up).
- Passing `providerId: "bedrock" | "vertex"` to `resolveProvider()` directly.

Nothing in this slice mutates a byte of the legacy public-API path.

## Hellgate update

The Phase 1 hellgate suites pinned `provider-missing-dependency` as the live
path (HELL-C2). With the SDKs installed and the real impls landed, that arm is
no longer reachable on the live path — it remains reachable in production when
the optional dependency is absent (the dynamic import still throws). The
updated suites (`tests/unit/llm-providers/{bedrock,vertex}-adapter-hellgate.test.ts`)
now pin:

- **HELL-C1**: `stream()` returns an `AsyncIterable` (unchanged).
- **HELL-C2**: stream emits real `StreamEvent` shape (`text_delta`, `usage`,
  `message_stop`) via DI-injected fake — proves the `mapRawEvent` wiring.
- **HELL-C3**: explicit auth fields flow into the SDK client constructor.
- **HELL-C4**: empty auth → empty SDK options (`undefined` not shadowed).
- **HELL-D1**: `signal` forwarded to `messages.create()`.
- **HELL-D2**: stream params include `model`, `max_tokens`, `stream: true`.
- **HELL-E1**: SDK throw on `create()` → typed `LLMError`.
- **HELL-E2**: `ProviderError` from factory passes through untouched
  (preserves the `provider-missing-dependency` / `provider-misconfigured`
  typed-error path in production).

Registry hellgate (`registry-hellgate.test.ts`) is unchanged — the registry
constructs adapters via the one-arg factory path, so the DI seam is invisible
to it.

## Alternatives rejected

- **Hand-rolled SigV4 (Bedrock).** The official `@anthropic-ai/bedrock-sdk`
  already implements signed-V4 against the Bedrock endpoint, including support
  for SSO / IMDS / IRSA / env-var credential chains via the bundled AWS
  Smithy client. Re-implementing this is fragile (signature drift,
  STS refresh, regional endpoint resolution) and provides zero data-governance
  value the official lib does not.
- **Raw `fetch` + Vertex IAM token refresh.** `google-auth-library` handles
  ADC, workload identity, impersonation, and token refresh. Reimplementing
  any of that is error-prone and locks us out of GKE / Cloud Run identity
  surfaces that customers actually use.
- **Server-side proxy.** A self-hosted Anthropic-shaped proxy in front of
  Bedrock/Vertex defeats the data-governance use case (the whole point is
  that the workload's outbound HTTP terminates inside the customer's IAM /
  residency boundary; a proxy moves egress back outside).

## Follow-up

- Foundry adapter — graduate when Anthropic ships the Foundry helper. The
  port slot (`azureEndpoint`, `azureApiKey` in `ProviderAuth`) is already
  reserved so the Phase 2 fork drops in as a pure adapter swap with zero
  port-shape churn.
- Optional: surface `providerId` in the loop's pre-stream `llm_request`
  marker so observability can distinguish Bedrock / Vertex traffic from the
  public path without consulting the registry.
