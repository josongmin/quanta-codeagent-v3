# ADR-0094: ChatGPT-OAuth provider — BYOK 없이 구독계정으로 모델 호출

- **상태**: Proposed (본문만, 코드/배선 follow-up 슬라이스 분해 예정)
- **출처**: Codex Desktop OAuth 플로우 in-house 분석 (코퍼스 `~/agent-analysis/unpacked/codex-desktop/`, 2-pass Explore agent)
- **참조**: 메모 [codex-desktop-build-2867-round-4](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/codex-desktop-build-2867-round-4.md), [codex-desktop-build-2867-round-2](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/codex-desktop-build-2867-round-2.md), [codex-feature-catalog-2026-05-21](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/codex-feature-catalog-2026-05-21.md)

## Context

현재 quanta의 OpenAI provider는 **BYOK(Bring Your Own Key)** 만 지원 — `OPENAI_API_KEY` 환경변수 또는 설정값으로 받은 API 키를 `api.openai.com`에 직접 호출. 별도 API 결제 계정이 필요하다.

ChatGPT Plus/Pro/Team 구독자에게는 별도 path가 존재: Codex CLI/Desktop은 PKCE OAuth로 ChatGPT 계정 토큰을 받아 `https://chatgpt.com/backend-api/codex/responses`로 호출 — **API key 없이 구독 메시지 쿼터로 빌링**된다. `api.openai.com`이 아니라 `chatgpt.com/backend-api`라는 사실이 결정적 — 별도 빌링 라인, 별도 모델 캐탈로그(`gpt-5-codex` 계열 위주), 별도 레이트 리밋(주간 메시지). 즉 단순 base URL 스위치가 아니라 **별도 provider**로 다뤄야 한다.

Codex Desktop 분석에서 확정된 사실 (코퍼스 `codex-desktop/main.js` 인용):
- PKCE S256 + 32B random verifier (line 42107, 42128-42135)
- Authorize endpoint: `https://auth.openai.com/oauth/authorize` (line 42043, env override `CODEX_APP_SERVER_LOGIN_ISSUER`)
- 로컬 콜백: 고정 포트 **1455** → 사용 중이면 **1457**, 경로 `/auth/callback`, 타임아웃 10분 (line 42045-42047)
- Token exchange: `POST /oauth/token` (line 42145)
- API 호출 헤더: `Authorization: Bearer {access_token}` + `ChatGPT-Account-Id: {jwt.chatgpt_account_id}` + `OAI-Product-Sku: CODEX` + `originator` (line 10567-10589)
- Plan tier from JWT: claim `chatgpt_plan_type` (line 22360) — Free/Plus/Pro/Team을 *별도 API 호출 없이* 토큰에서 추출

## Decision

신규 provider `chatgpt-oauth` 를 BYOK provider(`openai`)와 **형제**로 추가. 두 provider는 같은 `LlmFactory` seam에 등록되지만 토큰/엔드포인트/모델 캐탈로그/빌링 라인 전부 분리.

### 모듈 구조

```
src/auth/chatgpt-oauth/
├── pkce.ts              # S256 challenge + 32B random verifier
├── browser-flow.ts      # authorize URL + open browser + 로컬 콜백 서버 (1455→1457)
├── token-store.ts       # ~/.quanta/auth/chatgpt.json 0600 R/W
├── refresh.ts           # 만료 검사 + refresh_token 교환 + 동시 refresh 가드
└── jwt.ts               # base64url payload decode + chatgpt_plan_type/account_id 추출 (외부 lib 0)

src/llm/providers/chatgpt-oauth.ts   # provider adapter (factory에 등록, default-OFF)
```

### 5개 계약(contracts)

1. **OAuth 메커니즘 byte-identical 흡수.** PKCE S256, 32B random verifier base64url, `state` random+검증, 콜백 포트 1455 → 1457 fallback, `/auth/callback`, 10분 타임아웃. Codex의 모든 선택은 *의도된 채택* (저들이 검증한 path를 재발견할 비용 없음). `client_id`/scope만 우리 식별자(follow-up).
2. **호출 헤더 박힘.** Base URL `https://chatgpt.com/backend-api`, `Authorization: Bearer {access_token}`, `ChatGPT-Account-Id: {jwt.chatgpt_account_id}`, `OAI-Product-Sku: <Phase 1 = CODEX 호환, Phase 2 = TBD>`, `originator: quanta`. JWT decode는 외부 lib 0 — payload 부분만 base64url decode + JSON.parse (sub-100 LOC, sig 검증은 OpenAI 백엔드가 수행).
3. **Plan tier gate.** JWT `chatgpt_plan_type` 검사. Free → **즉시 거부**, 에러 카피 "ChatGPT Free does not include API access — upgrade to Plus, or use BYOK provider instead." Plus/Pro/Team만 통과. 별도 `/me` 호출 없음 (1 round-trip 절약 + Codex와 동일 path).
4. **토큰 저장 Phase 1 = `~/.quanta/auth/chatgpt.json`, 0600, 평문.** JSON 스키마: `{ access_token, refresh_token, id_token?, expires_at: ISO8601, account_id, plan_type, last_refresh: ISO8601 }`. 권한 0600 검사를 *읽기 시* 수행, 위반 시 토큰 무효화 + 재로그인 요구. OS Keychain 마이그는 Phase 2 ADR.
5. **Provider 격리 — 공존 + 폴백 금지.** BYOK와 ChatGPT-OAuth가 동시 등록되더라도 *런타임 결정*은 user-explicit (CLI `--provider=chatgpt-oauth` 또는 설정 `llm.provider`). 토큰 공유 금지, 401/403 시 다른 provider로 자동 폴백 금지 (사용자가 의도하지 않은 빌링 라인 사용 차단). 두 provider는 같은 process에서 서로의 token-store 접근 0.

## Default-OFF

provider는 등록만, 활성화는 **사용자 명시 실행**:
- `quanta auth login --chatgpt` (브라우저 1회)
- 토큰 없는 상태에서 `chatgpt-oauth` provider 선택 시 즉시 거부 (브라우저 자동 안 띄움)
- 환경에 `OPENAI_API_KEY`만 있고 provider 미지정 → 기존 BYOK 그대로

## What this is NOT

- ❌ ChatGPT 세션 쿠키 리버싱 아님 (`__Secure-next-auth.session-token` 채굴 X — ToS + 매주 깨짐)
- ❌ 3rd-party 프록시 호출 아님 (사용자 토큰 외부 노출 X)
- ❌ 자동 API-key 발급 아님 (OAuth 토큰으로 `/v1/dashboard/api_keys` 호출 X — 권한 없음 + 빌링 라인 다름)
- ❌ `chatgpt.com/backend-api/conversation` 호출 아님 (ChatGPT 웹 UI 엔드포인트. 우리는 `/codex/responses` Responses-API 모양만)
- ❌ 헤드리스 자동 로그인 아님 (브라우저 1회 필수 — CI/서버는 BYOK)
- ❌ Codex Desktop의 *remote-control enrollment* 플로우 아님 (scope `codex.remote_control.enroll`은 *다른* 흐름; 우리는 모델 호출용)

## Tests (권장 unit 셋, 본 ADR이 닫지 않음)

- `pkce.test.ts` — S256 결정성, 32B 엔트로피, URL-safe base64
- `jwt.test.ts` — 정상 payload decode / `chatgpt_plan_type=free` 거부 / claim 누락 시 정확한 에러 / 변조된 토큰은 백엔드가 거부함을 가정한 통합 테스트로 분리
- `token-store.test.ts` — 0600 권한 검사 / 깨지면 무효화 / 동시 R/W 직렬화
- `refresh.test.ts` — 만료 임박 트리거 / refresh-in-flight 중복 호출 방지 (Codex에 *없는* 가드 — 우리가 추가)
- `browser-flow.test.ts` — 1455 사용 중이면 1457 fallback / 둘 다 사용 중이면 정확한 에러 / state mismatch 거부 / 10분 타임아웃
- `provider.test.ts` — 헤더 5종 모두 / Free plan 거부 / token 없으면 거부 / BYOK provider 토큰 공유 0

smoke: OAuth 모킹 fixture (`tests/smoke/auth/chatgpt-oauth-replay.json`) — 실제 브라우저 안 띄우고 토큰 발급/refresh/호출 전 경로 record/replay. 메모 [smoke-fixture-system](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/smoke-fixture-system.md) 컨벤션.

## Alternatives rejected

1. **세션 쿠키 리버싱**: ChatGPT 웹 쿠키 채굴해서 `/backend-api/conversation` 호출 — ToS 위반, 쿠키 회전 빠름, MFA/CF challenge 깨짐, ban risk. 회색지대 아니라 명백한 위반.
2. **3rd-party 프록시 (예: gpt4free 류)**: 토큰 외부 노출 + 유지 위험 + 정확성 X.
3. **단일 provider에서 dual-auth (BYOK + OAuth 한 클래스)**: 토큰 격리 invariant 깨짐, 폴백 유혹, 테스트 매트릭스 폭증. 형제 provider가 plane-clean.
4. **OS Keychain 우선 (Phase 1부터)**: macOS Keychain은 GUI/엔티타이드 필요 + Linux libsecret + Windows CredentialManager 별도 의존. Phase 1은 0600 파일이 *덜* 안전하나 0 의존, Phase 2 마이그.
5. **Codex의 remote-control enrollment scope 그대로 사용**: 그 scope으로 모델 호출 안 됨 (다른 backend permissioning). OSS `openai/codex` Rust 소스의 `codex login` scope 추출 필요.
6. **Codex CLI 그대로 fork**: 토큰 발급/저장은 빌려도 quanta provider seam과 결합 모양 다름. 메커니즘만 흡수, 어댑터는 별도 작성.

## Follow-up (이 ADR이 닫지 않는 것)

- **`client_id` + scopes 확정**: OSS `openai/codex` Rust 소스에서 `codex login` scope 추출 (현재 코퍼스에 없음). ADR-0094a 또는 본 ADR 수정.
- **CLI 명령 슬라이스**: `quanta auth login --chatgpt`, `auth logout`, `auth status` (token 만료/plan/email 표시)
- **OS Keychain 마이그**: Phase 2 ADR (Tauri/Electron 우선, CLI는 0600 유지)
- **Refresh 동시성 가드**: file-lock 또는 in-process mutex (Codex에도 NOT FOUND — 우리가 *추가*)
- **Headless 감지**: `$DISPLAY` 없음 + browser open 실패 시 정확한 에러 + BYOK 안내
- **모델 캐탈로그 분기**: ChatGPT-OAuth가 호출 가능한 모델 목록 (`gpt-5-codex` 위주, `o1-pro` 류 일부 불가). provider 메타에 `availableModels` 박힘.
- **레이트 리밋 매핑**: 구독 메시지 쿼터(주간) vs API TPM 단위 다름. 응답 헤더에 잔량 오는지 확인 후 telemetry 매핑.
- **`OAI-Product-Sku` 정책**: Phase 1은 Codex SKU(`CODEX`) 호환 — 백엔드에서 동일 분류로 처리 보장. Phase 2 quanta-specific SKU 결정.

## SOTA++ 자리매김

- Codex Desktop = **OAuth + 모델 호출만**, BYOK 코드 자체 없음 (Desktop은 ChatGPT 구독 전제)
- Codex CLI = OAuth + BYOK 둘 다 지원하나 *별도 binary path*
- **quanta** = **두 provider가 한 binary에서 형제로 공존**, 토큰 격리 + 폴백 금지 + tier-aware gate + refresh 동시성 가드(Codex에 없음)

= "ChatGPT 구독 path와 BYOK path를 plane-clean하게 공존시킨 첫 OSS agent". 사용자 선택권 + 토큰 보안 invariant.
