# T08 — model-refusal 복구 (fork/neutralize + re-prompt)

**현황:** ❌ CONFIRMED-GAP · **ROI:** ★★ (신뢰성) · **게이트:** `QUANTA_REFUSAL_FALLBACK`(default-OFF)

## 무엇 (코퍼스 증거)
Claude Code IDE **2.1.170** 신규(manifest 동일, 코드만): 모델이 거부하면 그 턴을 **fork/중립화**(`type:"system", subtype:"model_refusal_fallback"`, `{neutralizedByFork:true}`)하고 `refusal_fallback_prompt`로 **재프롬프트**한다. 즉 거부를 막다른 에러로 두지 않고 복구 경로로 흡수.

## 왜 가져오나
신뢰성 직결. quanta는 현재 거부를 **terminal error로 표면화**할 뿐 복구가 없다 → 사용자가 수동 재시도해야 함. Claude의 fork-and-reprompt는 자동 복구.

## quanta 현황 (코드 앵커)
- `src/llm/openai-responses-wire.ts:727` — "terminal refusal → surface via `error`". 복구 경로 없음.
- broad-grep(refus/neutraliz/fallback-prompt/re-prompt) 결과 거부 **복구** 메커니즘 0 (있는 건 MCP user-denied, win32 shell refusal 등 무관).
- **단 fork 능력은 이미 있음** — `fork_turns`([[jun-08-gap7-8-batch-fork]] LIVE). 즉 빠진 건 "거부 감지 → fork → 중립화 → 재프롬프트" 배선뿐.

## 제안 접근
1. 거부 감지 지점(`openai-responses-wire.ts:727` terminal refusal)에서 error-환원 전에 fallback 분기.
2. 기존 `fork_turns` 메커니즘 재사용 — 거부 턴을 fork, refusal 메시지를 `neutralizedByFork` 표식으로 중립화.
3. `refusal_fallback_prompt`(설정 가능 템플릿)로 1회 재프롬프트. 재거부 시 terminal error로 폴백(무한루프 방지, 1회 한정).
4. provider-agnostic: refusal 신호는 provider마다 다름([[quanta-v3-state]] dual provider) — `src/llm/providers/provider-port.ts`에 refusal 정규화 seam.

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — 루프/provider-wire 행동, 도구 아님.
- **CLI+Web:** 투명(양 surface 공통 루프). 복구 발생을 item-level(T01) 또는 system 이벤트로 노출하면 "refusal recovered" 가시화(북극성).
- **knob:** `QUANTA_REFUSAL_FALLBACK`(bool, default false) → knob-inventory `{group:"llm", home:"runtime-config", readSite:"llm/openai-responses-wire.ts"}`. orphan ratchet 등록 필수.
- **config:** `refusal_fallback_prompt` 템플릿을 config에 노출(default 内蔵). 단 1회-한정 재시도 횟수는 하드코딩(휴리스틱 knob 금지, [[no-heuristics-only-validated]]).

## 함정
- 무한 거부 루프 — **1회 한정** 하드룰(재거부 시 즉시 terminal). n>1 재시도는 측정 없이 금지.
- provider별 refusal 신호 차이 — 정규화 seam 없이 OpenAI-specific 패턴 박지 말 것.
- fork가 토큰/비용 2배 — budget 경계 확인.

## DoD
- 거부 감지 → fork → 1회 재프롬프트 → (재거부 시) terminal; default-OFF byte-identical.
- e2e: refusal 주입 시 fallback 1회 발화 + 재거부 시 정확히 terminal(red-on-injection: 2회 이상 재시도하면 red).
- provider 양쪽(OpenAI/Anthropic) refusal 정규화 검증.
- ≥3R 적대어딧.
