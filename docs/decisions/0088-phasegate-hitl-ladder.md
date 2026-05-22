# ADR-0088: PhaseGate HITL feedback ladder (Cursor AiProjectService 흡수)

- **상태**: Proposed (design-only — 구현은 후속 라운드)
- **날짜**: 2026-05-22
- **관련**: ADR-0063(Plan 3-way exit / `plan-exit-flow.ts`), ADR-0047/0049(HITL 4-tier gate / side-conversation seam), ADR-0036(Plan vs Default collaboration mode), ADR-0026(admissibility SSOT), `docs/analysis/code-agent-loop/cursor-deep-dives.md` §7.1(AiProjectService). Cursor 3.2.x on-disk audit (`aiserver.v1.AiProjectService`, descriptor `uby` @33696019).

> 이 ADR은 **설계 문서**다. 코드/테스트는 포함하지 않는다. 아래 TS 타입은 모두 **PROPOSAL**(후속 구현 라운드의 계약 스케치)이며, 현재 트리에 추가된 것이 아니다.

---

## 1. 맥락 (Context)

### Cursor 증거 (§7.1)

Cursor `aiserver.v1.AiProjectService`는 **8개 메서드 전부 ServerStreaming**인 HITL 다단 계획 ladder다(deep-dive §7.1):

- **4-phase**: `init → clarification → plan → breakdown → step`. 각 phase마다 **paired `*Feedback` RPC + loop/advance 시그널**:
  - `clarification`: `repeat_clarification: bool` (Q&A 루프)
  - `plan` / `breakdown` / `step`: `feedback_or_progress: str` + `force_move_to_next_step: bool` → `{revised | repeat_feedback}`
  - `step` gate가 가장 풍부: `modify_code_payload { files_to_modify[], feedback_text }` — **특정 파일을 타겟한 피드백**.
- **3-level decomposition**: `PROJECT → PLAN(prose) → BREAKDOWN(.Step{step_number, step_description, step_type}) → STEP(StepPayload)`.
  - `AiProjectStepType` enum: `READ_WRITE_FILE / RUN_TERM / CREATE_RM_FILES`.
  - `AiProjectShellType`: `BASH / POWERSHELL`.
- **STATELESS 서버**: `project_id` 없음. **클라이언트가 orchestrator**이고, `previous_messages: PureMessage[]`(SYSTEM/USER/ASSISTANT) + plan output → breakdown desc/spec → step의 full plan+breakdown[] 재전송으로 state를 carry한다. async seam = `background_task_uuid`.
- **DORMANT**: 양 번들 모두 call-site 0건. schema-registered만 되어있고 미사용(legacy 또는 서버 주도). "build me X" scaffolding 의도로 추정.

### quanta의 현재 상태

quanta는 **단일 3-way plan-exit gate**(ADR-0063 `plan-exit-flow.ts`)만 갖는다: `approved | rejected | changes_requested` + feedback-iff-changes 불변식, host-supplied `PlanExitPort`로 1-shot 질문. 이것은 한 개의 phase("plan을 어떻게 떠나는가")만 다룬다. Cursor는 **같은 (generate → present → {iterate | advance | reject}) 셰이프를 N개 phase에 걸쳐 반복**한다.

포터블한 인사이트는 RPC도, scaffolding 제품도 아니다 — **quanta의 단일 plan-exit gate를 재사용 가능한 N-phase `PhaseGate` 상태 기계로 일반화**하는 것이다. `force_move_to_next_step`(승인 ≠ 전진을 분리)과 per-step `files_to_modify[]` feedback이 최고가치 primitive다.

---

## 2. 결정 (Decision) — `PhaseGate` 추상화 (PROPOSAL)

각 phase = **`(generate → present → {iterate-with-feedback | force-advance | reject})`**. phase 목록은 설정 가능하며, quanta-relevant 기본 subset은 `["clarify", "plan", "breakdown", "step"]`.

### 2.1 추가할 타입 (제안 — 미구현)

```ts
// PROPOSAL: src/agent/phase-gate.ts (pure) — 미구현

/** ladder의 한 단계. Cursor init/clarification/plan/breakdown/step의
 *  quanta subset. 설정으로 부분집합/순서 조정 가능. */
export type PhaseKind = "clarify" | "plan" | "breakdown" | "step"

/** 한 phase의 결과 — Cursor의 {revised | repeat_feedback | advance}를
 *  3-way로 정규화. ADR-0063 PlanExitDecision의 일반화(plan→임의 phase). */
export type PhaseOutcome =
  | { kind: "advance" }                       // force_move_to_next_step=true: 승인하고 다음 phase로
  | { kind: "iterate"; feedback: PhaseFeedback } // repeat_feedback: 피드백과 함께 같은 phase 재생성
  | { kind: "reject" }                        // ladder 폐기·종료 (plan-exit rejected와 동형)

/** Cursor feedback_or_progress(str) + force_move_to_next_step(bool) +
 *  step phase의 modify_code_payload{files_to_modify[]}를 통합한 record.
 *  forceAdvance=true이면 이번 피드백을 반영하되 다음 phase로 전진. */
export interface PhaseFeedback {
  readonly feedback: string
  readonly forceAdvance: boolean
  /** Cursor step phase의 files_to_modify[] — phase가 "step"일 때만 의미.
   *  특정 파일을 타겟한 피드백("이 파일들만 다시"). */
  readonly filesToModify?: ReadonlyArray<string>
}

/** 한 phase의 산출물 + present용 메타. generate가 채움. */
export interface PhaseArtifact {
  readonly kind: PhaseKind
  readonly text: string                       // PLAN=prose, BREAKDOWN=step list 직렬화 등
  /** breakdown phase일 때만 — 다음 phase(step)가 소비할 구조화 step 목록. */
  readonly steps?: ReadonlyArray<PhaseStep>
}

/** Cursor .Step{step_number, step_description, step_type}의 quanta 대응. */
export interface PhaseStep {
  readonly stepNumber: number
  readonly description: string
  /** Cursor AiProjectStepType → quanta admissibility 사전 태그 (§3 참고). */
  readonly stepType: PhaseStepType
}

/** Cursor AiProjectStepType enum의 quanta 명명. §3에서 permission 4-tier로 매핑. */
export type PhaseStepType = "read_write_file" | "run_term" | "create_rm_files"
```

```ts
// PROPOSAL: PhaseGate 상태 기계 본체 (pure orchestrator, port 주입)

/** host-supplied I/O seam — plan-exit-flow의 PlanExitPort와 동형.
 *  CLI 프롬프트 / IDE 모달 / RPC가 구현. side-conversation 위에 얹힌다. */
export interface PhaseGatePort {
  /** artifact를 operator에게 present하고 outcome을 받는다. */
  present(artifact: PhaseArtifact): Promise<PhaseOutcome>
}

/** phase별 산출물 생성기 — loop가 LLM 호출을 래핑해 주입.
 *  feedback이 있으면 이전 artifact + 피드백으로 재생성(iterate). */
export type PhaseGenerator = (
  kind: PhaseKind,
  prior: PhaseArtifact | undefined,
  feedback: PhaseFeedback | undefined,
) => Promise<PhaseArtifact>

/** 한 ladder의 설정. phases는 ["clarify","plan","breakdown","step"]의
 *  연속 부분집합(순서 보존). maxIterations로 phase별 iterate 횟수 cap. */
export interface PhaseGateConfig {
  readonly phases: ReadonlyArray<PhaseKind>
  readonly maxIterationsPerPhase?: number     // 기본 cap (무한 iterate 차단)
}

/** ladder 전체 실행 결과. */
export type PhaseLadderResult =
  | { kind: "completed"; artifacts: ReadonlyArray<PhaseArtifact> } // 모든 phase advance
  | { kind: "rejected"; atPhase: PhaseKind }                       // 어느 phase에서 reject
```

### 2.2 상태 기계 셰이프 (서술)

```
for each phase in config.phases:           # clarify → plan → breakdown → step
  artifact = generate(phase, prior, undefined)
  loop (≤ maxIterationsPerPhase):
    outcome = port.present(artifact)        # operator 결정
    switch outcome.kind:
      "advance"  → break (다음 phase로); prior = artifact
      "iterate"  → artifact = generate(phase, artifact, outcome.feedback)
                   (forceAdvance면 재생성 후 break)
      "reject"   → return { kind:"rejected", atPhase: phase }
  iteration cap 초과 → 강제 advance 또는 reject (정책, §9 결정사항)
return { kind:"completed", artifacts: [...] }
```

- ADR-0063 `runPlanExitFlow`는 이 기계의 **N=1, phase=["plan"]** 특수 사례다(아래 §6). `buildPlanExit`의 feedback-iff-changes 불변식은 `PhaseFeedback`(iterate에는 항상 feedback 존재) 불변식으로 일반화된다.
- forged-outcome 방어: ADR-0063과 동일하게, port가 돌려준 `PhaseOutcome`을 builder(`buildPhaseOutcome`, 제안)로 재검증해 `iterate` without feedback / `advance` with feedback 등 위반을 거부한다.

---

## 3. 3-level decomposition 매핑 + permission 4-tier admissibility 태그

| Cursor 레벨 | quanta `PhaseKind` | 산출물 | 비고 |
|---|---|---|---|
| PROJECT | (ladder 자체) | — | "build me X" 진입점. quanta는 user request로 대체 |
| (clarification) | `clarify` | Q&A artifact | Cursor `repeat_clarification` 루프 = iterate-without-advance |
| PLAN | `plan` | prose plan (`PhaseArtifact.text`) | ADR-0063 plan과 동일 surface |
| BREAKDOWN | `breakdown` | `PhaseStep[]` (`artifact.steps`) | step_number + description + **step_type** |
| STEP | `step` | per-step payload | `files_to_modify[]` 타겟 feedback 최대 가치 |

### `step_type` → permission 4-tier admissibility 사전 태그

Cursor `AiProjectStepType`은 step이 **무엇을 할지**를 미리 선언한다. quanta는 이를 admissibility-gate(ADR-0026)가 dispatch 전에 소비할 수 있는 **사전 태그**로 활용한다 — step을 present할 때 이미 어느 HITL tier가 걸릴지 operator에게 보여줄 수 있다.

| `PhaseStepType` | Cursor enum | quanta admissibility 의미 | 예상 HITL tier (ADR-0047/0049) |
|---|---|---|---|
| `read_write_file` | READ_WRITE_FILE | mutating edit/write (fs-jail 내) | `pre-approval-ok` (acceptEdits면 자동, 아니면 ask) |
| `run_term` | RUN_TERM | Bash 셸 실행 (열린 효과 게이트) | `always-confirm` (HARD_DENY 패턴이면 `hand-off-required`로 승격) |
| `create_rm_files` | CREATE_RM_FILES | 파일 생성/삭제 (구조 변경) | `pre-approval-ok` ~ `always-confirm` (rm은 위험 — HARD_DENY 후보) |

- 이 태그는 **사전 힌트일 뿐 권한 결정의 SSOT가 아니다**. 실제 결정은 여전히 dispatch 시점의 8-stage admissibility-gate가 내린다(ADR-0026 SSOT 불변식 유지). PhaseGate는 ladder 단계에서 "이 step은 셸을 돌릴 거라 confirm이 필요할 것"이라고 **미리 present**해 operator의 force-advance 판단을 돕는다.
- `AiProjectShellType`(BASH/POWERSHELL)은 흡수하지 않는다 — quanta 셸 추상화(runtime/shell)가 이미 처리, 중복.

---

## 4. Default-OFF seam (byte-identical when absent)

기존 optional-feature 패턴(ADR-0063 `planExitPort`, ADR-0046 `permissionStack`, ADR-0050 `trustScope`)을 미러한다.

```ts
// PROPOSAL: src/agent/types.ts — AgentConfig에 1 field 추가

/**
 * ADR-0088 PhaseGate HITL ladder. Absent ⇒ ladder는 절대 invoke되지 않고
 * 루프는 byte-identical(legacy plan posture만; ADR-0063 plan-exit는 별개로
 * 계속 동작). Present ⇒ host가 phase 목록 + present port + generator를
 * 주입하면 loop/side-conversation이 ladder를 구동한다.
 */
phaseGate?: {
  readonly config: PhaseGateConfig
  readonly port: PhaseGatePort
  // generator는 loop가 LLM 호출로 합성해 주입(config에 두지 않음 — IO-free 유지)
}
```

불변식:
- `phaseGate` 미설정 ⇒ `runPhaseLadder`는 호출되지 않는다. ADR-0063과 동일하게 **flow는 port 없이 호출되면 throw**(silent degrade 금지) — default-OFF는 caller가 호출을 skip함으로써 보장.
- `AgentConfig` `OptionalFeatureKey` union(types.ts line ~644)에 `"phaseGate"` 추가, 동일한 "absent ⇒ byte-identical" 테스트 패턴(`src-no-sketchy-code` / prompt-system) 적용.
- 신규 npm dep 0. 슬라이스 격리: `@/agent/phase-gate`는 `@/shared` + `./plan-exit`(불변식 재사용) + `./mode`만 import.

---

## 5. 포터블 vs 서버-바운드

| 측면 | Cursor | quanta 흡수 여부 |
|---|---|---|
| **상태 기계 셰이프** (phase × {iterate/advance/reject}) | client orchestrates | ✅ **포팅** — `PhaseGate` pure 모듈 |
| `force_move_to_next_step` (승인 ≠ 전진 분리) | bool 시그널 | ✅ `PhaseOutcome.advance` vs `iterate{forceAdvance}` |
| per-step `files_to_modify[]` 타겟 feedback | `modify_code_payload` | ✅ `PhaseFeedback.filesToModify` |
| `step_type` 사전 선언 | enum | ✅ admissibility 사전 태그 (§3) |
| **RPC transport** (8 ServerStreaming 메서드, descriptor `uby`) | Connect-Web/protobuf | ❌ **서버-바운드** — quanta는 in-process |
| **STATELESS + previous_messages carryover** | client가 full plan+breakdown[] 재전송 | ❌ 불필요 — quanta는 in-process 상태 기계가 artifact[]를 메모리에 보유 |
| `background_task_uuid` async seam | RPC 비동기 | ❌ — quanta는 Promise/side-conversation |
| `AiProjectShellType` BASH/POWERSHELL | enum | ❌ — runtime/shell 중복 |
| PROJECT scaffolding ("build me X") 제품 의도 | DORMANT | ❌ — 우리 흡수 대상 아님 |

**핵심**: Cursor 서버가 stateless이고 클라가 previous_messages로 state를 carry하는 것은 **RPC 경계 때문에 강제된 우회**다. quanta는 같은 프로세스에서 ladder를 돌리므로 carryover 메커니즘 자체가 불필요하다. **상태 기계 모양만 포팅**하고 transport/carryover/scaffolding은 버린다.

---

## 6. 기존과의 관계 (확장, 대체 아님)

- **ADR-0063 plan-exit-flow**: PhaseGate는 plan-exit의 **상위 일반화**다. `runPlanExitFlow`는 `phases=["plan"]`, `PhaseOutcome.advance≈approved`, `iterate≈changes_requested`, `reject≈rejected`인 N=1 특수 사례. 구현 라운드는 둘 중 하나를 택한다:
  - (선호) plan-exit를 PhaseGate 위에 재구현하되 `PlanExitDecision` API는 보존(외부 호출자 byte-identical), 또는
  - 둘을 병존시키되 `buildPlanExit` 불변식 로직을 `buildPhaseOutcome`이 재사용.
  - **plan-exit를 삭제하지 않는다** — ADR-0063 surface는 유지.
- **ADR-0047/0049 HITL 4-tier + side-conversation**: PhaseGate는 HITL 게이트를 **대체하지 않는다**. ladder는 *계획 단계*에서 operator 피드백을 받고, admissibility-gate는 *dispatch 시점*에 권한을 결정한다 — 두 평면은 직교. `step_type` 태그(§3)는 둘을 잇는 힌트일 뿐 권한 SSOT는 admissibility-gate. PhaseGatePort는 side-conversation seam(ADR-0049) 위에 얹어 구현하는 것이 자연스럽다.
- **ADR-0036 collaboration mode**: ladder는 plan posture 안에서 동작하며 mode 게이트(어떤 posture에 *있는지*)와 별개로 posture를 *어떻게 진행하는지*를 다룬다(ADR-0063과 동일한 직교성).

---

## 7. 기각한 대안 (Alternatives rejected)

- **(a) 단일 gate 유지 (ADR-0063만)**: 기각. clarify/breakdown/step 단계별 피드백 루프와 `force_move_to_next_step`(승인≠전진), per-step `files_to_modify[]` 같은 최고가치 primitive를 못 얻는다. multi-step scaffolding 작업에서 plan 한 번 승인 후 전체를 통째로 실행해야 하는 단절이 남는다.
- **(b) Cursor 8-RPC 전체 포팅**: 기각. 8 ServerStreaming 메서드 + protobuf descriptor + stateless previous_messages carryover + background_task_uuid는 전부 **RPC 경계가 강제한 산물**이고 Cursor 번들에서도 DORMANT(call-site 0)다. in-process quanta에는 순수 부채. transport는 버리고 상태 기계만 흡수.
- **(c) admissibility-gate에 phase 인식 추가 (SSOT 합치기)**: 기각. PhaseGate는 *계획 시점* operator 협업 루프, admissibility는 *dispatch 시점* 권한 결정 — 합치면 ADR-0026 SSOT 단일성이 깨진다. `step_type`은 사전 힌트로만 흐른다.

---

## 8. 상태 (Status)

**Proposed** — 설계 전용. Accepted 아님. 구현은 후속 라운드(§9)에서 별도 PR로 진행하며, 그때 본 ADR을 Accepted로 갱신한다.

---

## 9. 구현 계획 (후속 라운드)

**신규 파일**
- `src/agent/phase-gate.ts` (pure) — `PhaseKind`/`PhaseOutcome`/`PhaseFeedback`/`PhaseArtifact`/`PhaseStep`/`PhaseStepType` 타입 + `buildPhaseOutcome`(불변식 빌더, `buildPlanExit` 패턴) + 술어(`phaseAllowsAdvance` 등).
- `src/agent/phase-gate-flow.ts` (L3 orchestrator) — `PhaseGatePort` + `PhaseGenerator` + `PhaseGateConfig` + `runPhaseLadder(config, port, generate)` (forged-outcome 재검증, iteration cap, `PhaseGateFlowError`/`PhaseGatePortFailedError` — `plan-exit-flow.ts` 에러 패턴 미러).

**수정 파일**
- `src/agent/types.ts` — `AgentConfig.phaseGate?` field 추가 + `OptionalFeatureKey` union에 `"phaseGate"` + import.
- `src/agent/loop.ts` (또는 `side-conversation.ts`) — `phaseGate` 설정 시 ladder 구동 wire: per-phase `generate`를 LLM 호출로 합성, `step_type` 태그를 step artifact에 부착.
- (선호 경로 채택 시) `src/agent/plan-exit-flow.ts` — `runPlanExitFlow`를 `runPhaseLadder` 위에 재구현(외부 API 보존).
- `docs/10.feature-catalog.md` + `tools/feature-catalog/features/01-agent-loop/` 신규 YAML.

**테스트** (구현 라운드)
- `tests/unit/agent/phase-gate.test.ts` — 불변식(iterate-iff-feedback), 3-way outcome, forged-outcome 거부.
- `tests/unit/agent/phase-gate-flow.test.ts` — mock port로 advance/iterate/reject/cap, ADR-0063 N=1 동치 회귀.
- `src-no-sketchy-code` / `prompt-system` — `phaseGate` absent ⇒ byte-identical 확인.

**구현 라운드가 결정할 열린 항목**
- iteration cap 초과 시 강제 advance vs reject (정책).
- plan-exit 재구현 경로 (PhaseGate 위 재구현 vs 병존).
- clarify phase가 quanta user-intent-discipline(ADR-0067, "최소 interruption") 규칙과 충돌하지 않게 default-OFF + 명시 opt-in 유지.

---

## 불변식 영향

- **byte-identical default**: `phaseGate` 미설정 ⇒ 루프/plan-exit 동작 무변경.
- **admissibility SSOT(ADR-0026) 유지**: `step_type`은 사전 힌트, 권한 결정은 dispatch-time gate.
- **슬라이스 격리**: `@/agent/phase-gate{,-flow}`는 `@/shared` + `./plan-exit` + `./mode`만 import.
- **신규 npm dep 0**.
