# ADR-0066: 모델 교체 retry — SubmitRetryBotMessage 흡수 (v0.dev)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: `src/agent/retry.ts`(RetryingLLM, 동일 모델 transient), `src/llm/fallback.ts`(FallbackLLM, provider 사망 failover), ADR-0059(built-in slash commands), `v0-dev-feature-review.md` §S급-5(모델별 Retry).

## 맥락

v0.dev는 `SubmitRetryBotMessage { messageId, retryModelId }`로 응답 단위로 다른 모델로 같은 질문을 재시도한다(opus→max). `getEnabledModelFallback()`이 ordered list에서 에스컬레이션. v3에는 두 종류 재시도가 이미 있으나 이 의미론은 없었다:

- `RetryingLLM`: 동일 모델, transient pre-stream 실패 backoff 재시도.
- `FallbackLLM`: provider가 죽었을 때 backup으로 자동 failover.

둘 다 **사용자/loop가 의도적으로 다른 모델을 골라 그 turn을 재생성**하는 것과 다르다.

## 결정

신규 모듈 `src/llm/model-swap.ts` + L3 CLI wire `src/apps/cli/retry-with.ts`:

- `ModelCandidate { id, port }`, `ModelSwapRetryOptions { candidates }`.
- `pickNextModel(current, orderedIds): id|null` — 순수, wrapping 없음.
- `resolveRetryModel({current, candidates, requested?}): ModelCandidate` — requested distinct면 그것, 없으면 다음 후보; distinct 대안 없으면 `NoAlternateModelError extends QuantaError`.
- `streamWithModel(candidate, input): AsyncIterable<StreamEvent>` — leading `stream_reset` 후 선택 port로 재스트림.
- L3 CLI: `/retry-with [<model-id>]` 슬래시 커맨드(BUILTINS 6번째). `SlashContext.retry?: RetryWithSessionState` opt-in. 미설정/빈 candidates ⇒ "no model candidates configured" + exit 1 (NEVER silently 성공). `dropLastAssistantMessage`로 직전 assistant turn 제거 후 재스트림.
- `AgentConfig.modelCandidates?: readonly ModelCandidate[]` opt-in.

`RetryingLLM`/`FallbackLLM` 무변경.

## 근거

- **3종 재시도의 명확한 분리**: transient / provider 사망 / **의도적 모델 교체**는 trigger·의미론이 다르다 — 별도 모듈로 의도 명시.
- **`stream_reset` 재사용**: 교체 재스트림은 직전 partial 폐기 — 이미 정의된 tombstone 의미론 차용(신규 event 타입 0).
- **wrapping 금지**: 후보 끝에서 처음으로 돌면 무한 에스컬레이션 — `null`/throw로 명시 종료.
- **CLI 라우터 데이터 주도**: BUILTINS 배열에 1 entry 추가만 — dispatch(`runSlashCommand`)는 무수정(ADR-0059 패턴).
- **순수 + 낮은 슬라이스**: `@/llm` 슬라이스(`@/agent` 타입 불필요).
- **NEVER silent**: 미설정 시 사용자에게 명시 메시지 + exit 1.

## 대안

- **RetryingLLM 확장**: 기각 — transient(동일 모델, 자동) vs 의도적 교체(다른 모델, 사용자) — 의미 혼탁.
- **FallbackLLM 재사용**: 기각 — failover는 "죽어서 어쩔 수 없이", 교체는 "더 나은 답 원해서" — UX 다름.
- **wrapping 허용**: 기각 — 무한 에스컬레이션 위험.

## 결과·트레이드오프

- **얻은 것**: 의도적 모델 교체 재시도 seam + CLI surface(escalation + 명시 선택). 11 (model-swap) + 16 (CLI) + 50 (slash router regression) unit green. 기존 retry/fallback 무변경.
- **비용**: AgentConfig +1 field (modelCandidates?), SlashContext +1 field (retry?).

## 한계 (LIMITATIONS)

- (a) REPL/세션 surface가 `SlashContext.retry`를 실제로 주입해야 작동 — host wiring 필요.
- (b) v0 `v0-auto` 같은 백엔드 라우터/브랜딩은 미흡수 — 후보 list 구성은 호출자 책임.

## 불변식 영향

- **byte-identical default**: 미설정 시 기존 LLM 경로·슬래시 라우터 무변경. `RetryingLLM`/`FallbackLLM` 코드 0 변경.
- **슬라이스 격리 유지**: `@/llm`은 `@/agent`/`@/tool` 미import.
- **`StreamEvent` union 불변**: `stream_reset` 재사용.
- **신규 npm dep 0**.
