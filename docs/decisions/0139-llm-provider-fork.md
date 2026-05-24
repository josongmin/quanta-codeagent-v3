# ADR-0139: LLM provider fork — Anthropic 전송 4갈래(default/bedrock/vertex/foundry) 헥사고날 포트

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0002 (OpenAI provider — 첫 provider seam), ADR-0066 (model-swap retry — 같은 wire-grammar 가족), ADR-0094 (ChatGPT-OAuth adapter — sibling adapter slice), ADR-0140 (background-subagent caller wire — 같은 default-OFF posture)
- **참조**:
  - `src/llm/providers/provider-port.ts` — closed port (4-arm `ProviderId` 유니온 + `ProviderError` 3-code)
  - `src/llm/providers/default-adapter.ts` — public `api.anthropic.com` (legacy `AnthropicAdapter` 위임)
  - `src/llm/providers/bedrock-adapter.ts` — AWS Bedrock (Phase 1: missing-dep typed-throw)
  - `src/llm/providers/vertex-adapter.ts` — GCP Vertex (Phase 1: missing-dep typed-throw + auth-failed)
  - `src/llm/providers/foundry-adapter.ts` — Azure AI Foundry (Phase 2 STUB)
  - `src/llm/providers/registry.ts` — `resolveProvider(explicit?, env?)` 5-tier 우선순위
  - `src/llm/providers/index.ts` — 배럴
  - `tests/unit/llm-providers/{port,registry,default-adapter,bedrock-adapter,vertex-adapter}-hellgate.test.ts` — 5 파일 / 50+ case

## Context

엔터프라이즈 데이터 거버넌스는 **vendor (Anthropic)** 와 **transport (api.anthropic.com vs AWS Bedrock vs GCP Vertex vs Azure Foundry)** 를 분리해서 본다 — 모델 가중치와 wire grammar 는 동일하나 billing account / residency boundary / IAM 표면이 다르다. 기존 `LLMPort` (= "어느 vendor 의 grammar 인가") 는 transport 차원을 모델링하지 않아 BYOK 외 경로를 막아 두었다.

다른 modern agent harness 의 자리:

- Claude Code 2.1 — `ANTHROPIC_BEDROCK` / `ANTHROPIC_VERTEX` env 박혀 있되 closed-source, port shape 비공개
- Codex 0.131 — Anthropic 미지원 (OpenAI-only)
- Cursor 3.2 — server-side gateway (transport selection 미노출)
- v0.dev — 단일 transport

= "Anthropic 4 transport 를 typed closed-port 로 분리하면서 default-OFF 로 legacy path 와 공존하는 최초 OSS 구현".

## Decision

7-part. 신규 slice 단독 — 기존 `@/llm/adapters/*` / `@/llm/factory.ts` 수정 0 (default-OFF 약속).

### Part 1 — `provider-port.ts` closed-port

- `ProviderId = "default" | "bedrock" | "vertex" | "foundry"` 4-arm closed union (추가 transport = 1 entry edit + 1 factory edit + ADR follow-up).
- `ProviderAuth` 단일 struct (per-transport discriminated union 거부 — fallback chain 시 caller 가 ONE credential bundle 만 들고 다님). 각 transport 는 필요 subset 만 읽음.
- `ProviderConfig.model` REQUIRED (port layer 에서 default 가정 금지 — 그 정책은 `@/llm/factory.DEFAULT_MODEL` 한 단 위).
- `ProviderError` + `ProviderErrorCode` 3-arm closed: `provider-unsupported` / `provider-misconfigured` / `provider-missing-dependency`. `cause` 는 exactOptional discipline (정의됐을 때만 super 로 forward).
- `LlmProvider extends LLMPort` + `providerId` 필드 — 구조적 확장으로 plug-compatible 보장.

### Part 2 — `default-adapter.ts` legacy 위임

기존 `AnthropicAdapter` 한 줄 wrap. 재구현 0 (`thinking carry-over` / `prompt-prefix caching` / `image / document blocks` / `tool_choice` mapping / `stream-hang guards` / `SDK-shape-drift exhaustiveness pins` 전부 그대로). `apiKey` 비어 있으면 typed `provider-misconfigured`.

### Part 3 — `bedrock-adapter.ts`

- Lazy dynamic `import("@anthropic-ai/bedrock-sdk")` — optional dep (메인 install 에 없음). 부재 ⇒ `provider-missing-dependency` typed-throw ("install @anthropic-ai/bedrock-sdk" 명시).
- 4 static AWS creds 모두 OPTIONAL — 부재 ⇒ SDK 의 default cred chain (env / IMDS / IRSA / SSO) fallback.
- Phase 1 posture: 생성자 통과 + `stream()` 첫 호출에서 missing-dep typed-throw. Phase 2 wiring 은 `mapRawEvent` 재사용으로 wire 동일.

### Part 4 — `vertex-adapter.ts`

- bedrock 과 동일 lazy-import 패턴, target `@anthropic-ai/vertex-sdk` (`AnthropicVertex`).
- `gcpProjectId` + `gcpLocation` REQUIRED — Vertex URL `projects/{id}/locations/{loc}/...` 합성 불가능 시 typed-fail. 부재 ⇒ `provider-misconfigured` ("auth-failed" 메시지 명시). closed `ProviderErrorCode` 유니온에 별도 `auth-failed` arm 두지 않은 이유: "config field 부재" 가 정확히 misconfigured 의 정의 — arm 분리는 caller 분기를 무의미하게 늘림.
- `gcpAccessToken` 부재 ⇒ ADC (Application Default Credentials) fallback (`google-auth-library`).

### Part 5 — `foundry-adapter.ts` STUB

Azure AI Foundry 는 first-party `@anthropic-ai/foundry-sdk` 부재 (2026-05). raw `fetch` 로 fake 하면 wire shape lock-in 위험 → typed stub: 생성자 통과 + `stream()` 즉시 `provider-unsupported` ("Foundry adapter is Phase 2"). `azureEndpoint` / `azureApiKey` 슬롯 이미 `ProviderAuth` 에 박혀 있어 Phase 2 는 pure adapter swap.

### Part 6 — `registry.ts` 5-tier 우선순위

```
1. explicit id 인자 (caller wins, trim 후 closed-union check)
2. ANTHROPIC_BEDROCK_BASE_URL → bedrock
3. ANTHROPIC_VERTEX_BASE_URL  → vertex
4. ANTHROPIC_FOUNDRY_BASE_URL → foundry
5. fallback → default
```

`env` 인자로 주입 (no `process.env` 직접 접근 — `@/llm/factory` 의 `EnvLike` SSOT 와 미러). Unknown id ⇒ resolve 시점에 throw 안 함, lazy-throw factory 반환 (status panel 이 "you asked for X" 표시 가능하도록).

### Part 7 — `index.ts` 배럴 + 5 hellgate 파일

- 배럴: port 타입 + 4 adapter + registry 재export.
- 5 hellgate 파일 (`tests/unit/llm-providers/*-hellgate.test.ts`):
  - **port** (~10): name / 3-code / exactOptional cause / providerId 부착 / 4 id 라운드트립
  - **registry** (~15): 5-tier 우선순위 / unknown lazy / trim / empty-string env / env-key 노출
  - **default-adapter** (~8): id 고정 / 잘못된 providerId 거부 / 빈 apiKey 거부 / stream() AsyncIterable
  - **bedrock-adapter** (~8): 빈 auth OK / full creds OK / missing-dep typed-throw (live path — SDK 미설치)
  - **vertex-adapter** (~11): projectId/location 필수 / "auth-failed" 메시지 / 빈-문자열 거부 / missing-dep typed-throw

## Default-OFF posture

```
caller 가 @/llm/providers 를 import 하지 않으면
  ⇒ @/llm/factory 경로 byte-identical (AnthropicAdapter 직접 wrap 그대로)
  ⇒ ToolRegistry / Loop / Prompt 변화 0
  ⇒ legacy BYOK 경로는 ADR 채택 전과 100% 동일
```

assembly auto-registration 없음 — 호출자가 의식적으로 `resolveProvider(explicit, env).factory(config)` 박을 때만 활성. `@/llm/factory.createLLM` 은 본 ADR 을 모르고 — Phase 2 (caller wire-up ADR) 에서 opt-in flag 로 router 와 합류.

## Hellgate count

5 파일 / 50+ case (정확히 port 10 + registry 15 + default 8 + bedrock 8 + vertex 11). 핵심 봉인:
- `ProviderError.cause` exactOptional (super 호출 분기로 검증)
- registry 우선순위 (3 env × 4 explicit × precedence 매트릭스)
- unknown id lazy-throw (resolve 는 throw 안 함)
- Vertex auth-failed 메시지 명시 (`gcpProjectId` / `gcpLocation` 토큰 모두 포함)
- Phase 1 missing-dep typed-throw — 실 코드의 missing-dep arm 이 live path (메인 install 에 optional dep 부재)

## Alternatives rejected

1. **transport 를 `LLMPort` 에 직접 추가**
   - `LLMPort` 는 "어느 vendor 의 grammar 인가" 만 모델링 — transport 를 섞으면 OpenAI / Anthropic adapter 가 무관한 4-arm transport 유니온을 의식해야 함.
   - 거부 — port-segregation 위반 (ISP). 새 port 로 분리해서 `LlmProvider extends LLMPort` 의 구조 확장으로 plug-compatibility 만 유지.

2. **per-transport discriminated `ProviderAuth` 유니온**
   - 타입은 더 tight 하나, fallback chain (`default → bedrock`) 시 caller 가 union 변환 boilerplate 를 매번 작성.
   - 거부 — 단일 struct + 각 transport 가 필요 subset 만 읽는 패턴이 실제 사용 ergonomics 우월.

3. **eager `import` (top-level) 으로 bedrock/vertex SDK 끌어오기**
   - 메인 install 에 optional dep 강제 ⇒ `bun install` 시 ~10MB 불필요 graph.
   - 거부 — lazy dynamic import 로 첫 호출까지 cost defer (Codex / Cursor 모두 같은 패턴).

4. **unknown id 에 `resolveProvider` 즉시 throw**
   - status panel 이 "you asked for X" 표시하려면 try/catch 강제.
   - 거부 — lazy-throw factory 반환 (id 는 echo back), factory 호출 시점에 typed-throw. caller 가 panel/log 분기 자유.

5. **Vertex auth-failed 를 별도 `ProviderErrorCode` arm 으로**
   - `provider-unsupported` / `provider-misconfigured` / `provider-missing-dependency` 3 arm 으로 sufficient — "config field 부재" 가 misconfigured 의 정의.
   - 거부 — closed union 확장은 caller 분기 N+1 증가시키나 의미 차이 미세 (메시지로 충분히 disambiguate).

6. **Foundry 를 raw `fetch` 로 Phase 1 wiring**
   - Azure AI Foundry 의 wire shape 가 official SDK 출시 전까지 shift 가능 — fake wiring 은 향후 SDK 출시 시 deprecate 비용.
   - 거부 — typed stub (생성자 OK + `stream()` `provider-unsupported`) + `azureEndpoint` / `azureApiKey` 슬롯 선점.

## SOTA++ 매트릭스

| 시스템 | 4-transport | typed closed port | lazy SDK import | unknown lazy | hellgate |
|---|---|---|---|---|---|
| Claude Code 2.1 | ✓ (env 박힘) | ✗ (closed src) | ✗ (unknown) | ✗ | ✗ |
| Codex 0.131 | ✗ (Anthropic 미지원) | N/A | N/A | N/A | N/A |
| Cursor 3.2 | server gateway | ✗ (closed) | ✗ | ✗ | ✗ |
| v0.dev | ✗ (단일) | ✗ | ✗ | ✗ | ✗ |
| **quanta** | **✓ (4-arm 포트)** | **✓ (3-code error)** | **✓ (dynamic import)** | **✓ (factory throw)** | **✓ (5 파일 / 50+ case)** |

= "Anthropic 4 transport 를 typed closed-port + 3-code ProviderError + lazy SDK import + unknown lazy-throw 로 봉인하면서 default-OFF 로 legacy path 와 공존하는 최초 OSS 구현".

## Follow-up (본 ADR 이 닫지 않음)

- **`@/llm/factory.createLLM` 와 router 합류** — opt-in flag (`createLLM({providerRoute:"auto"})`) 로 본 ADR 의 `resolveProvider` 호출 + Phase 1 SDK 부재 시 graceful fallback 으로 legacy path.
- **Phase 2 wire — bedrock + vertex `stream()` 본체** — `mapRawEvent` 재사용으로 wire 동일성 보장 + provider-specific event quirk (Bedrock 의 `messageStart` 직전 metadata block 등) 매핑.
- **Foundry adapter Phase 2** — official `@anthropic-ai/foundry-sdk` 출시 시 typed stub 교체 (`azureEndpoint` + `azureApiKey` 슬롯 이미 박힘).
- **CLI flag** — `--provider <id>` + `--provider-list` (PROVIDER_ENV_KEYS 노출).
- **OTel attribute** — `llm.provider.id` span attribute (`default` / `bedrock` / `vertex` / `foundry`).
- **provider-fallback chain** — `[bedrock, default]` 시퀀스로 missing-dep 시 자동 graceful 전환 (deferred-wire 가 아닌 첫-class 정책 결정 필요).
