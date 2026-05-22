# ADR-0089: Lint-grounded reflect gate with typed 3-way decision

- **Status**: Proposed (design draft — NO implementation; default-OFF seam intended, byte-identical when unwired)
- **Date**: 2026-05-22
- **Related**: ADR-0063 (plan-exit 3-way gate — `plan-exit.ts` / `plan-exit-flow.ts`), ADR-0065 (workMetrics — `work-metrics-collector.ts`), ADR-0076/0079 (verify-guard / closeout-guard finish-time discipline), ADR-0067 (user-intent discipline — minimize interruptions), the verify-workflow memory note (tsc/biome/test as the local lint source), [cursor-deep-dives.md §7.2](../analysis/code-agent-loop/cursor-deep-dives.md) (AiBranchService reflect findings), [[v0-dev-absorption-2026-05-21]] (deferred-as-variant regression trap).
- **Absorbed from**: Cursor 3.2.16 `aiserver.v1.AiBranchService.OpusChainReflect` + `aiserver.v1.HallucinatedFunctionsService.Opus2ChainReflect`.

> 한국어/영어 혼용. 이 문서는 **제안(Proposal)** 이며 코드/테스트는 포함하지 않는다. 흡수 대상은 패턴(typed reflect decision + lint-grounding)이지 Cursor의 별도 Opus chain 루프가 아니다.

---

## 1. Context

### 1.1 Cursor evidence (AiBranchService §7.2)

Cursor 3.2.16의 `aiserver.v1.AiBranchService`(descriptor `dby`, 6 메서드)는 멀티파일 edit chain이다:
`OpusChainGetPlan`(stream) / `OpusChainGetFilePaths`(unary→ranked `Path[]`) / `OpusChainGetFileInstruction`(unary) / **`OpusChainReflect`(stream)** / `RecordAcceptedPatch` / `ReportModeSelection`.

핵심은 **`OpusChainReflect` — 파일 edit *후* 의 self-critique gate**. 그 입력과 출력이 portable IP다:

- **Lint-grounded input**: reflect는 모델의 자기 서술이 아니라 **실제 diff** (`old_file_contents`, `new_file_contents`, `patch_string`) **+ 진짜 linter 출력** (`lints: GetLintsForChangeResponse`) + plan context를 받는다. 즉 "내가 잘 고친 것 같다"가 아니라 "린터가 뭐라 하는가"에 근거(grounding)한다.
- **Typed `Decision` oneof** (streamed `text` + 구조화 decision):
  - `accept` → 커밋 진행.
  - `retry_without_more_information` → 컨텍스트는 충분, 그냥 재시도.
  - `retry_with_codebase_question{ codebase_questions[] }` → **"고치기 전에 찾아봐야 함"**. 구조화된 질문을 반환하고, 그 답이 다음 `OpusChainGetPlan`의 QA 컨텍스트로 환류한다.
- **Paired telemetry**: `RecordAcceptedPatch{ patch, source, reflection }` — 받아들여진 패치에 그 출처(source)와 reflection 텍스트를 함께 적재.

### 1.2 v1/v2 dual-generation = 의도적 stable contract

같은 3-case `Decision` oneof가 **두 세대에 걸쳐 동일하게 등장**한다:
- v1: `AiBranchService.OpusChainReflect`.
- v2: `HallucinatedFunctionsService`(`Opus2ChainPlan` / `Opus2ChainApplyPlan` / `Opus2ChainReflect`).

서비스 이름·세대가 바뀌어도 `accept | retry_without_more_information | retry_with_codebase_question` 3-case가 보존됐다는 것은, 이 decision shape이 우연한 구현 디테일이 아니라 **의도적으로 안정적인 코어 계약**임을 시사한다. 흡수 가치를 높이는 결정적 증거다.

### 1.3 quanta의 현 상태 — 갭

quanta는 finish-time/posture 디시플린이 이미 강하다:
- `closeout-guard.ts` — 종료 직전 1-shot reminder (R1–R4 defended-claim, 4-truth-surface). 단 **자연어 reminder**일 뿐 typed decision도, 실제 lint 주입도 없다.
- `plan-exit-flow.ts` / `plan-exit.ts` (ADR-0063) — `approved | rejected | changes_requested` typed 3-way gate. 단 **plan posture 전용**이고, "더 찾아봐야 함"이라는 3번째 의미(needs-context)가 없다.
- verify-guard (ADR-0076) — mutating 후 test/repro 강제. 단 **bash 패턴 매칭 게이트**일 뿐 그 결과를 reflect 입력으로 모델에 되먹이지 않는다.

즉 quanta에는 **(a) 실제 lint/typecheck 출력에 근거한(lint-grounded)** + **(b) typed 3-way decision을 emit하는** + **(c) "찾아봐야 함"을 구조화 질문으로 search-first에 환류하는** reflect gate가 없다. 본 ADR이 이 갭을 채운다.

---

## 2. Decision

파일 수정 후, 종료(또는 다음 turn) 직전에 도는 **lint-grounded reflect gate**를 도입한다. 게이트는:

(a) **REAL verify 출력을 reflect step에 주입**한다. verify-workflow에 정의된 로컬 toolchain 결과 — `./node_modules/.bin/tsc --noEmit` / `./node_modules/.bin/biome check` / `bun test` — 를 모델 자기 서술 대신 grounding 근거로 넣는다. (Cursor의 `GetLintsForChangeResponse` 대응; quanta는 cloud lint 서비스가 없으므로 로컬 toolchain이 lint source다.)

(b) **typed 3-way `ReflectDecision`을 emit**한다.

(c) `needs_context`는 **quanta 기존 search-first machinery로 loop-back**한다 (구조화 질문 → grep/glob/localize/read 라운드 → 다음 reflect).

전부 **default-OFF** seam. 미설정 시 loop은 byte-identical.

### 2.1 Proposed TS types (design only — not yet implemented)

```ts
// src/agent/reflect-gate.ts (NEW — pure, deterministic, no I/O, no clock)

/** The three reflect decisions. Mirrors Cursor's stable
 *  accept | retry_without_more_information | retry_with_codebase_question
 *  oneof (v1 OpusChain + v2 Opus2Chain). `needs_context` is the renamed
 *  retry_with_codebase_question and is the highest-value primitive: it is the
 *  ONLY decision that carries structured questions back into search-first. */
export type ReflectDecision =
  | { kind: "accept" }
  | { kind: "retry" }
  | { kind: "needs_context"; questions: ReadonlyArray<string> }

/** The two reflect decision literals without payload, plus the keyed one,
 *  enumerated for exhaustive testing (mirrors plan-exit's
 *  ALL_PLAN_EXIT_DECISIONS convention). */
export const ALL_REFLECT_KINDS = ["accept", "retry", "needs_context"] as const
export type ReflectKind = (typeof ALL_REFLECT_KINDS)[number]

/** Lint-grounded reflect INPUT. The defining property: reflect never sees only
 *  the model's self-narration — it sees the real diff plus the real verify
 *  output. `verify` is the local-toolchain result per the verify-workflow note
 *  (tsc / biome / test), NOT a model claim about them. */
export interface ReflectInput {
  /** The change under review. before/after are the SSOT (mirrors Cursor's
   *  old_file_contents / new_file_contents); patchString is derived/optional. */
  readonly change: {
    readonly path: string
    readonly beforeContents: string
    readonly afterContents: string
    readonly patchString?: string
  }
  /** REAL verify output — the lint-grounding. Each rail carries its own raw
   *  output so the reflect prompt can quote it verbatim. A rail that was not
   *  run is `{ ran: false }` (never silently "green"). */
  readonly verify: ReadonlyArray<{
    readonly rail: "typecheck" | "lint" | "test"
    readonly ran: boolean
    readonly verdict: "green" | "red"
    readonly output: string // raw tsc/biome/test stdout+stderr tail
  }>
  /** Optional plan/task context carried from the turn (Cursor's plan context). */
  readonly planContext?: string
}

/** Decision constructor / validator. Enforces the invariant that mirrors
 *  plan-exit's feedback-iff-changes rule:
 *    - needs_context ⇒ `questions` is a non-empty array of non-empty strings.
 *    - accept / retry ⇒ no `questions`.
 *  Throws a named QuantaError subclass on violation (no silent normalization),
 *  exactly like buildPlanExit. */
export declare const buildReflectDecision: (args: {
  kind: ReflectKind
  questions?: ReadonlyArray<string>
}) => ReflectDecision

/** Host-supplied seam that runs the reflect step (LLM call) given the
 *  lint-grounded input, and returns a validated decision. Single-method,
 *  mirrors PlanExitPort. The flow re-validates via buildReflectDecision so a
 *  bad-actor port cannot forge needs_context without questions. */
export interface ReflectPort {
  request(input: ReflectInput): Promise<ReflectDecision>
}
```

`ReflectDecision`을 `PlanExitDecision`에 **별도 타입**으로 둔다 (병합 금지 — §4.1 deferred-as-variant trap 참조). 단 builder/port 구조는 `buildPlanExit` / `PlanExitPort`를 **닮게(mirror)** 하여 학습 비용·테스트 패턴을 재사용한다.

### 2.2 The flow (prose, no code)

```
[mutating tool(s) ran this turn]            ← isCodeModificationSession 재사용
       │  reflectGate.enabled && reflectPort wired?  (else skip — byte-identical)
       ▼
gather ReflectInput
   change = (beforeContents, afterContents, patchString?)   ← edit/write 결과에서
   verify = REAL tsc/biome/test 출력           ← verify-guard가 이미 식별한 rail 결과 재사용
       ▼
reflectPort.request(input)  → ReflectDecision (re-validated via buildReflectDecision)
       │
       ├─ accept        → 종료 진행 (closeout reminder는 그대로 흐름)
       ├─ retry         → 같은 turn 재진입 nudge (verify-guard same-turn 예산 cap 재사용; ≤N회)
       └─ needs_context → questions[] 를 search-first 라운드로 환류
                          (grep/glob/localize/read) → 답을 다음 reflect input의
                          planContext에 합쳐 재실행. needs_context 예산도 cap.
```

`retry` / `needs_context` 모두 **turn 카운터를 안 먹는** same-turn 복구로 두되 (verify-guard/decideOnAssembled의 기존 패턴), 무한 루프 방지를 위해 **별도 trip cap** (`reflectGate.maxTrips`, 기본 1–2)을 둔다. 이는 ADR-0067 user-intent 디시플린("interruption 최소화")과도 정합 — needs_context는 사용자에게 묻는 게 아니라 **스스로 search-first로 답을 찾는** 자율 분기다.

---

## 3. Integration seams (proposed)

| Seam | 변경 | 성격 |
|---|---|---|
| `closeout-guard.ts` | reflect step을 종료 직전 라우팅에 추가. `decideCloseoutGuard`가 이미 `isCodeModificationSession`로 코드수정 세션을 식별하므로, **그 분기 안에서** reflect gate를 호출(또는 별도 `decideReflectGate`로 분리). reflect가 `accept`면 기존 closeout reminder 흐름 유지; `retry`/`needs_context`면 종료 차단 + 해당 복구. closeout과 reflect는 **다른 trip state** (서로 thrash 안 함). | 종료-직전 hook 확장 |
| `plan-exit-flow.ts` (ADR-0063) | `needs_context` 3번째 outcome 의미를 plan posture에도 노출. 단, **`PlanExitDecision`에 case를 추가하지 않는다** (별도 `ReflectDecision`). plan-exit-flow는 reflect의 `needs_context`를 받으면 "plan을 더 다듬어야 함 → search-first 라운드 후 plan 재제시"로 환류하는 **얇은 어댑터**만 추가. plan-exit의 feedback-iff-changes 불변식은 불변. | 3rd outcome 환류 (어댑터) |
| `work-metrics-collector.ts` (ADR-0065) | accepted patch record에 `reflection?: string` (reflect가 emit한 자기비평 텍스트) + `source?: string` (패치 출처 — Cursor `RecordAcceptedPatch{source}` 대응; 예 `"reflect_accept" | "reflect_retry_converged"`) 필드 추가. `recordAcceptedPatch(...)` 신규 메서드 또는 기존 `finalize` 스냅샷에 optional 필드. 전부 optional → non-breaking, OTel flat 제약 유지(scalar만 attr로). | 텔레메트리 필드 additive |
| `AgentConfig` | `reflectGate?: { enabled?: boolean; maxTrips?: number }` + `reflectPort?: ReflectPort` opt-in. 둘 다 absent ⇒ gate 미인스턴스화. | +2 optional fields |
| verify-workflow (lint source) | reflect의 `verify` 입력은 **새 spawn이 아니라** verify-guard가 이미 식별/실행한 rail 결과를 재사용(중복 실행 회피). 로컬 toolchain 경로는 verify-workflow note 그대로(tsc/biome/bun test). | 입력 결선 |

**Default-OFF 불변식**: `reflectGate`/`reflectPort` 미설정 시 reflect-gate 미인스턴스화, closeout/plan-exit/work-metrics 모두 기존 byte-identical 경로. (ADR-0063/0065/0076과 동일한 seam 규율.)

---

## 4. What's portable vs skip

### 4.1 ✅ Portable

- **typed 3-way `ReflectDecision`** (`accept | retry | needs_context{questions}`) — v1/v2 dual-generation으로 입증된 stable core (§1.2).
- **lint-grounding 패턴** — reflect 입력에 모델 self-narration이 아니라 **실제 verify 출력**(tsc/biome/test)을 주입. quanta의 verify-workflow가 정확히 그 lint source.
- **`needs_context` → search-first 환류** — 구조화 질문을 quanta 기존 grep/glob/localize/read 기계로 되먹임.
- **`reflection`/`source` 텔레메트리** — work-metrics(ADR-0065)에 자연 fit (Cursor `RecordAcceptedPatch` 대응).

### 4.2 ❌ Skip

- **별도 "Opus chain" loop / service 포크 금지.** Cursor의 `OpusChainGetPlan/GetFilePaths/GetFileInstruction`는 hallucinated-function / scaffold-implementation이라는 **Cursor 고유 기능**을 위한 별도 멀티파일 edit chain이다. quanta의 **unified 단일 loop가 reflect의 home** — closeout-guard/plan-exit/verify-guard에 reflect를 *얹는다*. 별도 chain runner를 만들면 quanta loop와 reflect chain 사이에 동기화 부담·이중 진실(dual-truth)이 생긴다.
  - ★ **deferred-as-variant regression trap 인용** ([[v0-dev-absorption-2026-05-21]]): v0.dev 흡수 시 "deferred를 ToolEvent variant로" 병합했다가 회귀 함정을 밟은 전례가 있다. 동일 교훈 — reflect를 **별도 decision 타입/별도 chain으로 분기시키지 말고**, 기존 unified loop의 finish-time hook에 typed gate로 흡수한다. `ReflectDecision`을 `PlanExitDecision`에 oneof case로 욱여넣는 것도 같은 함정(§2.1에서 별도 타입으로 분리한 이유).
- **`GetLintsForChangeResponse` 자체 / Cursor lint RPC 인프라** — cloud/IDE in-memory `ITextModel` lint probe (deep-dive §1.3)는 Electron surface 종속. quanta는 로컬 toolchain이 더 강함(실제 repo에 진짜 tsc/biome/test 실행) — negative invariant로 이미 기록됨(§1.5).
- **`ReportModeSelection` / `override_model`(기본 Opus)** — Cursor A/B·모델 라우팅. quanta는 ADR-0066 model-swap에 별도 슬롯.

---

## 5. Alternatives rejected

| 대안 | 기각 사유 |
|---|---|
| **Free-text retry (현 상태)** | verify-guard의 자연어 nudge는 typed signal이 없어 host가 "찾아봐야 함 vs 그냥 재시도"를 구분 못 함. needs-context를 search-first로 자동 환류할 수 없다. reflect가 lint 출력에 grounding되지도 않음. |
| **별도 chain service (Cursor식 OpusChain 포크)** | §4.2 — unified loop와 이중 진실, 동기화 부담, deferred-as-variant trap. quanta loop가 home. |
| **`ReflectDecision`을 `PlanExitDecision`에 case 추가로 병합** | plan-exit 불변식(feedback-iff-changes) 오염 + reflect는 plan posture 밖(코드수정 종료 직전)에서도 돌아야 함. 두 타입은 닮되 분리(§2.1). |
| **사용자에게 needs-context를 직접 묻기(HITL)** | ADR-0067 user-intent 디시플린 위반(interruption 최소화). needs_context는 **스스로 search-first로 답을 찾는** 자율 분기여야 함 — 사용자 호출은 정말 불가능할 때만. |
| **reflect에 verify 출력 없이 모델 self-critique만** | lint-grounding의 핵심 가치를 버리는 것. Cursor가 굳이 `lints`를 입력에 넣은 이유 = self-narration은 환각함. |

---

## 6. Status

**Proposed.** 코드/테스트 없음. 본 ADR은 설계 계약만 고정한다. 구현은 별도 작업으로, default-OFF seam을 전제로 한다.

---

## 7. Implementation plan (future work — not done here)

**신규 파일**
1. `src/agent/reflect-gate.ts` — pure 모듈. `ReflectDecision` / `ReflectKind` / `ALL_REFLECT_KINDS` / `ReflectInput` / `buildReflectDecision`(invariant enforce, named QuantaError subclass) / `ReflectPort` / `decideReflectGate(...)`. `plan-exit.ts` 스타일 미러(invariant→throw, no silent normalization, exactOptionalPropertyTypes-safe). I/O·clock 0.
2. `tests/unit/agent/reflect-gate.test.ts` — 3-way decision 망라(`ALL_REFLECT_KINDS` 순회), invariant(needs_context는 non-empty questions 강제, accept/retry는 questions 금지), bad-actor port re-validation, default-OFF byte-identical.

**기존 파일 수정**
3. `src/agent/closeout-guard.ts` — 종료-직전 라우팅에 reflect step 결선(또는 loop이 `decideReflectGate`를 closeout 앞에 호출). reflect trip state는 closeout과 분리.
4. `src/agent/plan-exit-flow.ts` — `needs_context`를 plan posture로 환류하는 얇은 어댑터(plan-exit 타입/불변식 불변).
5. `src/agent/work-metrics-collector.ts` + `src/observability/work-metrics.ts` — accepted-patch record에 `reflection?` / `source?` optional 필드 + (필요 시) `recordAcceptedPatch(...)`. OTel는 scalar만.
6. `src/agent/loop.ts` — turn 종료 단계([E1]/[E2] 부근)에서 `reflectGate`/`reflectPort` wired일 때만 gate 호출; `retry`/`needs_context`는 same-turn 복구(turn 카운터 미증가)로 처리하고 별도 trip cap. `needs_context`의 questions를 search-first 라운드로 라우팅.
7. `src/agent/types.ts` (또는 AgentConfig 정의처) — `reflectGate?` + `reflectPort?` opt-in 필드.

**검증 절차** (verify-workflow 따름)
- typecheck: `./node_modules/.bin/tsc --noEmit`
- lint: `./node_modules/.bin/biome check src tests`
- test: `/Users/songmin/.bun/bin/bun test tests/unit tests/integration`
- default-OFF 회귀: `reflectGate`/`reflectPort` 미설정 시 loop byte-identical(기존 closeout/plan-exit/work-metrics 테스트 그대로 green) 확인.
- slice 격리: `reflect-gate.ts`는 `./plan-exit` 스타일대로 `@/shared`만 import (cross-slice import 금지).

**feature-catalog**: 구현 시 `tools/feature-catalog/features/01-agent-loop/` 아래 신규 yaml 1개(lint-grounded reflect gate) 추가.
