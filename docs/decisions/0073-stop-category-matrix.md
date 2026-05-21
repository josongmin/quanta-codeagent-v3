# ADR-0073: StopCategory matrix — 구조적 정지 사유 (Cursor 흡수, Spec B3)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0062(Submission op envelope), `cursor-3.2-absorption.md`, `src/agent/retry.ts`(classifyLLMError), `src/shared/errors.ts`. Cursor `stop_category` 흡수.

## 맥락

레거시 `StopReason`(`completed | max_turns | aborted | error`)은 4-element enum이라 "exhausted" / "errored" / "aborted"를 넘어 **왜** 멈췄는지 말할 수 없다. surface가 actionable copy를 렌더하려면("rate limit이니 잠시 후 재시도" vs "승인 대기로 일시정지" vs "사용자가 Esc") 방출된 `error`/`recovery` 이벤트를 sniff해 재분류해야 했다 — 깨지기 쉽고 out-of-band.

Cursor의 `stop_category`는 3-layer 구조: (1) `kind` 거친 버킷(UI 게이팅용), (2) `reasonCode` 안정 namespaced 코드(분석/i18n용), (3) `hint` 옵셔널 human copy.

## 결정

신규 순수 모듈 `src/agent/stop-category.ts`:

- **`StopCategoryKind`** — 닫힌 버킷: `completed | max_turns | interrupted | failed | needs_user_approval`. 레거시 `StopReason`과 매핑(completed⇄completed, max_turns⇄max_turns, interrupted⇄aborted, failed⇄error, needs_user_approval⇄error의 hand-off 변종).
- **`StopCategory { kind; reasonCode; hint? }`**.
- **`STOP_REASON_CODE`** — canonical namespaced 코드 테이블(call site가 쓸 수 있는 유일한 문자열): `provider.{rate_limit,overloaded,network,auth,bad_request,unknown}`, `compaction.thrash`, `user.interrupt`, `system.abort`, `shell.needs_approval`, `runtime.unknown_error`, `completed.{normal,max_turns,empty_exhausted,malformed_exhausted}`. 새 코드 추가는 이 테이블 확장이 유일한 경로.
- **`classifyErrorReason(reason)`** — 레거시 `error` 자유형식 reason 텍스트를 구조적 `StopCategory`로 분류. NEVER throws — 신호 없으면 `runtime.unknown_error`. 순수(IO/clock 0). specificity 순서 휴리스틱(compaction thrash → provider.* → fallback).
- **`completedCategory(via)`** — normal/max_turns/empty_exhausted/malformed_exhausted.
- **`interruptedCategory(cause)`** — user(`user.interrupt`) / system(`system.abort`).

loop.ts 배선: `finish(reason, turns, stopCategory?)` 3rd 인자 추가. aborted⇒`interruptedCategory("user")`, error⇒`classifyErrorReason(result.reason)`, completed⇒`completedCategory("normal")`, max_turns⇒`completedCategory("max_turns")`. `exactOptionalPropertyTypes`: stopCategory 있을 때만 spread.

`AgentOutcome.stopCategory?: StopCategory` 옵셔널 필드 추가.

## 근거

- **레거시 `reason`이 authoritative 유지**: 모든 shipped consumer가 `reason`을 읽음. `stopCategory`는 옵셔널 add-on ⇒ 부재 callers byte-identical (RFC §1.2).
- **순수 분류, 단일 string-sniff 사이트**: provider 분류는 loop의 stringified `LLMError`를 읽어 패턴 매치 — errors.ts 계약이 문자열을 고정하므로 brittle하지 않음(테스트가 계약 문서). 코드베이스 유일한 sniff 사이트로 격리.
- **닫힌 코드 테이블**: `reasonCode`를 analytics-stable하게 유지, grep으로 모든 emit 사이트 열거 가능.

## 대안

- **`StopReason` enum 직접 확장**: 기각 — shipped consumer의 exhaustive switch를 전부 깸. 옵셔널 add-on이 default-OFF 보장.
- **이벤트 sniff 유지**: 기각 — out-of-band, 깨지기 쉬움.
- **자유 문자열 reasonCode**: 기각 — analytics drift, i18n 불가. 닫힌 테이블이 안정성.

## 결과·트레이드오프

- **얻은 것**: 구조적 3-layer 정지 사유, 순수 분류기, loop 4-경로 배선. 15 unit + loop 배선 테스트 green.
- **비용**: `needs_user_approval` / `shell.needs_approval` / empty·malformed_exhausted 세분은 헬퍼는 있으나 loop이 `result.kind==="completed"`로 collapse하므로 현재 `completed.normal`만 emit(헬퍼는 future 사용).

## 한계 (LIMITATIONS)

- (a) `needs_user_approval` / `shell.needs_approval`는 admissibility-gate seam 예약 — 미배선.
- (b) loop의 completed-via-exhaustion(empty/malformed)이 `completedCategory("normal")`로 보고됨 — 세분 emit은 follow-up(헬퍼는 이미 4-sub-kind 지원).
- (c) provider 분류는 errors.ts stringify 계약에 의존 — 그 계약 변경 시 매핑 테스트가 loudly 깨짐(의도된 가드).

## 불변식 영향

- **byte-identical default**: stopCategory 부재 시 outcome 모양 무변경(legacy callers `stopCategory: undefined`조차 관측 불가).
- **`reason` authoritative 유지**: top-level outcome 무변경.
- **슬라이스 격리**: `@/agent/stop-category`는 순수, 상향 import 0.
- **신규 npm dep 0**. **NEVER throws**.
