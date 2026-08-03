# RFC-05 — Declarative provider config + local OSS chat + optional WS turn transport

**Status:** RE-AUDITED — D1 DESIGN FIRST; D2 AFTER D1; A6 SEPARATE MEASURED TRACK. NOT started.
**Source:** `docs/analysis/aug-02-competitor-corpus-refresh-audit.md` §8 (D1/D2), §3.5 (A6).
**Scope:** D1 declarative `[model_providers.*]`, D2 ollama/lmstudio as CHAT, A6 WS turn transport (measure-first).

---

## 2026-08-03 current-HEAD correction (authoritative)

Audit basis: `main@0a00ced392102073fe35eccd202bca92cabd71dc`. Focused current-head rails: **165 pass / 0 fail**. 이 절과 아래 과거 초안이 충돌하면 **이 절이 우선**한다.

| Item | corrected verdict | owner delta | admission / stop rule |
|---|---|---|---|
| D1 declarative provider | owner는 Anthropic-grammar `providers/registry`/`createMulticloudLLM`이 아니라 OpenAI `createLLM(provider, options, env)` axis다. 현재 central config가 `model_providers`를 drop하고 Chat/Responses transport option도 대칭이 아니다. **M-L**. | central config와 existing `CreateLLMOptions`에 `openaiEndpoints`를 additive 확장하고 named selector가 기존 Chat/Responses adapters를 구성한다. v1은 baseURL/wireApi/header refs/query만; configurable retry는 공통 retry owner 전까지 제외한다. | 새 provider registry/adapter/retry loop, URL-shape wire inference, 한 wire surface만 지원, gate OFF drift 금지. |
| D1 trust | HTTPS만으로 충분하지 않다. private/link-local SSRF, redirects, DNS rebinding, credential-env exfil 위험이 남는다. | 이미 추출된 `@/shared/net/ssrf`의 `ssrfDeny`/`fetchWithSsrfGuard`를 LLM transport에서도 재사용한다. endpoint provenance, fixed secret-ref allowlist, existing config trust hash/reapproval을 추가한다. | 두 번째 SSRF classifier, arbitrary env name/header, hostname suffix/regex allow, private endpoint 자동 신뢰 금지. |
| D2 OSS chat | D1 후 **S-M**. OpenAI factory는 API key를 요구하므로 local no-auth/sentinel contract가 필요하다. | Ollama/LM Studio preset은 D1 위의 config sugar만 허용; 실제 streaming tool-call smoke를 rail로 둔다. | embedder 재사용 또는 별도 local adapter grammar 금지. tool-call chunk index assumptions가 실제 server와 맞지 않으면 no ship. |
| A6 WS | Responses API WebSocket mode는 2026-04-22 공개됐다. “Codex-internal이면 DROP” 가정은 폐기한다. repo에는 turn framing/resume transport가 없다. **L, 별도 track**. | public protocol에 맞춘 session/turn framing, typed failure/recovery semantics, latency/token/cache A/B를 별도 RFC로 설계한다. | 자체 측정 없이 default-ON, WS 전용 fallback controller, SSE 대체 금지. D1/D2 closure 조건에 섞지 않는다. |

공개 protocol 근거: [OpenAI — Speeding up agentic workflows with WebSockets](https://openai.com/index/speeding-up-agentic-workflows-with-websockets/). 아래 `ProviderId`/multicloud registry를 D1 owner로 삼는 설계와 “existing adapters untouched” 주장은 superseded candidate다.

### SOTA++ direction — declarative endpoint profiles, shared wire contracts

- control plane은 existing central config/`CreateLLMOptions`의 `OpenAIEndpointOptions { id, provenance, baseUrl, wireApi, model, authRef, headerRefs, query, networkPolicy, trustHash }`, data plane은 기존 OpenAI Chat/Responses adapters다. 별도 `EndpointProfile` registry나 user label provider union을 만들지 않는다.
- profile merge/selection과 secret resolution을 분리한다. config에는 secret value가 아닌 restricted reference만 저장하고, resolved value는 logs/receipts/hash material에서 제외한다.
- network admission은 scheme뿐 아니라 DNS/IP class, redirect hop, hostname re-resolution, proxy policy를 검사한다. localhost no-auth는 explicit local profile이며 remote endpoint에 전이되지 않는다.
- Chat와 Responses는 동일 endpoint-policy contract를 소비하되 wire-specific serialization은 기존 adapter가 소유한다. 새 declarative adapter가 protocol grammar를 복제하지 않는다.
- retry authority는 늘리지 않는다. configurable `request_max_retries`는 Chat/Responses 공통 transport-retry owner가 생기기 전 D1에서 제외하고, provider/turn-level recovery는 existing retry/RecoveryRouter만 사용한다.
- WS는 endpoint option의 boolean knob가 아니라 stateful transport session이다. connection generation, prior-response chain, reconnect/error semantics, in-flight turn pin을 정의한다. WS 오류는 typed error로 existing RecoveryRouter에 넘기며 WS 전용 silent/automatic SSE fallback controller를 만들지 않는다.
- vendor 공개 성능 수치는 hypothesis일 뿐이다. 이 repo에서 TTFT, turn latency, reconnect/error rate, token/cache behavior를 동일 workload로 측정한 뒤에만 승격한다.
- **중복 금지:** provider registry, OpenAI wire adapter, retry decorator, SSRF classifier, secret resolver를 새로 만들지 않는다.

## 구현 액션리스트 (authoritative)

**SOLID 경계:** central config가 profile syntax/provenance/merge를, shared net owner가 endpoint admission을, `createLLM`이 selection/composition을, 기존 Chat/Responses adapters가 wire serialization을 소유한다. secret value는 host composition에서만 materialize되고 config/domain record에는 reference만 남는다.

### Symbol-level reuse / delete / new ledger

| disposition | existing/new symbol | exact action | 금지되는 평행 구현 |
|---|---|---|---|
| **KEEP AUTHORITY** | `createLLM`, `CreateLLMOptions` | named OpenAI endpoint selection/composition을 additive 확장 | provider/endpoint registry 또는 provider union 확장 |
| **EXTEND** | central config `types/loader/merge/trust-store` | security-band profile parse/provenance/trust merge | 별도 provider config loader/trust ledger |
| **REFACTOR/KEEP ONE** | `ssrfDeny`, `fetchWithSsrfGuard` | typed classifier/policy로 evolve하고 compatibility wrapper 유지 | LLM 전용 SSRF classifier/redirect guard |
| **EXTEND** | OpenAI Chat adapter | Responses와 같은 guarded fetch injection seam 추가 | declarative Chat adapter 재구현 |
| **REUSE** | OpenAI Responses adapter `fetchImpl` | same resolved endpoint/network contract 소비 | profile-specific Responses adapter |
| **CONFIG SUGAR ONLY** | Ollama/LM Studio presets | D1 loopback profile을 생성 | local provider registry, local Chat grammar |
| **NEW — SEPARATE TRACK** | Responses WS transport session | public framing을 구현하는 단일 stateful adapter | endpoint boolean branch, WS retry/fallback controller |

**삭제/대체 완료 조건:** profile id를 새 `Provider` variant/factory map에 추가하지 않는다. Chat와 Responses가 서로 다른 endpoint admission/secret resolution 경로를 가지거나 local preset용 adapter가 생기면 merge 불가다.

### RFC05-0 — endpoint profile schema + trust provenance (P0, M)

- **Depends:** 없음.
- **Owner/write-set:** `src/config/types.ts`, `src/config/loader.ts`, `src/config/merge.ts`, `src/config/trust-store.ts`, `src/llm/factory.ts`, central-config tests.
- **Actions:**
  1. existing config security band에 named `openaiEndpoints`와 `OpenAIEndpointOptions {id,baseUrl,wireApi,model,authRef?,headerRefs?,query?,networkPolicy,provenance,trustHash}`를 추가한다.
  2. system/user/project/local layer merge를 id 기준 deterministic replace로 정의하고 project/local endpoint는 existing trust hash/reapproval을 통과해야 활성화한다.
  3. `authRef/headerRefs`는 고정 allowlist의 symbolic refs만 허용한다. arbitrary env 이름/header name, inline secret, configurable retry는 schema에서 거부한다.
- **RED:** untrusted repo가 endpoint/secret ref를 추가해 활성화, merge order가 load 순서에 따라 변경, secret value가 receipt/hash/log에 나타나는 tests.
- **GREEN/DoD:** exact provenance, deterministic merge, trust invalidation, unknown field/ref fail-closed, profiles 미설정 시 factory constructor parity.
- **Stop:** user label을 provider union에 넣거나 별도 provider registry가 필요해지면 중단한다.

### RFC05-1 — canonical typed network admission (P0, M)

- **Depends:** RFC05-0의 `networkPolicy` vocabulary.
- **Owner/write-set:** `src/shared/net/ssrf.ts`, SSRF unit/integration tests.
- **Actions:**
  1. existing classifier를 typed IP/DNS class(`public|loopback|private|link_local|multicast|unspecified`)로 evolve하고 현재 `ssrfDeny`는 compatibility wrapper로 유지한다.
  2. `public_https` policy는 HTTPS+public-resolved address만, `loopback_local`은 HTTP/HTTPS+loopback-resolved address만 허용한다. arbitrary private LAN은 v1에서 거부한다.
  3. initial DNS와 모든 redirect hop에 동일 policy를 적용하고 redirect target을 재해석한다. resolver error/empty answer는 fail-closed 한다. proxy 사용 여부도 explicit policy로 고정한다.
- **RED:** private/link-local/IPv6-mapped/redirect-to-private/DNS-resolution-failure가 통과하는 fixtures.
- **GREEN/DoD:** classifier 하나, redirect parity, loopback preset만 local HTTP 허용, current web fetch policy regression 없음.
- **Stop:** hostname suffix/regex allowlist 또는 adapter별 SSRF 분기가 들어오면 release 금지. DNS TOCTOU를 완전히 봉합할 transport binding이 없으면 residual risk를 문서화하고 public profile canary를 제한한다.

### RFC05-2 — Chat/Responses endpoint parity (P0, M)

- **Depends:** RFC05-0/1.
- **Owner/write-set:** `src/llm/factory.ts`, `src/llm/adapters/openai.ts`, `src/llm/adapters/openai-responses.ts`, `src/runner/assemble/llm.ts`, adapter/factory tests.
- **Actions:**
  1. host가 profile 선택→trust/network 검증→restricted secret resolution 후 동일 resolved endpoint options를 `createLLM`에 전달한다.
  2. Responses의 existing `fetchImpl`과 동일하게 Chat adapter에도 guarded fetch injection을 제공한다. base URL/query/headers/auth의 공통 policy는 factory에서 한 번 만들고 wire-specific body/stream decode는 각 adapter가 유지한다.
  3. profile id/wire/model/provenance hash만 diagnostic에 남기고 resolved headers/query secrets는 redact한다.
- **RED:** 같은 profile이 Chat에서는 guard/header/query를 무시하거나 Responses에서 다른 trust decision을 내는 parity tests.
- **GREEN/DoD:** both wires streaming/tool-call/error mapping parity, existing provider path byte-identical when no profile, new retry loop 없음.
- **Stop:** 한 adapter만 guarded fetch를 지원하거나 URL shape로 wire를 추정하면 publish 금지.

### RFC05-3 — D2 explicit local presets + live smoke (P1, S-M)

- **Depends:** RFC05-0~2.
- **Owner/write-set:** existing config preset/default owner, factory selection tests, live probe/bench fixture. 새 adapter 없음.
- **Actions:**
  1. Ollama/LM Studio preset은 named endpoint profile sugar로만 제공하고 `wireApi:"chat"`, `networkPolicy:"loopback_local"`, no-auth/sentinel 계약을 명시한다.
  2. server-specific model listing/health grammar는 provider core에 넣지 않는다. 사용자가 명시한 model과 endpoint를 그대로 기존 Chat adapter에 전달한다.
  3. 실제 Ollama와 LM Studio 각각에서 streaming text+tool-call arguments+finish reason smoke를 같은 revision에 기록한다.
- **RED:** non-loopback address가 local preset으로 허용되거나 API key 요구가 재발하는 tests.
- **GREEN/DoD:** config sugar 외 runtime branch 없음, both live servers tool-call stream proof, absent local server typed connection error.
- **Stop:** 실제 server chunk grammar가 existing Chat adapter와 불일치하면 별도 compatibility adapter 근거 없이는 ship하지 않는다.

### RFC05-4 — A6 WS transport contract/prototype (P2, L; separate track)

- **Depends:** RFC05-2 안정화. D1/D2 closure와 분리.
- **Owner/write-set:** 별도 ADR/RFC 후 `src/llm` 내 Responses transport port/adapter leaf, existing RecoveryRouter integration, benchmark harness.
- **Actions:**
  1. public protocol version을 pin하고 `{connectionGeneration,turnId,priorResponseId,inFlightState}` framing, reconnect replay 가능/불가능 경계, server ack/terminal semantics를 먼저 계약한다.
  2. 한 turn은 한 transport generation에 pin한다. WS error를 typed transport error로 existing RecoveryRouter에 넘기며 WS 내부 SSE fallback/retry controller는 만들지 않는다.
  3. SSE baseline과 TTFT, end-to-end latency, reconnect/error, token/cache behavior, connection memory를 동일 workload/canary에서 측정한다.
- **RED:** reconnect 후 duplicate tool call, prior-response chain drift, mid-turn transport swap, silent SSE fallback fixtures.
- **GREEN/DoD:** deterministic turn framing, bounded reconnect semantics, error-owner 단일화, predeclared A/B 승격 기준 충족.
- **Stop:** public conformance fixture를 만들 수 없거나 correctness를 latency와 교환해야 하면 prototype에서 종료하고 default-OFF 유지한다.

### Landing rail

1. `bun test tests/unit/central-config-off-byte-identity-hellgate.test.ts tests/unit/central-config-trust-hellgate.test.ts tests/unit/central-config-trust-store-hellgate.test.ts`.
2. `bun test tests/unit/ssrf-classifier-hellgate.test.ts tests/unit/ssrf-egress-deep-security-r6-hellgate.test.ts tests/unit/tool/ssrf-redirect-bypass-hellgate.test.ts`.
3. `bun test tests/unit/llm/factory-openai-surface.test.ts tests/unit/openai-adapter.test.ts tests/unit/llm/openai-responses-adapter.test.ts tests/unit/llm/openai-responses-wire.test.ts`.
4. D2는 실제 Ollama/LM Studio streaming tool-call probe receipt가 없으면 NOBUILD다. A6는 별도 benchmark revision/receipt 없이는 D1/D2 status를 변경하지 않는다.
5. `bun run typecheck`와 `bun test tests/unit/god-code-ratchet.test.ts`.

## Archived pre-correction draft (non-authoritative)

아래 내용은 최초 gap 가설과 adversarial audit 이력을 보존하기 위한 것이다. 구현 ticket/DoD/노력치는 위 current-HEAD correction과 README만 사용한다. README의 중복/휴리스틱 삭제 register와 충돌하는 archive 항목은 구현 후보로 복구하지 않는다.

### Original motivation

Codex ships a declarative `[model_providers.*]` config block: `base_url` + `wire_api`
(`chat`/`responses`) + `env_http_headers` + `query_params` + named `request_max_retries`,
targeting ANY OpenAI-compatible endpoint **without a code adapter**. quanta's providers are
hard-wired adapters (`openai`/`anthropic`/`bedrock`/`vertex`/`foundry`/`mantle`). The audit
confirmed **hit 0** for declarative config and **hit 0** for local OSS *chat* (our ollama is
embed-only). Users wanting Fireworks/Together/Groq/OpenRouter/vLLM/a private gateway today must
either abuse the single `OPENAI_BASE_URL` env escape hatch (one endpoint, chat-completions only,
no custom headers) or we must hand-write an adapter.

The win is **reach without code**: one config block → any compatible endpoint, and offline/cost
via local OSS chat. A6 (WS turn transport) is a *transport-efficiency* bet with **no efficacy
evidence** — carried here as measure-first, gated, not wired into the default path.

## Non-goals

- NOT re-homing the existing 6 adapters onto declarative config — they stay **byte-identical**.
- NOT a general plugin/codegen system — declarative config reuses the **existing OpenAI wire code**,
  it does not let users ship arbitrary transport code.
- NOT claiming A6 (WS) improves latency/cost/throughput — that is unmeasured; A6 ships behind a
  knob **only** to enable measurement, default-OFF.
- NOT adding a third knob framework (memory: 3 parallel knob systems already exist — reuse).
- NOT touching the Anthropic-grammar transport axis (`bedrock`/`vertex`/`foundry`/`mantle`); D1/D2
  are OpenAI-wire-grammar providers.

## Current state (file:line — grounded)

**Provider abstraction (the seam D1 slots into):**
- `src/llm/providers/provider-port.ts:152` — `LlmProvider extends LLMPort`, the transport port;
  `:122` `ProviderConfig` (providerId/model/auth/maxTokens/stream guards/cacheTtl); `:90`
  `ProviderAuth`; `:34` `ProviderId` **closed union** `default|bedrock|vertex|foundry|mantle`.
- `src/llm/providers/registry.ts:45` — `FACTORIES: Record<ProviderId, ProviderFactory>` closed
  registry; `:126` `resolveProvider(explicit?, env)` pure precedence ladder (explicit → env keys →
  `default`), unknown id ⇒ lazy-throw `provider-unsupported` factory (`:107`).
- `src/llm/ports.ts:4` — base `LLMPort` (`model?/provider?/surfaceId?/transportId?/stream()`).
- `src/llm/provider-types.ts:38` — cross-cutting `LlmProvider` union + `ProviderCredentials`
  discriminator (`api-key`/`oauth`/`aws-iam`/…); `:101` `LLM_PROVIDERS` catalog + drift guard.

**Vendor×surface axis (where OpenAI-wire lives — reuse target):**
- `src/llm/factory.ts:33` `DEFAULT_MODEL`, `:55` `API_KEY_ENV`, `:133` `ADAPTER_REGISTRY`
  (openai/anthropic/chatgpt-oauth), `:366` `resolveOpenAISurface` (already picks
  `responses` vs `chat-completions` off baseURL!), `:403` `pickProvider`, `:433` `createLLM`.
- `src/llm/factory.ts:733` `createMulticloudLLM` — the existing composition-root pattern that
  wires `resolveProvider` → `ProviderConfig` → adapter. **This is the exact template for a
  declarative resolver.**
- `src/llm/adapters/openai.ts:19` `OpenAIConfig` (**already has `baseURL?`**), `:360`
  `new OpenAI({apiKey, timeout, maxRetries:2, baseURL})`, `:390` `chat.completions.create` streaming,
  `:97` `usesCompletionTokensParam`. **The OpenAI-wire code D1/D2 reuse already exists.**
- `src/llm/adapters/openai-responses.ts` — Responses-surface sibling (for `wire_api="responses"`).

**Local OSS — confirmed embed-only:**
- `src/retrieval/engines/embedder/ollama-embedder.ts:38` `createOllamaEmbedder` → `Embedder` port
  (`embed()`, POST `/api/embeddings`). **NOT `LLMPort`, no `stream()`.** No `lmstudio` file exists
  anywhere in `src/` (grep hit 0). D2 confirmed missing for chat.

**Transport (SSE only; A6 correction):**
- `src/llm/adapters/openai.ts:390` SSE via SDK `stream:true`. `src/llm/stream-timeout.ts` first-chunk
  /idle guards. **CORRECTION to the mandate:** grep for `websocket|realtime|wire_api|responses_websocket`
  across `src/llm/` returns **zero** LLM-turn-transport hits — the only `realtime` match is a
  `TraceTimer` in `stream-progress-trace.ts:57`. quanta has **no WS turn transport at all** (not "a
  realtime WS adapter"). A6 is greenfield behind a knob, measure-first. `enable_request_compression`
  and `request_max_retries` also **hit 0**.

**Retry:**
- `src/llm/retry/port.ts:42` `RecoveryAction` (6 closed actions); `src/llm/retry/decorator-policy.ts`,
  `too-many-failed-attempts.ts`, SDK-level `maxRetries:2` baked in `openai.ts:363`. A **named**
  retry-config struct does not exist — retries are per-adapter constants + the RecoveryRouter port.

**Knob / config / trust (grep-before-adding, per memory):**
- Config framework: `src/config/{loader,merge,knob-catalog,trust-store}.ts` (+ `knob-inventory`,
  `knob-schema`). Runner knobs: `src/runner/knobs/*`. Runtime env: `src/shared/runtime-config/`
  (the ONLY place allowed to read `process.env`; scanner-enforced).
- `src/config/trust-store.ts` — per-project trust, **default UNTRUSTED**, explicit-grant-only,
  path-pinned (mirrors Codex `trust_level` / Claude `hasTrustDialogAccepted`). This is the gate an
  untrusted `base_url` must pass through.
- `src/apps/cli/cli-feature-gates.ts` + `cli-seeded-gates.ts` — `CLI_FEATURE_GATES` (default-OFF
  opt-in seeding). Composition root: `src/runner/assemble/llm.ts` (`createLLM`/`createMulticloudLLM`,
  no `process.env` reads — env passed in).

## Design

Three independent tracks, each default-OFF, sequenced D1 → D2 → A6.

### D1 — declarative provider config (the seam)

Add a `DeclarativeProvider` config record + a `resolveDeclarativeLLM(cfg, env) → LLMPort`
composition-root entry that **mirrors `createMulticloudLLM`** (factory.ts:733) but constructs an
**existing OpenAI-wire adapter** with the declared `base_url`/headers instead of a hard-wired cloud
adapter. No new adapter class — reuse `OpenAIAdapter` (chat) / `OpenAIResponsesAdapter` (responses).

```
DeclarativeProviderConfig {
  id: string                 // user label, e.g. "fireworks"
  base_url: string           // REQUIRED; trust-gated (see Trust+auth)
  wire_api: "chat" | "responses"   // closed union; default "chat"
  model: string              // REQUIRED (no port-level default — factory.ts rationale)
  api_key_env?: string       // env var NAME holding the key (never the key itself)
  env_http_headers?: Record<string,string>  // header name → env var NAME (NOT value)
  http_headers?: Record<string,string>       // static headers (non-secret only; see audit)
  request_max_retries?: number   // 0..N; maps to SDK maxRetries
  query_params?: Record<string,string>
}
```

Resolution: a new `src/llm/providers/declarative-adapter.ts` builds the `openai` SDK client with
`{ baseURL, apiKey: env[api_key_env], maxRetries, defaultHeaders, defaultQuery }` and delegates
`stream()` to the existing `OpenAIAdapter`/`OpenAIResponsesAdapter` internals. It reports
`transportId:"declarative"`, `surfaceId` from `wire_api`, `authMode:"custom-endpoint"`.

Wiring point: `resolveOpenAISurface` (factory.ts:366) **already** picks responses-vs-chat off
baseURL — for declarative we honor the explicit `wire_api` instead of inferring, so a custom
endpoint never silently gets the wrong grammar.

**Why this is the right seam:** `LlmProvider extends LLMPort` (provider-port.ts:152), so a
declarative provider is plug-compatible everywhere the loop expects `LLMPort` — zero loop changes.

### D2 — ollama / lmstudio as CHAT

Both expose an **OpenAI-compatible** `/v1/chat/completions` endpoint (ollama since 0.1.x; LM Studio
native). So D2 is a **thin preset over D1**, not a new adapter:
- `ollama-chat` → `base_url: http://localhost:11434/v1`, `wire_api: "chat"`, `api_key_env` unset
  (local, no key — the SDK sends a placeholder key; verify ollama ignores it).
- `lmstudio` → `base_url: http://localhost:1234/v1`, `wire_api: "chat"`.

Named presets live beside the declarative resolver. **Parity risk is the payload, not the
transport** — see audit R2 (tool-call streaming shape from local models).

### A6 — WS turn transport (measure-first, greenfield)

Behind `QUANTA_LLM_WS_TRANSPORT=1` (default-OFF). A new `LlmProvider` implementation that speaks the
Responses-over-WebSocket framing, selectable only when the endpoint advertises it. **No efficacy
claim.** Ships with a measurement harness (A/B on our SWE-bench f2p, per memory
`mini-swe-baseline-harness`) — NOT enabled by default until measured. `enable_request_compression`
is a sub-knob of A6, same posture. This track is explicitly LAST and may be dropped if D1/D2
measurement shows no demand.

## Config schema

Reuse the **existing config framework** (`src/config/`), NOT a new knob system. Declarative
providers live under a `[model_providers.<id>]`-shaped section parsed by `src/config/loader.ts`
into a `Record<string, DeclarativeProviderConfig>`, merged via `src/config/merge.ts`, validated by
a new schema in `src/config/knob-schema/schemas/`. Selection env var `QUANTA_PROVIDER=<id>` already
exists (factory.ts:408 `pickProvider`) — extend its lookup to consult the declarative map AFTER the
6 built-ins (built-ins win; a declarative id never shadows `anthropic`).

`env_http_headers` and `api_key_env` store **env var NAMES**, never secret values — the loader must
reject a config that puts a value resembling a secret directly in `http_headers` (audit R2).

## Trust + auth

- **base_url is untrusted input.** A declarative `base_url` from a project-local config file is an
  SSRF / credential-exfil vector: a malicious repo AGENTS.md-style config could point `base_url` at
  an attacker host and set `env_http_headers: {authorization: ANTHROPIC_API_KEY}` to **exfiltrate
  the real Anthropic key**. Mitigations (all required):
  1. Declarative providers are **only loaded from a trusted path** — gate through
     `src/config/trust-store.ts` (default UNTRUSTED). An untrusted project's `[model_providers]`
     block is **ignored**, not merged. Mirror `createMulticloudLLM`'s env-passed discipline.
  2. `env_http_headers` may reference an env var only from an **allowlist** — by default just
     `{api_key_env}`'s own var; referencing `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`AWS_*` from a
     third-party endpoint's headers requires an explicit `--allow-cross-provider-headers` opt-in
     (default deny). This stops a Fireworks endpoint from harvesting the Anthropic key.
  3. `base_url` scheme allowlist: `https://` always; `http://` only for loopback
     (`localhost`/`127.0.0.1`/`::1`) — needed for D2 local, refused otherwise (prevents plaintext
     credential leak to a remote http host).
  4. The declarative path **cannot bypass** existing auth/safety: the loop, permission kernel, and
     redaction sit ABOVE `LLMPort`; a declarative provider is just another `LLMPort`. No new
     tool-access or approval surface is created (verify in audit — no `@/permission` import in the
     new slice).
- **No credential leakage in logs:** the new slice must NOT log resolved header values or the API
  key — reuse the existing no-leak discipline (`credential-helper.ts` H7 taxonomy drops helper
  output). Add a redaction pin test.

## Default-OFF gate

- No `[model_providers]` config present ⇒ **byte-identical** existing behavior; the declarative
  resolver is never consulted (fast path, like `resolveProvider` falling to `default`).
- The 6 built-in adapters and `createLLM`/`createMulticloudLLM` are **untouched** — new code lives in
  `src/llm/providers/declarative-adapter.ts` + a resolver, added to the registry's *string-id*
  lazy-resolve path (an unknown id today already lazy-throws; declarative extends that to
  "resolvable-if-configured").
- A6 gated by `QUANTA_LLM_WS_TRANSPORT` (default-OFF); off ⇒ SSE path unchanged.
- Seed via `CLI_FEATURE_GATES` (`cli-seeded-gates.ts`) so the surface is opt-in; document the gate
  removal in the same array if ever removed (memory: `cli-feature-gates-default-opt-in`).

## TDD + hellgate

Follow hellgate (RED e2e → TDD → 3R adversarial → self-audit) +천공카드 (static-first,
leaf-crate units — no expensive build):
1. **RED e2e:** a declarative config pointing at a **fake OpenAI-compatible server** (in-process
   fetch stub) → assert a full turn streams tokens + a tool call round-trips. Fails before impl.
2. Unit: `resolveDeclarativeLLM` precedence (built-in id wins over declarative id); trust-gate
   (untrusted path ⇒ block, assert the block, red-on-injection); scheme allowlist (remote http ⇒
   refused); cross-provider-header deny; header/key redaction pin.
3. D2: ollama/lmstudio preset → base_url/wire_api resolution; **tool-call streaming parity** against
   a recorded local-model cassette (the real risk, audit R2).
4. Wiring proof: assert the declarative `LLMPort` flows through `assemble/llm.ts` into a real
   `runAgent` turn (not just constructed) — per memory `jul-15-real-loop-e2e` (`runAgent ×
   scripted-LLM` witnesses, no vacuous stub-only unit).
5. Drift guard: `wire_api` is a closed union with an exhaustiveness assert (mirror
   `provider-types.ts:118`).
6. **Non-vacuity:** every test must fail under mutation (assert-then-narrow, real-effect
   observation) — per `test-quality-culture-portable`.

## Effort

- D1: **M** (~1 new adapter file reusing OpenAI wire, 1 resolver, 1 schema, trust wiring, ~15 tests).
  The wire code + `baseURL` support + resolver template all already exist — this is assembly, not
  greenfield.
- D2: **S** (thin presets over D1 + parity cassette).
- A6: **L** + a measurement campaign; may be dropped. Do NOT start until D1/D2 land and demand is
  shown.

## Risks + traps

- **Trap: `OPENAI_BASE_URL` already exists** (factory.ts:481) as a one-endpoint escape hatch —
  declarative config must not double-wire it. Precedence: explicit declarative id > `OPENAI_BASE_URL`
  > default.
- **Trap: god-code ratchet** (god-MODULE >1000 / god-FN >150, `AGENTS.md:59`). `factory.ts` is
  already **826 lines** — do NOT add the declarative resolver there; put it in a new file.
- **Trap: 3 parallel knob systems** — grep before adding config (memory
  `knob-config-systems-inventory`). Reuse `src/config/` + `runtime-config`, not a 4th.
- **Trap: wire_api mismatch** — a chat-only endpoint given `wire_api:"responses"` (or vice-versa)
  400s at runtime. Honor the **explicit** `wire_api` (don't infer off base_url like the built-in
  auto path) and surface a typed `provider-misconfigured` early.
- **Trap: local model tool-call shape** — ollama/lmstudio stream `tool_calls` deltas differently
  (some emit the whole call in one chunk, some omit `index`); the OpenAI adapter's
  `RawChunk.tool_calls[].index` assembly (openai.ts:74) may mis-accumulate. Parity cassette required.
- **Risk: measure-first honesty for A6** — no latency/cost claim may ship without an A/B on our f2p
  (memory `no-heuristics-only-validated`, `feedback-no-optimistic-judgment`).
- **Risk: SSRF via base_url** — see Trust+auth; scheme allowlist + trust-store gate are load-bearing.

## Sequencing

1. D1 declarative resolver + adapter + trust gate + schema (RED e2e first).
2. D2 ollama/lmstudio presets + parity cassette.
3. (Only if demanded + measured) A6 WS transport behind knob + measurement harness.

Each lands independently, default-OFF, byte-identical when unconfigured.

## Open questions

- Q1: Config file format — reuse the existing `src/config/loader.ts` TOML/JSON shape, or a
  quanta-native section? (Prefer existing; needs a loader read to confirm the section grammar.)
- Q2: Does ollama's `/v1/chat/completions` require ANY placeholder API key, or reject the
  `Authorization` header? (Verify against a live ollama in the D2 RED e2e.)
- Q3: Should `request_max_retries` map onto the SDK `maxRetries` (openai.ts:363) or the
  `RecoveryRouter` port (retry/port.ts:42)? SDK is simpler and matches Codex semantics; RecoveryRouter
  is richer but per-adapter. Lean SDK for D1.
- Q4: A6 — is the WS framing `responses_websocket` a documented public Responses feature or a Codex
  internal? If internal-only, A6 is likely undroppable-vaporware; confirm before any effort.

---

## Audit log R1 → R3

### Round 1 — objective/structural

- **F1 (CORRECTED, grounding error in mandate):** mandate says "quanta has … a realtime WS adapter."
  Grep `websocket|realtime|wire_api|responses_websocket` over `src/llm/` = **0 turn-transport hits**
  (only `stream-progress-trace.ts:57` TraceTimer). quanta has **no WS transport**. A6 is greenfield,
  not "switch an existing adapter." RFC corrected in Current-state + Non-goals.
- **F2:** "reuse existing OpenAI-wire + retry port." Confirmed reusable: `OpenAIConfig.baseURL`
  already exists (openai.ts:19,364); `createMulticloudLLM` (factory.ts:733) is a ready template.
  BUT the "retry port" (`retry/port.ts` `RecoveryAction`) is a *routing* port, not a *named
  retry-config struct* — Codex's `request_max_retries` maps more cleanly to the SDK `maxRetries:2`
  constant (openai.ts:363). Recorded as Open-Q3, not silently conflated.
- **F3 (god-code):** `factory.ts` is 826 lines — adding a resolver there risks the >1000 ratchet.
  RFC mandates a new file. Logged as a trap.
- **F4 (default-OFF):** confirmed the byte-identical path: no `[model_providers]` ⇒ resolver never
  runs, 6 built-ins untouched. Matches `createMulticloudLLM`'s opt-in posture (factory.ts:592 comment).

### Round 2 — adversarial (break it)

- **A1 — credential exfil via env_http_headers (HIGH):** a project-local declarative config could set
  `base_url` to attacker host + `env_http_headers:{authorization: "ANTHROPIC_API_KEY"}` and steal the
  real key on the first turn. **Mitigation added:** cross-provider-header allowlist (default deny —
  headers may reference only the provider's own `api_key_env`), + trust-store gate (untrusted path ⇒
  block the whole block), + `--allow-cross-provider-headers` explicit opt-in. This is now a
  load-bearing part of Trust+auth, with a **red-on-injection** test in TDD §2.
- **A2 — SSRF / plaintext leak via base_url (HIGH):** remote `http://` base_url leaks the key in
  cleartext; internal `http://169.254.169.254` hits cloud metadata. **Mitigation:** scheme allowlist —
  `https` always, `http` loopback-only (needed for D2). Refuse otherwise.
- **A3 — auth/safety bypass (checked, NOT a hole):** does declarative config bypass the permission
  kernel? No — permission/redaction/loop sit ABOVE `LLMPort`; a declarative provider is just an
  `LLMPort`, creates no tool/approval surface. RFC pins this and adds a "no `@/permission` import in
  the new slice" audit check. Verified the plane-clean discipline the existing port enforces
  (provider-port.ts:11).
- **A4 — wire_api mismatch (MED):** inferring responses-vs-chat off base_url (the built-in auto path,
  factory.ts:366) would silently 400 a chat-only custom endpoint. **Fixed in design:** declarative
  honors the *explicit* `wire_api`, typed `provider-misconfigured` on mismatch — never infers.
- **A5 — ollama tool-call parity (MED):** local models stream `tool_calls` deltas in shapes the
  OpenAI adapter's `index`-keyed accumulator (openai.ts:74) may not handle. Not hand-waved — a
  recorded parity cassette is a REQUIRED D2 test (TDD §3), and Open-Q2 flags the placeholder-key
  question. No efficacy claim that "ollama chat just works."
- **A6-audit — WS measure-first (enforced):** RFC makes **zero** latency/cost/throughput claim for
  A6; it ships default-OFF behind a knob whose ONLY purpose is to enable an A/B on our f2p. A6 is
  sequenced last and explicitly droppable (Open-Q4: framing may be Codex-internal vaporware).

### Round 3 — self-audit (turn the audit on the RFC itself)

- **S1 — did I plant a vacuous "trust gate"?** Re-examined: the trust-store gate is only meaningful
  if the loader actually consults it BEFORE merging `[model_providers]`. RFC now states the untrusted
  block is *ignored, not merged* (not merged-then-flagged), and TDD §2 asserts the block with a
  red-on-injection (untrusted ⇒ provider absent, not "present-but-warned"). Without the readback the
  gate would be theater.
- **S2 — is D2 genuinely "thin over D1," or am I hiding work?** Honest: D2's transport IS thin (same
  OpenAI wire), but the **payload parity** (tool-call/streaming shape) is real, non-trivial work — I
  moved it from "S trivial" to "S + parity cassette" and made it a named risk (A5), not buried.
- **S3 — is the "reuse OpenAI-wire, no new adapter" claim vacuous?** Partly self-corrected: we DO add
  one file (`declarative-adapter.ts`) that constructs the SDK client with custom
  headers/baseURL/retries and delegates `stream()`. It is NOT "zero new code" — it is "zero new *wire
  grammar* code." RFC wording tightened to say reuse the wire, not reuse nothing.
- **S4 — default-OFF byte-identity actually provable?** The claim rests on the resolver never running
  when unconfigured. Flagged that the ONLY safe wiring is the registry's existing lazy string-id path
  (registry.ts:107) — extending it must not change resolution for the 6 known ids. Added a
  byte-identity test obligation (built-in ids resolve identically with/without a `[model_providers]`
  block present).
- **S5 — Open-Q4 honesty:** if `responses_websocket` is a Codex-internal (not a public Responses
  feature), A6 has no reachable endpoint and is un-absorbable. I did NOT pretend A6 is shovel-ready;
  it is gated behind confirming the framing is public FIRST. Measure-first + exists-first, per memory.

**Convergence:** R2 surfaced two HIGH security holes (A1 credential exfil, A2 SSRF) that R1's
structural pass missed — both now load-bearing mitigations with red-on-injection tests. R3 caught two
of my own over-claims (vacuous trust gate S1, "zero new code" S3) and tightened them. No unresolved
HIGH remains; the residual risks (A5 parity, A6 vaporware) are explicitly measurement/verification-
gated, not asserted away.
