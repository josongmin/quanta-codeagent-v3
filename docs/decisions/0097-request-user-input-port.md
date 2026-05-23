# ADR-0097: `request_user_input` host port (ADR-0086 자매)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**:
  - ADR-0086 (`request_plan_exit` tool) — 자매 ADR. 동일한 host-port mirror 패턴.
  - ADR-0095 (Structured plan-mode tools) — 본 ADR이 6번째 AgentEvent pair(`plan_user_input_requested`/`_resolved`)와 짝.
  - ADR-0096 (PlanStore port + slice isolation) — 동일한 duck-typed ToolContext seam 메커니즘.
  - ADR-0036 (plan-mode dispatch-seam mutating block) — 본 도구는 plan posture에서도 허용(read-only + 명시 host I/O).
  - ADR-0069 (typed tool failure) — outcome 닫힌 union 패턴.
- **출처**: [docs/plans/plan-mode-sota-plus-plus.md](../plans/plan-mode-sota-plus-plus.md) §4. Codex의 `request_user_input` *이벤트*를 1급 도구로 승격.
- **참조**: `src/tool/request-user-input.ts`(tool), `src/tool/types.ts`(`UserInputRequester` + outcome mirror), `src/agent/dispatch.ts`(host-port wire), `src/agent/features.ts`(conditional 등록), `src/agent/plan-exit-flow.ts`(ADR-0086 참조 패턴), `src/agent/index.ts`(`AgentConfig.userInputPort`).

## 맥락 (Context)

plan-mode(그리고 default-mode의 깊은 작업) 한가운데에서 모델이 **운영자 결정**을 요구해야 하는 순간이 있다 — "Next.js야 Remix야?", "이 마이그레이션 strategy 둘 중 어느 쪽?", "이 API 키 어디서 가져올까?".

세 모델의 현 상태:

| 모델 | 메커니즘 | 한계 |
|---|---|---|
| **Codex** | `request_user_input` *이벤트* (unidirectional, agent→host only) | 비대칭: 응답이 다음 turn의 message로 들어와 typed contract 없음. inline 도구 호출 불가능. |
| **Cursor** | 없음 (UI 상에서 사용자가 입력 stop·redirect) | typed 도구 surface 없음 — model이 prompt에서 "ask user" 표현으로 emit. |
| **Claude Code** | 없음 (사용자 stop + 새 message) | 마찬가지. typed contract 없음. |

> 우리는 1급 도구(model calls, operator answers via port, model resumes inline)로 만든다. **symmetric**: 모델이 `request_user_input` 호출 → host의 port가 운영자에게 prompt → 운영자가 답 → 도구가 typed outcome relay → 모델이 같은 turn에서 계속.

ADR-0086(`request_plan_exit`)이 같은 host-port mirror 패턴을 plan-exit 결정 surface에 검증했다 — `ToolContext.requestPlanExit` 미러 + `AgentConfig.planExitPort` 주입 + dispatch by-value bridge. 본 ADR은 그 패턴을 **운영자 자유-형식 입력**에 확장한다.

## 결정 (Decision)

ADR-0086 패턴을 그대로 미러링한다.

### Part 1 — `@/tool` seam

`ToolContext.requestUserInput?: UserInputRequester`(`src/tool/types.ts`):

```
export type UserInputOutcome =
  | { decision: "answer"; text: string }
  | { decision: "cancelled" }
export interface UserInputRequester {
  (prompt: string, opts?: { choices?: readonly string[]; multiline?: boolean }): Promise<UserInputOutcome>
}
```

- 닫힌 2-arm union. `decision: "answer"` 시 `text`는 mandatory(빈 문자열도 허용; *cancellation*과 구별).
- `decision: "cancelled"` 시 `text` 없음(`exactOptionalPropertyTypes`).
- `@/tool`은 `@/agent`를 import 안 함 (ADR-0096와 동일 fence). `UserInputOutcome` mirror는 `@/tool/types.ts` 안에 self-contained.

### Part 2 — Tool `src/tool/request-user-input.ts`

```
- 입력 schema (zod): { prompt: string (1..2000), choices?: string[] (≤20), multiline?: boolean }
- isReadOnly: true   (운영자에 영향 0, host I/O만)
- isConcurrencySafe: false  (operator block. dispatch가 다른 작업과 overlap 금지)
- 호출:
    if (!ctx.requestUserInput) → { ok:false, output:"user_input port unavailable", failure:{mode:"rejected", reason:"no_port"} }
    const outcome = await ctx.requestUserInput(prompt, opts)
    switch (outcome.decision) {
      case "answer":    return { ok:true,  output: outcome.text, metadata: { decision:"answer" } }
      case "cancelled": return { ok:false, output:"user cancelled", failure:{mode:"rejected", reason:"cancelled"} }
      default: const _exhaustive: never = outcome
    }
- promptId: tool 자체가 ULID 생성 → metadata로 surface(이벤트 짝지움용).
- throws: port가 throw하면 normalize → { ok:false, output:"port error", failure:{mode:"runtime_error", reason:String(e)} }
```

- ADR-0069 typed-tool-failure(`rejected`/`runtime_error`) 라우팅.
- `isReadOnly: true` 이므로 **plan posture에서도 차단되지 않음**(ADR-0036의 MUTATING_TOOL_TABLE 대조: read-only).
- `isConcurrencySafe: false` 이므로 streaming-dispatch가 *다른 도구와 overlap 금지* — operator 응답 block은 단독.

### Part 3 — `AgentConfig.userInputPort?: UserInputRequester`

```
// src/agent/index.ts
export interface AgentConfig {
  // ... 기존 필드
  userInputPort?: UserInputRequester
}
```

- default-OFF byte-identical: 부재 시 도구 미등록 + ctx 필드 omit.
- 운영자 surface(CLI prompt / IDE modal / web dialog)가 `userInputPort` 구현 책임.
- agent core는 outcome 정규화만 — UX는 surface가.

### Part 4 — dispatch bridge

```
// src/agent/dispatch.ts (간략)
if (config.userInputPort) {
  ctx.requestUserInput = config.userInputPort
}
```

- ADR-0086의 `requestPlanExit` 미러 패턴 그대로.
- mirror 타입이 *값으로 동형*이라 by-value(no adapter 필요 — ADR-0096보다 단순. shape 변환 0).

### Part 5 — Conditional 등록 in `@/agent/features.ts`

```
if (config.userInputPort) features.push(requestUserInputTool)
```

- port 미주입 시 registry에 없음 → loop byte-identical. 도구 미등록과 ctx 필드 omit이 짝이 되어 default-OFF 보장.

### Part 6 — AgentEvent 짝 (ADR-0095 6 이벤트 중 2개)

ADR-0095에서 정의한 두 이벤트가 본 도구와 짝:

- `plan_user_input_requested { promptId, prompt, choices? }` — tool 호출 시 emit.
- `plan_user_input_resolved { promptId, decision, text? }` — outcome 정규화 후 emit.

`promptId`(ULID)는 두 이벤트를 짝지을 stable key. surface(UI)는 두 이벤트 사이에 modal/inline-prompt를 띄움.

## 흡수 비교 (Adopt vs Deliberately-NOT-adopt)

| 차원 | Codex | Cursor | Claude | 우리 결정 | 사유 |
|---|---|---|---|---|---|
| 운영자 입력 surface | event (read-only) | 없음 | 없음 | **1급 도구 (model calls, operator answers, inline resume)** | symmetric. typed contract. typed-failure 라우팅. |
| 응답 경로 | 다음 turn message | — | — | **same-turn outcome (tool result)** | inline. 모델이 prompt를 새로 만들 필요 없음. |
| Outcome shape | message-based (parse 필요) | — | — | **닫힌 2-arm union (`answer`/`cancelled`)** | typed. exhaustive switch. |
| Multi-choice | 별도 prompt format | — | — | **opt `choices?: readonly string[]`** | 닫힌 enum 응답을 host가 enforce 가능 (UI 책임). |
| Multiline | implicit | — | — | **opt `multiline?: boolean` (hint to host)** | UX hint. agent core는 string으로 동일 처리. |
| Cancellation | message로 표현 | — | — | **명시 outcome variant** | `decision:"cancelled"` typed. tool이 typed failure 라우팅. |
| 3-arm outcome (예: "ask later") | — | — | — | **미흡수** | 닫힌 2-arm 유지. 3+ 확장은 ADR 수정 필요. |
| LLM-주도 prompt-rewrite | — | — | — | **미흡수** | 모델이 prompt 텍스트를 자유 작성 — host는 그대로 표시. agent core가 rewrite 안 함. |

## 근거 (Rationale)

- **모델-주도 = SOTA**: Codex가 event-only로 한 방향만 만든 비대칭은 inline resume을 막는다. tool로 만들면 모델이 *호출 → 결과 → 같은 turn에서 다음 작업* 패턴이 자연스럽다. ADR-0086과 동형.
- **port가 operator UX**: 결정은 host(CLI prompt / IDE modal / web)가. tool은 outcome relay만. plan-exit과 같은 책임 분리(loop는 결정 surface를 *제공*하지 않는다).
- **`isConcurrencySafe: false`**: operator block은 다른 도구와 overlap 금지 — streaming-dispatch의 allSettled 가정에서 *단독 슬롯*. allSettled가 race를 만들지 않게 dispatch 스케줄러가 인지.
- **read-only이므로 plan posture에서도 허용**: ADR-0036 MUTATING_TOOL_TABLE에 등록 안 함(=null=read-only). plan 모드 한가운데서도 호출 가능.
- **typed-failure 라우팅**: `no_port` / `cancelled` / `runtime_error` 셋이 닫힌 reason — ADR-0069 패턴.

## 대안 (Rejected)

- **slash command `/ask <prompt>`**: 기각 — slash는 사용자 수동 트리거. 본 ADR의 사용처는 *모델이 묻고 싶을 때*. slash는 inverse direction.
- **assistant-text "다음을 알려주세요…" + stop**: 기각 — typed contract 부재. 모델이 같은 turn에서 inline resume 못함. parse heuristic 필요(휴리스틱 0 위반).
- **event-only (Codex 식)**: 기각 — 위 비교 표 참조. asymmetric, no inline resume.
- **3-arm outcome (`answer`/`cancelled`/`ask_later`)**: 기각 — 닫힌 2-arm가 명확. `ask_later`는 운영자가 UX에서 dismiss로 표현 가능(→ `cancelled`). 3+ 확장은 ADR 수정 필요.

## 결과·트레이드오프 (Consequences)

- **얻은 것**: 운영자 자유-형식 입력 surface (CLI/IDE/web 모두 같은 port). ADR-0086과 짝이 되어 plan-mode 협업 ergonomics 완결. 31 hellgate / 61 expects.
- **비용**: `@/tool`에 mirror 타입(`UserInputOutcome`/`UserInputRequester`). `AgentConfig` +1 optional 필드. dispatch ctx +1 conditional 필드.

## 한계 (Limitations)

- **(a) blocking on operator**: `isConcurrencySafe: false`. 운영자가 응답하기 전까지 dispatch가 *다른 도구와 overlap 금지*. 본 도구가 streaming-dispatch에 진입하면 allSettled 슬롯 단독 사용. 운영자 timeout은 host 책임(loop는 abort signal만 honor).
- **(b) Outcome는 닫힌 2-arm**: `answer` / `cancelled` 외 variant 추가는 **ADR 수정 필요**. 예: "ask later" / "redirect" 등. 현 단계는 단순함이 SOTA — 운영자 ergonomics가 닫힌 2-arm로 충분.
- **(c) port 구현은 surface 책임**: CLI는 readline / IDE는 modal / web은 dialog. agent core는 outcome 정규화만 — UX 일관성은 surface가 보장. 미구현 surface는 도구 미등록(default-OFF).
- **(d) Replay·persistence**: outcome은 jsonl-recorder의 recovery family로 fold(우리 컨벤션). replay 시 *동일 prompt가 다시 발생하지 않도록* 호스트가 cache (follow-up).
- **(e) Within-turn re-entry 비목표**: 같은 turn 안에서 *연속* `request_user_input` 호출은 허용하지만, *동시* 호출(allSettled)은 dispatch가 직렬화. 동시 두 prompt 띄우는 UX 패턴은 비목표.

## 불변식 (Invariants)

- **byte-identical default**: `AgentConfig.userInputPort` 부재 시 도구 미등록 + ctx 필드 omit. 6 이벤트 중 2개(`plan_user_input_*`) emit 사이트도 미배선.
- **슬라이스 격리**: `@/tool`은 mirror 타입만 (`@/agent` 0 import). dispatch가 by-value bridge(ADR-0096보다 단순 — shape 변환 0).
- **닫힌 outcome union**: `UserInputOutcome` 2-arm exhaustive. switch default-branch `never` 가드.
- **read-only**: `isReadOnly: true`. ADR-0036 MUTATING_TOOL_TABLE에 등록 안 함 — plan posture에서도 차단 안 됨.
- **신규 npm dep 0**.

## 검증 (Verification)

`tests/unit/tool/request-user-input.test.ts` — **31 hellgate / 61 expects**:

- **port 부재**: `ctx.requestUserInput` undefined → `{ok:false, failure:{mode:"rejected", reason:"no_port"}}` graceful.
- **happy answer**: port가 `{decision:"answer", text:"Next.js"}` → `{ok:true, output:"Next.js", metadata.decision:"answer"}`.
- **cancelled**: port가 `{decision:"cancelled"}` → `{ok:false, failure:{mode:"rejected", reason:"cancelled"}}`.
- **빈 문자열 answer**: `{decision:"answer", text:""}` → ok:true (cancellation과 구별). regression guard.
- **sync throw**: port가 즉시 throw → normalized `{ok:false, failure:{mode:"runtime_error"}}`.
- **async throw**: port가 reject Promise → 같음.
- **promptId uniqueness**: 10 연속 호출 → 10개 다른 ULID. ID format 검증.
- **choices passthrough**: opts.choices가 port에 정확히 전달. 빈 배열 / undefined / 20-item 경계.
- **multiline hint**: opts.multiline true/false/undefined 전부 port로 전달.
- **schema rejection**: prompt 빈 문자열 / 2000-char 초과 / choices > 20 / choices 비-string → zod typed rejection.
- **isReadOnly contract**: tool descriptor `isReadOnly === true` (regression guard).
- **isConcurrencySafe contract**: tool descriptor `isConcurrencySafe === false` (regression guard).
- **closed outcome enum**: port가 사인된 `decision: "third_arm"` 반환 시 exhaustive switch가 컴파일 fail (타입 레벨 테스트).

> 31 hellgate / 61 expects. ADR-0095의 plan-mode-e2e 시나리오 3(user_input path)이 본 도구의 통합 회귀 가드.

## ADR-0086 자매 패턴 정렬 표

본 ADR이 ADR-0086을 거울로 만들어졌음을 명시하기 위한 정렬:

| 차원 | ADR-0086 (`request_plan_exit`) | ADR-0097 (`request_user_input`) |
|---|---|---|
| Tool 파일 | `src/tool/request-plan-exit.ts` | `src/tool/request-user-input.ts` |
| ToolContext 필드 | `requestPlanExit?: PlanExitRequester` | `requestUserInput?: UserInputRequester` |
| AgentConfig 필드 | `planExitPort?: PlanExitPort` | `userInputPort?: UserInputRequester` |
| Mirror outcome | `PlanExitToolOutcome` (3-arm) | `UserInputOutcome` (2-arm) |
| Outcome decisions | `approved` / `rejected` / `changes_requested` | `answer` / `cancelled` |
| isReadOnly | true (host I/O) | true (host I/O) |
| isConcurrencySafe | false (operator block) | false (operator block) |
| Dispatch bridge | by-value(shape 동형) | by-value (shape 동형) |
| Conditional 등록 | `config.planExitPort` present | `config.userInputPort` present |
| Default-OFF | byte-identical | byte-identical |
| Slice fence | `@/tool` ↛ `@/agent` | `@/tool` ↛ `@/agent` |
| Typed failure | rejected: forge / out-of-domain | rejected: no_port / cancelled, runtime_error: throw |

> 본 ADR은 ADR-0086의 mechanical mirror. 두 ADR이 의도적으로 같은 *모양*을 가져야 contributor가 학습 비용 0으로 host-port mirror 패턴을 다음 surface에 적용 가능.

## 결과·트레이드오프 보강 (Consequences, expanded)

- **얻은 것 (확장)**:
  - 운영자 자유-형식 입력 surface가 1급 도구로 노출됨.
  - same-turn resume 가능 — 모델이 묻고 답받고 계속.
  - typed outcome으로 모델 prompt에서 "사용자 답을 어떻게 parse하지?" 휴리스틱 0.
  - ADR-0086과 짝이 되어 plan-mode 협업 ergonomics가 4 평면(posture / exit / state / input) 완결.
- **비용 (확장)**:
  - `@/tool/types.ts`에 2 type alias + 1 interface.
  - `AgentConfig` +1 optional field.
  - dispatch ctx +1 conditional field.
  - 신규 zod schema 1 파일.
  - 새 hellgate 1 파일 (31 cases).

## SOTA++ 자리매김 보강

운영자 입력 surface 비교 — *symmetric / typed / inline* 3 차원:

| 모델 | symmetric? | typed contract? | inline resume? | 평가 |
|---|---|---|---|---|
| Codex | ✗ (event, unidirectional) | ✗ (다음 turn message로) | ✗ (다음 turn) | 비대칭 — 모델 prompt 사이클 1회 추가. |
| Cursor | ✗ (UI stop) | ✗ (free text) | ✗ (사용자가 새 message) | typed contract 0. |
| Claude | ✗ (UI stop) | ✗ (free text) | ✗ (사용자가 새 message) | 같음. |
| **우리** | **✓** | **✓ (2-arm closed)** | **✓ (same turn)** | 세 차원 모두 SOTA. |

> 본 ADR이 *세 모델 모두에 없는* 평면을 열었다. 1급 도구 + symmetric + typed + inline — ROI-무관 SOTA++ 흡수의 모범 사례.

## 위험·완화

| 위험 | 완화 |
|---|---|
| operator block이 loop를 stale 시킴 | host가 timeout 책임 (loop는 abort signal honor). 운영자 무응답 → cancellation outcome. |
| 모델이 spam-prompt 운영자 | host가 rate-limit 책임 + ADR-0047 HITL 4-tier로 도구 자체를 `hand_off_required` tier에 둠. |
| port 구현이 surface마다 다른 UX | port interface가 닫힌 contract — UX 일관성은 surface 책임. agent core는 outcome 정규화만. |
| 응답 텍스트에 prompt injection | 운영자 입력은 *trusted* 등급(ADR-0027 anti-signals policy hardening). agent core는 추가 sanitize 하지 않음 — 운영자 의도가 SSOT. |
| replay 시 같은 prompt 다시 발생 | jsonl-recorder가 recovery family로 fold — replay-aware host는 outcome cache 가능(follow-up). |
| timeout 후 늦은 응답 | host의 abort signal이 promise를 reject → tool이 `runtime_error`로 surface. 모델은 typed-failure로 catch. |

## Follow-up

본 ADR이 *닫지 않는* 작업:

- **Replay-aware host cache**: outcome이 같은 prompt에 대해 cached 되도록 host가 ID-based recall. jsonl-recorder와 cross-wire.
- **Choices enforcement**: 현재 `choices?` 는 *UX hint*. host가 enforce 책임 — agent core는 string answer만 검증. 닫힌-choices outcome variant 추가는 별도 ADR.
- **`/ask <prompt>` slash 짝**: 사용자가 *모델에게* 묻는 inverse direction. ADR-0059 slash 5종 확장으로 가능. 본 ADR과 직교.
