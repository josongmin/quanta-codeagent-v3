# ADR-0120: Refusal `stop_reason` typed surface — Gap-1 SOTA++

> NOTE: this ADR was initially drafted as #0118 but bumped to #0120 at integration
> because numbers 0118 (localize-recall + shadow-odb-rewind) and 0119 (shadow-
> rewind-tool-exposure) were claimed by parallel work landing on main concurrently.

- **상태**: Accepted (구현 + 19 unit hellgate + 7 e2e + 30 cross-file 봉인)
- **날짜**: 2026-05-23
- **관련 ADRs**:
  - **ADR-0076 Gap-1** (이번 라운드가 superseded) — provider refusal `stop_reason="refusal"` 분기 신설. 당시 `{do:"error", reason:"Model refused…"}` 로 generic error 봉합 → host 가 "model declined" vs "loop failed" 를 구분할 수 없는 lossy 표면이었다.
  - **ADR-0073** (Spec B3) — `StopCategory` 타입형 surface. 이번 라운드의 `refusal` kind 추가가 그 카탈로그 확장.
- **참조**:
  - `src/agent/recovery.ts` — `extractRefusalRationale()` 헬퍼 + `{do:"refusal", rationale}` action 변형 + `decideOnAssembled` refusal 분기 교체
  - `src/agent/loop.ts` — `TurnResult.kind = "refusal"` 변형 + `applyAction` dispatch + 아웃터 루프 → `finish("refusal", turn, refusalCategory(), {rationale})` + `extractRefusalRationale` re-export
  - `src/agent/types/agent-outcome.ts` — `StopReason += "refusal"` + `AgentOutcome.refusal?: {readonly rationale: string}`
  - `src/agent/stop-category.ts` — `StopCategoryKind += "refusal"` + `STOP_REASON_CODE.MODEL_REFUSAL = "model.refusal"` + `refusalCategory()`
  - `src/agent/session-resources.ts` — `emitWorkMetrics(resultKind)` union 확장 (`"refusal"` 진입 시 정상 emit, 모든 work-metrics rail 통과)
  - `src/apps/agent/run.ts` — `exitCodeForOutcome` 표에 `refusal → 3` 항목
  - `tests/unit/refusal-handling.test.ts` — 19 unit (extractor + decide + byte-identical fence)
  - `tests/integration/agent-refusal-e2e.test.ts` — 7 e2e (baseline + H1~H6 hellgate, ScriptedLLM driven)
  - 기존 `tests/unit/recovery-hell.test.ts` / `tests/integration/refusal-multi-turn-carryover.test.ts` / `tests/unit/streaming-dispatch-refusal-shortcircuit.test.ts` — Gap-1 라운드 빅테스트 30+ 케이스 (이미 SOTA++ 가정으로 갱신되어 있던 상태 → 본 ADR 구현으로 green)

## Context

ADR-0076 Gap-1 에서 refusal `stop_reason` 의 fall-through 버그 (모든 unrecognized stop → `proceed` → `completed`) 는 막았다. 그 라운드의 대안은 `{do:"error", reason:"Model refused to continue (stop_reason=refusal); …"}` 였다. 안전하지만 **lossy**:

1. **Host 가 구분 못함.** `outcome.reason === "error"` 만 보면 "loop 가 망가졌나? provider 가 죽었나? 모델이 거부했나?" 가 unrecognizable. 모든 운영 표면 (CLI exit code / Web UI / CI bot) 이 똑같이 "error" 로 색칠.
2. **거부 사유 (rationale) 가 free-form 에러 메시지 안에 묶임.** 모델은 사실 `Refusing — policy X.` 같은 visible-text 블록을 message 에 실어 보내는데, 우리는 그걸 추출하지 않고 고정 문자열 "Model refused to continue (stop_reason=refusal); the assistant message carries the refusal rationale…" 로 갈음했다. Host UI 가 fixed copy 를 보여줄 수밖에 없음.
3. **분석/관측 분류 어려움.** `agent.stop_reason.error` counter 가 "real loop error" + "refusal" + "PTL 실패" 등을 한 통에 섞음. 거부 비율 / 트리거 / 분포를 분석하려면 message stream 을 직접 grep 해야 함.
4. **운영자 자동화 깨짐.** CI bot / cron run / shell script 가 exit code 1 로 똑같이 fail — "refusal 은 retry 무의미하니 사람이 봐야 함" vs "transient error 는 자동 retry" 가 구분 안 됨.

요컨대 *signal vs noise* 가 같은 채널에 묶여 있어 다운스트림에서 분리 못함.

## Decision

`refusal` 을 1급 typed surface 로 끌어올린다. 5 part — 전부 default-OFF + byte-identical (refusal 이 안 일어난 모든 세션은 옛 outcome 과 한 비트도 다르지 않음).

### Part 1 — `RecoveryAction` 확장 + `extractRefusalRationale()` (`recovery.ts`)

```ts
export type RecoveryAction =
  | { do: "backoff"; attempt: number }
  | { do: "compact" }
  | { do: "nudge"; keepMessage: boolean; text: string; reason: RecoveryReason }
  | { do: "proceed" }
  | { do: "completed" }
  | { do: "refusal"; rationale: string }   // ← 신규
  | { do: "error"; reason: string }

export const extractRefusalRationale = (m: AssembledMessage): string => {
  const parts: string[] = []
  for (const b of m.content) if (b.type === "text") parts.push(b.text)
  return parts.join("\n\n").trim()
}
```

`decideOnAssembled` 의 refusal 분기:

```ts
if (stopReason === "refusal")
  return { do: "refusal", rationale: extractRefusalRationale(message) }
```

추출 규칙 (의도적 closed set):
- `text` 블록만 합침. `thinking` / `redacted_thinking` 은 모델의 *내부* 추론이고 거부 SAY 가 아님 → 노출 안 함 (UX 일관성 + 콘텐츠 정책).
- `tool_use` 블록은 무시. 거부가 동시에 tool_use 를 실은 경우는 모델 버그지만 streaming-dispatch tombstone 으로 *어차피* 실행 안 됨 (별도 ADR-0076 Gap-5). rationale 텍스트는 여전히 surface 해야 운영자가 *왜* 인지 봄.
- Multi `text` 블록은 `"\n\n"` 으로 join. 단일 블록일 때 byte-identical.
- 결과는 `.trim()` 으로 whitespace-only 입력을 `""` 로 정규화. **`""` ≠ `undefined`** — 빈 문자열은 "거부 했지만 사유 텍스트 없음" 의 typed 신호 (`AgentOutcome.refusal.rationale === ""`), `undefined` 는 "refusal 자체가 없음" (`AgentOutcome.refusal === undefined`). 이 구분은 host UI 의 "Refused without rationale" copy 라우팅에 필요.
- 길이 truncate 없음. 16k 유니코드 / RTL / NULL byte 전부 verbatim 보존. 클립이 필요한 host 는 직접 한다.

Same-turn recovery budgets (`rec.outputContinues` / `malformedRetries` / `consecutiveEmpties`) 는 **건드리지 않음**. Refusal 은 terminal — retry slot 이 아님. 이 invariant 는 hellgate (10 회 연속 refusal 후 `rec` 가 fresh 와 toEqual) 로 봉인.

### Part 2 — `StopReason` + `StopCategory` 확장 (typed run-end surface)

```ts
// types/agent-outcome.ts
export type StopReason =
  | "completed" | "max_turns" | "aborted" | "error" | "budget_exhausted"
  | "refusal"  // ← 신규

export interface AgentOutcome {
  reason: StopReason
  turns: number
  messages: Message[]
  stopCategory?: StopCategory
  // …
  refusal?: { readonly rationale: string }  // ← 신규, omitted when reason ≠ "refusal"
  // …
}

// stop-category.ts
export type StopCategoryKind =
  | "completed" | "max_turns" | "interrupted" | "failed" | "needs_user_approval"
  | "refusal"  // ← 신규 — `failed` 아님 (모델이 *의도적으로* 거부 = correct behavior),
               //   `completed` 아님 (작업 미완료)

STOP_REASON_CODE.MODEL_REFUSAL = "model.refusal"

export const refusalCategory = (): StopCategory => ({
  kind: "refusal",
  reasonCode: STOP_REASON_CODE.MODEL_REFUSAL,
  hint: "Model declined to continue.",
})
```

**왜 `refusal` 이 별도 `StopCategoryKind` 인가?** 기존 5 buckets 어느 것에도 *정확하게* 안 맞음:
- `completed` ⇒ 작업이 끝난 게 아니라 거부됨. 분석 grep 이 succeed bucket 으로 잡으면 거짓 success rate.
- `failed` ⇒ provider/loop 가 망가진 게 아니라 모델이 의도적으로 결정. 알람을 무는 게 부적절.
- `interrupted` ⇒ user/system abort 가 아님 (모델 측 종료).
- `max_turns` / `needs_user_approval` ⇒ 무관.

새 bucket 을 추가하는 비용 (`StopCategoryKind` enum 1 줄 + reasonCode 1 줄 + helper 1 함수) vs 잘못된 기존 bucket 에 강제로 매핑하는 비용 (영구적인 analytics noise) — 본 ADR 은 전자를 선택.

### Part 3 — `TurnResult` 변형 + `applyAction` dispatch (`loop.ts`)

```ts
type TurnResult =
  | { kind: "tools"; … }
  | { kind: "completed"; … }
  | { kind: "aborted" }
  | { kind: "error"; reason: string }
  | { kind: "refusal"; rationale: string; message: AssembledMessage }  // ← 신규
```

`applyAction` 에서 `action.do === "refusal"` 도착 시:
1. 거부 assistant message 를 `wm.append()` — 트랜스크립트에 모델의 visible refusal text 가 남아야 resume/probe 가 *왜* 거부됐는지 봄 (mirror `completed` path).
2. `{kind:"refusal", rationale, message}` 로 turn 종결.

아웃터 루프에서 `result.kind === "refusal"` 도착 시:
- **`recorder?.turn()` 을 bump** — 거부 턴은 *productive*: 모델이 말했고, 메시지가 떨어졌고, 트랜스크립트에 한 turn 추가됨. `completed` 와 같은 accounting (`turn`, *not* `turn - 1`).
- `finish("refusal", turn, refusalCategory(), {rationale})` 4번째 인자가 신규 — `finish` signature 에 `refusal?: {rationale: string}` 옵션 추가, exactOptional 패턴으로 조건부 spread (`...(refusal ? {refusal} : {})`).

`extractRefusalRationale` 은 `loop.ts` 에서 re-export — 기존 `@/agent/loop` 임포트 경로 (consumer 132 files) 가 바뀌지 않음 (recovery.ts 가 ground truth 이지만 export surface 유지).

### Part 4 — Exit code 매핑 (`run.ts`)

```ts
// apps/agent/run.ts:exitCodeForOutcome
case "refusal": return 3   // ← 신규. 0 ≠ 1 ≠ 3 ≠ 130 (SIGINT)
```

운영 의도:
- **0 = success** ("task completed")
- **1 = generic failure** (loop error / max_turns 도달)
- **2 = budget exhausted** (cost/token cap, retry 가능)
- **3 = model declined** (재시도 무의미, 운영자 개입 필요) ← 신규
- **130 = SIGINT** (POSIX 128 + 2)

CI bot / shell wrapper 가 `if [ $? -eq 3 ]; then notify-on-call …; fi` 를 쓸 수 있게 됨.

### Part 5 — `emitWorkMetrics.resultKind` union 확장

```ts
// session-resources.ts
resultKind: "tools" | "completed" | "aborted" | "error" | "refusal",   // ← + "refusal"
```

거부 턴도 *productive* (모델이 토큰 썼고 응답 어셈블됨) 이므로 work-metrics finalize/emit 을 정상 통과. `"aborted"` 만 short-circuit (work 0).

## Hell-gates (봉인 invariants)

`tests/unit/refusal-handling.test.ts` (19 unit, 신규):
1. Empty content ⇒ `""`
2. Whitespace-only text ⇒ `""` (trimmed)
3. Single text block ⇒ verbatim
4. Multi text blocks ⇒ `"\n\n"` 으로 join
5. `thinking` 만 있는 경우 ⇒ `""` (private reasoning 노출 안 함)
6. `text` + `tool_use` ⇒ text 만
7. `text` + `thinking` ⇒ text 만
8. Interleaved `text` + `tool_use` + `text` ⇒ 두 text 블록 join
9. 16k chars verbatim (no truncate)
10. Unicode + RTL + NULL byte 보존
11. `decideOnAssembled("refusal", …)` ⇒ `{do:"refusal", rationale}`
12. Empty refusal message ⇒ `rationale = ""`
13. Refusal + tool_use blocks ⇒ rationale 추출 still works (모델 버그 케이스)
14. Refusal 이 `streamRetries` / `outputContinues` / `malformedRetries` / `consecutiveEmpties` 어느 것도 소모하지 않음
15. Whitespace-only refusal text ⇒ rationale `""`
16. Thinking-only refusal ⇒ rationale `""`
17. `end_turn` 은 byte-identical proceed
18. `tool_use` + tool block 은 byte-identical proceed
19. `max_tokens` 는 byte-identical nudge

`tests/integration/agent-refusal-e2e.test.ts` (7 e2e via `ScriptedLLM`, 신규):
- **Baseline**: refusal stop_reason → `outcome.reason="refusal"` + `refusal.rationale` + `stopCategory.kind="refusal"` + `done` event 매핑.
- **H1**: 빈 콘텐츠 refusal → `rationale=""`.
- **H2**: multi `text_delta` → 어셈블러가 하나의 text block 으로 묶으므로 rationale 도 한 줄.
- **H3**: refusal + tool_use 인터리브 → tool 실행 안 됨, rationale 추출 정상.
- **H4**: tool 한 턴 → 다음 턴 refusal → 여전히 refusal 라우팅.
- **H5**: refusal 후 retry budget 0 소모 + 1 LLM call 만.
- **H6** (regression fence): `end_turn` outcome 에서 `"refusal" in out === false` (exactOptional).

기존 라운드 hellgates 도 새 contract 로 정렬 (Gap-1 라운드의 30+ cross-file 케이스): `recovery-hell.test.ts` (NI-1/NI-2/precedence/exact-match), `refusal-multi-turn-carryover.test.ts` (M-1~M-5 — 트랜스크립트 carry-over), `streaming-dispatch-refusal-shortcircuit.test.ts`. 본 ADR 구현이 그 30+ 케이스를 모두 green 으로 끌어옴.

## Negative invariants

- **NI-A**: `pause_turn` / `content_filtered` / `guardrail_intervened` 는 미분기 유지. 서버-툴 / Bedrock guardrail 정식 ADR 까지는 fall-through `proceed`. cargo branch 금지 (hellgate 4 케이스가 봉인).
- **NI-B**: `"Refusal"` / `"REFUSAL"` / `"refused"` / `"blocked"` / `" refusal "` (whitespace) / `"user-refusal-override"` 모두 `proceed` 로 fall-through. Exact-literal match. Provider 가 변형 literal 을 쓰면 그건 별도 ADR 로 명시적으로 흡수해야 함 (조용한 case-insensitive false-positive 차단).
- **NI-C**: 거부 시 `rec` (recovery state) 가 단 한 비트도 바뀌지 않음. Idempotent — 같은 `rec` 에 refusal 을 10번 평가해도 `rec.toEqual(freshRecovery())`. Hellgate 봉인.
- **NI-D**: Refusal 이 `pre_tool_use` hook / admissibility gate 를 거치지 않음. Tool dispatch 가 *없으니까* (refusal 은 message stream 종결, tool_use 가 message 안에 있어도 tombstoned). 별도 ADR 필요해질 때까지 host 가 거부를 hook 으로 가로채는 surface 는 없음 (있어야 할 이유가 없음 — 결과를 보고 다음 턴을 dispatch 안 하면 됨).

## Migration

호환성 깨짐 **없음**. Refusal 이 발생하지 않는 모든 세션은:
- `outcome.reason ∈ {completed, max_turns, aborted, error, budget_exhausted}` 그대로
- `outcome.refusal` 필드 OMITTED (exactOptionalPropertyTypes — `undefined` 도 안 박힘)
- `outcome.stopCategory.kind ≠ "refusal"` (모든 기존 kind 그대로)
- exit code 표 의 기존 5 항목 byte-identical

Refusal 이 발생하던 (이전 라운드 ADR-0076 Gap-1 후) 세션은:
- 이전: `outcome.reason="error"` + 고정 문자열 reason
- 이후: `outcome.reason="refusal"` + `outcome.refusal.rationale="<모델 visible text>"` + `outcome.stopCategory.kind="refusal"` + exit code 3

이는 **의도된 surface 변화** — host 가 "model refused" 를 인지하고 분기하기 위한 입구다. 옛 contract 를 핀한 테스트 (`recovery.test.ts` 2개) 는 SOTA++ contract 로 갱신.

## Trade-offs

- (+) Host UI / CI / 운영자 자동화가 refusal 을 분기 가능 (typed 1급 시그널).
- (+) Refusal rationale 이 trans transcript + outcome 둘 다에 visible (디버그 / postmortem 친화).
- (+) Analytics counter (`agent.stop_reason.refusal`) 가 자동 분리 — refusal 비율을 추적 가능.
- (−) Surface 1개 추가 (`refusal`) → host 코드가 5-arm switch 를 6-arm 으로 확장해야 (typecheck 가 강제). 우리 메인 surface (4 mode-presets + run.ts) 는 이번에 모두 갱신.
- (−) `StopCategoryKind` enum 도 6 종으로 늘어남. 같은 비용/이득.

수용. ADR-0073 의 "open-bucket 확장" 패턴 답습 — 새 typed signal 이 필요하면 enum 을 키우고 기존 buckets 를 오염시키지 말 것.

## v3 ↔ Codex / Claude 대조

- **Codex** (codex-rs `loop.rs`): `stop_reason` 자체가 typed enum, refusal 변형은 별도 `OutcomeKind::Refused`. 우리 ADR-0118 이 그 surface 와 의도적으로 비슷한 형태 (`StopReason.refusal` + `outcome.refusal.rationale`).
- **Claude Code** (Anthropic SDK): `stop_reason: "refusal"` 자체가 wire 에서 1급 literal. 우리는 그 wire literal 을 outcome surface 까지 그대로 끌어올림 (host 가 wire 와 outcome 두 곳에서 일관된 라벨 사용).
- **Cursor**: stop_reason literal 자체가 protobuf 에 없음 (구조적으로 refusal 을 별도 InteractionUpdate 로 표현). 우리는 Codex/Claude 의 typed-literal 진영 채택.

본 ADR 은 Codex 의 "outcome kind 가 1급" 철학을 우리 stop_reason 표면에 적용한 것과 동등.
