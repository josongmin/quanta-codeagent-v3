# 구현 프롬프트 — T08: model-refusal 복구 (fork + re-prompt)

## 미션
거부 감지 지점에서 terminal error 환원 전에, 기존 `fork_turns`를 재사용해 거부 턴을 fork/중립화하고 `refusal_fallback_prompt`로 **1회 한정** 재프롬프트한다(재거부 시 terminal). provider-agnostic. default-OFF.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/08-model-refusal-recovery.md` 정독. 통합 `00-index.md §8`. fork 선행 [[jun-08-gap7-8-batch-fork]].

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 유즈케이스 e2e 먼저, 전부 RED. refusal 주입은 env-driven replay LLM seam(hermetic).
2. **핵심 로직 TDD + 구조적 구현**: refusal 정규화 seam을 provider-port에, fork→재프롬프트를 루프에 구조적으로.
3. **적대적 어딧 ≥3R**: 무한 거부 루프, provider별 신호 차이, fork 비용 2배(budget).
4. **셀프 어딧**.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** false-refusal 복구: 모델이 거부 → fork+중립화(`neutralizedByFork`) + `refusal_fallback_prompt` 재프롬프트 → 두 번째 시도 성공. e2e: 사용자 개입 없이 복구 단언.
- **UC2** 1회 한정: 재프롬프트 후 **또 거부하면 즉시 terminal**(red-on-injection: **2회 이상 재시도하면 red**).
- **UC3** default-OFF: 게이트 OFF면 기존대로 terminal error(byte-identical).
- **UC4** provider 양쪽: OpenAI/Anthropic refusal 신호가 정규화 seam 거쳐 동일 경로(OpenAI-specific 패턴 박지 말 것).
- **UC5** budget: fork가 budget 초과면 복구 안 하고 terminal.

## 코드 앵커 (실측)
- terminal refusal 지점: `src/llm/openai-responses-wire.ts:727`("terminal refusal → surface via error").
- refusal 정규화 seam: `src/llm/providers/provider-port.ts`.
- fork: `fork_turns`(LIVE, jun-08).

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A(루프/wire 행동). **knob**: `QUANTA_REFUSAL_FALLBACK`(bool,false) → knob-inventory `{group:"llm",home:"runtime-config",readSite:"llm/openai-responses-wire.ts"}`.
- **CLI+Web**: 투명; 복구 발생을 item/system 이벤트로 노출(T01)하면 "refusal recovered" 가시화. **config**: `refusal_fallback_prompt` 템플릿(default 内蔵). 재시도 횟수=1 하드코딩(휴리스틱 knob 금지).

## 규율
- 1회 한정 하드룰(n>1 측정 없이 금지, [[no-heuristics-only-validated]]). provider 정규화 seam 필수. default-OFF byte-identical. claim-100 ⇒ ≥3R. worktree 시 HEAD==main+ff.
