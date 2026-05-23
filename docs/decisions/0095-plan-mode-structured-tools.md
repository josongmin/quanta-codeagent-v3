# ADR-0095: Structured plan-mode tools (data model + 4 tools + 6 events)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**:
  - ADR-0036 (plan-mode dispatch-seam mutating block) — plan posture에서 mutating 차단 게이트.
  - ADR-0063 (plan-exit 3-way decision surface) — approve/reject/changes_requested 분기.
  - ADR-0086 (`request_plan_exit` tool) — plan-exit caller; 본 ADR과 자매 패턴(host-port mirror).
  - ADR-0096 (PlanStore port + slice isolation) — 본 ADR의 슬라이스 격리 contract.
  - ADR-0097 (`request_user_input` host port) — 본 ADR의 6번째 이벤트와 짝.
- **출처**: [docs/plans/plan-mode-sota-plus-plus.md](../plans/plan-mode-sota-plus-plus.md) §1-§5 / §10·11. ROI-무관 SOTA++ 흡수 — Cursor maximalist + Codex 이벤트 + Claude 승인 ergonomics를 우리 슬라이스/HITL/follow-up-queue 위에 적층.
- **참조**: `src/agent/plan/types.ts`, `src/agent/plan/state.ts`, `src/agent/plan/dag.ts`, `src/agent/plan/transitions.ts`, `src/agent/plan/snapshot.ts`, `src/tool/plan/*`, `src/stream/types.ts`.

## 맥락 (Context)

`tools/feature-catalog/features/06-tier1/03-plan-mode.yaml`의 `deliberate_hold`는 "structured plan-state-machine + structured-choice 도구(모델이 plan을 직접 갱신/분기) — CLI 환경 ROI 낮아 의식적 보류"였다. 즉 ADR-0036(dispatch-block) / ADR-0063(plan-exit 3-way) / ADR-0086(`request_plan_exit`)이 이미 plan posture의 *경계*(들어옴·차단·나감)는 잠갔지만, **plan 자체의 구조화된 상태기계**(todo/phase/dependency를 모델이 직접 mutate)는 의도적으로 비워뒀던 슬롯이다.

> L1 hold의 정확한 정의: "plan state-machine을 모델이 직접 갱신/분기하는 structured-choice 도구". 우리는 이걸 *세 모델 모두 능가하는 형태*로 흡수한다 — Cursor maximalist + Codex 이벤트 + Claude 승인 ergonomics를 슬라이스 격리/HITL/follow-up-queue/plan-exit 패턴 위에 적층.

ROI-무관 SOTA++ 흡수의 핵심 차별화는 §12 표(plans/plan-mode-sota-plus-plus.md)에 박혀 있다:

| 차원 | Codex | Cursor | Claude | **우리** |
|---|---|---|---|---|
| Plan-mutation 도구 | 없음 (이벤트만) | 2개 (느슨한 `UNSPECIFIED` 포함) | 없음 | **4개** + CAS version + typed failures |
| Status enum | — | loose | — | **5-state 닫힌 + 25-cell 전수 matrix** |
| 의존성 검증 | — | 필드만 있음 (검증 없음) | — | **DAG validator + 사이클 탐지 + dangling 거부** |
| 이벤트 | 2종 (delta + update) | UI 통합 모호 | 0종 | **6종** + 늦은-attach snapshot + user_input pair |
| 영속화 | 내부 | 내부 | 없음 | 명시적 port + session-resume hydrate (별 ADR) |
| 승인 | — | 묵시(`auto_approved`) | message-level | 명시 HITL 4-tier + plan-exit 3-way (별 ADR) |

## 결정 (Decision)

4개의 model-callable 도구 + 6개의 AgentEvent 변형 + 닫힌 `PlanMutationError` taxonomy를 **슬라이스 격리·휴리스틱 0**으로 흡수한다.

### Part 1 — 데이터 모델 (closed shapes, version-tracked)

`src/agent/plan/types.ts` — 닫힌 union·literal·readonly. zod 없음(plain TS, 핫패스 패턴).

- **`TodoStatus`** = `"pending" | "in_progress" | "completed" | "cancelled" | "blocked"` (5-state, 닫힌 enum).
- **`ALL_TODO_STATUSES`** readonly 배열로 freeze. 새 status 추가 시 양쪽 갱신 강제(드리프트 가드).
- **`TodoItem`** — `id`(ULID monotonic) / `content`(≤500 chars) / `status` / `createdAt` / `updatedAt` / `dependencies`(DAG-validated todo IDs) / optional `phaseId` / optional `assignee`(ADR-0042 subagent nickname) / optional `verifyHint`(ADR-0013 verify-guard hook).
- **`Phase`** — `id` / `name` / `todoIds` / `order`(strictly monotonic, gap-allowed).
- **`Plan`** envelope — `version`(0부터, mutation마다 +1, **CAS optimistic concurrency**) / `name`(≤120) / `overview`(≤2000) / `isProject` / `todos: Record<string, TodoItem>` / `phases` / `createdAt` / `updatedAt`. 전 필드 `readonly`.
- **`PlanDelta`** 6-arm union — `created` / `todos_added` / `todos_updated` / `todos_removed` / `phases_reordered` / `noop`(idempotent empty patch). 이벤트와 UI render 양쪽에 동일 shape.
- **`PlanMutationError`** 10-arm 닫힌 union — `version_conflict` / `todo_not_found` / `phase_not_found` / `dependency_cycle`(path 포함) / `dependency_unknown` / `self_dependency` / `content_too_long` / `invalid_status_transition`(from, to, id) / `duplicate_id` / `empty_plan_create`.

> 상태 전이 규칙 (5×5 closed matrix, terminal 위반은 typed 거부):
> ```
> pending      → in_progress | cancelled | blocked
> in_progress  → completed | blocked | cancelled
> blocked      → in_progress | cancelled
> completed    → (terminal)
> cancelled    → (terminal)
> ```

**DOS caps**(`PLAN_LIMITS` 상수): `MAX_TODOS_PER_PLAN`, `MAX_PHASES_PER_PLAN`, `MAX_DEPENDENCIES_PER_TODO`, `MAX_CONTENT_LENGTH`, `MAX_NAME_LENGTH`, `MAX_OVERVIEW_LENGTH`. 모델/입력이 폭주해도 reducer가 절단·typed 거부.

### Part 2 — 4개의 model-callable 도구 (`src/tool/plan/`)

| 도구 | 입력 | 성공 출력 | 비고 |
|---|---|---|---|
| `create_plan` | `{name, overview, isProject?, todos[], phases?[]}` | `{version:0, plan_uri}` | 기존 plan 존재 시 `version_conflict`. |
| `update_todos` | `{patches[], merge?, expected_version}` | `{version, delta_kind, touched_ids}` | `merge=true`→부분 갱신, `false`→전체 교체. |
| `update_plan` | `{name?, overview?, phases?[], expected_version}` | `{version, delta_kind}` | 메타 + phase 재정렬 전용. |
| `remove_todos` | `{ids[], expected_version}` | `{version, delta_kind, touched_ids}` | 의존성 가진 todo 삭제 시 `dependency_unknown`(dangling). |

- 전부 **ADR-0069 typed-tool-failure 적용** — `ok:false` 시 `failure: { mode: "rejected", reason: <PlanMutationErrorCode> }`. 닫힌 코드 + detail in payload.
- zod 입력 schema는 `src/tool/plan/schemas.ts` 표준 (rejection은 typed-failure 라우팅).
- 슬라이스 격리: `@/tool/plan`은 `@/agent/plan`을 **import 안 함**. `ToolContext.planMutator` duck-typed seam이 단일 경계(자세한 contract → ADR-0096).

### Part 3 — 6개의 AgentEvent 변형 (`src/stream/types.ts`)

```
plan_created                  // 새 plan
plan_updated                  // delta + version
plan_snapshot                 // 늦은-attach surface (재연결 web/IDE)
plan_user_input_requested     // ADR-0097 짝, model→operator
plan_user_input_resolved      // ADR-0097 짝, operator→model
plan_cleared                  // plan-exit reject/clear (P6 wiring)
```

- `plan_updated.delta`는 §Part 1의 `PlanDelta` readonly 미러 — UI는 incremental render 가능.
- `plan_snapshot`은 늦게 붙은 surface 위한 full-state.
- `NullStream`은 전부 swallow → default-OFF byte-identical.
- `jsonl-recorder`는 recovery family로 mapping (우리 컨벤션).
- `stdout` adapter는 dim 1-line: `📋 plan v3: 5 todos (3 done, 2 pending)`.

> **6번째 이벤트 `plan_cleared`는 P6 wiring에서 의미를 가짐** — plan-exit `rejected`/`changes_requested` 라이프사이클이 정식 통합되기 전까지는 emit 사이트가 비어 있다. 슬롯은 본 ADR에서 reserve.

## 흡수 비교 (Adopt vs Deliberately-NOT-adopt)

| 차원 | Cursor | Codex | Claude | 우리 결정 | 사유 |
|---|---|---|---|---|---|
| Plan-mutation 도구 수 | 2 | 0 (이벤트만) | 0 | **4** (adopt+) | maximalist. update_todos가 가장 핫함. |
| `UNSPECIFIED` status | 있음 | — | — | **미흡수** | loose enum. 우리는 5-state 닫힘. exhaustive switch가 `never` 가드. |
| `auto_approved` 묵시 승인 | 있음 | — | — | **미흡수** | 묵시 승인은 ADR-0047 HITL 4-tier로 명시 게이트. plan 도구는 `no_confirm`(plan-exit에서 묶음 review). |
| `bubble_id` UI 트래킹 | 있음 | — | — | **미흡수** | surface 책임. agent core는 stable id(`TodoItem.id`)만. |
| plan-state event-only 비대칭 | — | 있음 (모델은 쓰기, 외부는 읽기만) | — | **미흡수** | 양방향 1급. 모델도 `current()` readonly 미러로 읽음. |
| no-state (`ExitPlanMode` 단독) | — | — | 있음 | **미흡수** | 이미 ADR-0086으로 보강. 본 ADR이 plan-state 부재를 메움. |
| CAS version | — | — | — | **adopt+ (신규)** | lost-update 방어. mutation마다 +1 + `expected_version` 일치 검증. |
| DAG validator | — | — | — | **adopt+ (신규)** | 사이클·dangling·self-dep 전부 typed 거부. 100노드 ≤5ms perf gate. |
| 5×5 transition matrix | — | — | — | **adopt+ (신규)** | terminal 위반 `invalid_status_transition` typed 거부. exhaustive switch + 25-cell 전수 테스트. |
| `TodoItem.assignee` (subagent) | — | — | — | **adopt+ (신규)** | ADR-0042 nickname pool과 cross-wire. `spawn_agent({nickname})`와 짝. |
| `TodoItem.verifyHint` (verify-guard) | — | — | — | **adopt+ (신규)** | ADR-0013 verify-guard에 "이 todo 검증했나?" 힌트. completed 전이 hook. |

## 근거 (Rationale)

- **닫힌 shape + exhaustive switch**: `PlanDelta` 6-arm / `PlanMutationError` 10-arm. switch default-branch `never` 강제 → 새 variant 추가 시 모든 consumer가 컴파일 fail. 휴리스틱 0, drift 0. 우리 codebase 표준(ADR-0070 review-kind, ADR-0069 typed tool failure)과 정렬.
- **CAS prevents lost updates**: 모델이 stale `expected_version`으로 mutation 시 `version_conflict` typed 거부. 재시도 contract가 명확 — 모델은 `current()`로 latest version을 다시 읽고 재시도. *묵시 last-write-wins*가 절대 일어나지 않음. 멀티-에이전트(subagent A와 부모가 같은 plan에 동시 mutation) 시나리오에서도 일관성 보장.
- **DAG validator prevents impossible plans**: `dependency_cycle`/`dependency_unknown`/`self_dependency` 셋이 typed 거부. tarjan SCC 아니라 DFS w/ tri-state color로 충분(100노드 ≤5ms 가드). topological sort는 tie-break = id 사전순으로 결정적 — 같은 plan이 항상 같은 순서로 정렬된다(replay·snapshot round-trip 결정성).
- **슬라이스 격리가 SSOT 유지**: `@/tool` ↛ `@/agent/plan` (biome `noRestrictedImports`). 도구 코드는 `PlanMutator` 미러만 보고, 어댑터(`planStoreToMutator`)가 단일 번역 site. drift 발생 시 *정확히 한 파일*에서 컴파일 fail. 자세한 contract → ADR-0096.
- **ADR-0042 subagent + ADR-0013 verify-guard 통합**: `TodoItem.assignee`/`verifyHint`는 *기존 슬라이스에 옵셔널 필드 추가*. 양 슬라이스가 plan을 import할 필요 없음 — string nickname / hint만 매개. cross-slice coupling 0.
- **5×5 transition matrix는 25 cell 전수 테스트**: `pending → in_progress | cancelled | blocked` 등 *허용*과 *거부* 라벨 모두 명시. exhaustive switch가 새 status 추가 시 양쪽 컴파일 fail. matrix는 `transitions.ts`의 const Record로 표현 → 런타임도 같은 SSOT.
- **DOS caps는 reducer 단계에서 적용**: `MAX_TODOS_PER_PLAN` / `MAX_DEPENDENCIES_PER_TODO` / `MAX_CONTENT_LENGTH` 등. 모델/입력 폭주가 메모리 폭발로 가지 않음. typed 거부(`content_too_long` 등)로 surface.

## 대안 (Rejected Alternatives)

1. **단일 도구 `update_plan` (Cursor 식 maximalist)**: 기각 — 모델 prompt에서 도구 의도가 모호("update가 add인가 remove인가?"). 4 도구로 분리하면 각각의 입력 schema가 명확 + 모델이 의도를 명시.
2. **이벤트만 (Codex 식)**: 기각 — 모델이 plan을 *읽기* 위해 별도 prompt 사이클 필요. `update_todos`처럼 inline 도구 호출이 단일 turn 안에서 끝남.
3. **status enum에 `UNSPECIFIED` 추가 (Cursor 식)**: 기각 — loose enum은 exhaustive switch를 무효화. 5-state로 충분(plan / 실행 중 / 완료 / 폐기 / 블록).
4. **plan을 JSON으로 모델에 노출 + free-form mutation**: 기각 — typed contract 0, parse heuristic 필요, race condition 가능, validation 무. 휴리스틱-0 원칙 위반.
5. **single global `Plan` mutable singleton**: 기각 — race condition 가능, snapshot/restore 불가, slice 격리 위반.
6. **DAG 검증을 도구 호출 시점 대신 commit 시점**: 기각 — 늦은 실패. mutation 호출 시점에 즉시 typed 거부가 모델에 더 좋은 feedback(같은 turn에 수정 시도 가능).

## 결과·트레이드오프 (Consequences)

- **얻은 것**: plan-state mutation surface가 1급 도구 surface로 노출됨. ADR-0036(dispatch-block) → ADR-0063(plan-exit 3-way) → ADR-0086(`request_plan_exit`) → ADR-0095(structured tools) → ADR-0097(`request_user_input`)으로 이어지는 plan-mode 협업 루프가 완결. Codex/Cursor/Claude 셋 모두 능가하는 SOTA++ 자세.
- **비용**: 새 슬라이스(`@/agent/plan`) + 새 도구 4개 + 새 이벤트 6개. 그러나 default-OFF로 *기본 회귀 0*. 페이로드는 `AgentConfig.planStore?` 주입 시에만 활성. unit test 자산 239+ cases가 새로 추가됨.

## P5 wired, P6/P7 follow-up 슬라이스

본 ADR이 *닫지 않는* 통합 작업:

- **P5 (wired in this ADR's slice)**: `AgentConfig.planStore` + `dispatch.ts`가 `planStoreToMutator`를 fresh build + `buildSessionFeatures`가 4 도구 conditional 등록. fc YAML `plan-mode` L1→L4 promotion.
- **P6 (follow-up)**: plan-exit-three-way 통합. 승인 → plan이 default-mode 첫 turn system reminder에 readonly 주입 + PlanStore.freeze(). 거부 → PlanStore.clear() + `plan_cleared` 이벤트 emit. changes_requested → plan 유지 + feedback이 다음 prompt seed. `src/agent/plan-exit-flow.ts`(`runPlanExitFlow`)에 PlanStore handle 추가.
- **P7 (follow-up)**: snapshot 영속화. `AgentConfig.planSnapshotStore?: { load(): Promise<PlanSnapshot|null>; save(s: PlanSnapshot): Promise<void> }` — ADR-0037 follow-up-queue snapshot 패턴 미러. session-start hydrate + session-end save. slash command `/plan`(plan 현재 상태 inline 표시, slash 5종 ADR-0059 패턴 확장).

각 follow-up은 자체 ADR로 분리될 수 있으나, *데이터 모델·도구·이벤트* 자체는 본 ADR이 SSOT.

## 기존 ADR과의 통합 (Wiring)

| 기존 메커니즘 | 본 ADR과의 wiring |
|---|---|
| ADR-0036 plan-mode dispatch-block | `MUTATING_TOOL_TABLE`에 4 plan 도구 = `plan_allowed:true` 플래그. plan posture에서 다른 mutating은 차단되지만 plan 도구는 **명시적으로 허용**. |
| ADR-0086 `request_plan_exit` | 승인 → PlanStore.freeze() + plan을 default-mode 시드. 거부 → PlanStore.clear() + `plan_cleared` 이벤트. changes_requested → plan 유지 + feedback. P6 slice에서 정식 wiring. |
| ADR-0047 HITL 4-tier | 4 plan 도구는 자체적으로 `no_confirm`(모델 주도, 사용자 review는 plan-exit 단계). `request_user_input`(ADR-0097)은 `hand_off_required`(blocking). |
| ADR-0042 subagent nickname | `TodoItem.assignee?` 필드로 자식 subagent에 todo 할당. `spawn_agent({nickname:"lyra"})`와 짝. |
| ADR-0013 verify-guard | `TodoItem.verifyHint?` → completed 전이 시 verify-guard에 "이 todo 검증했나?" 힌트. |
| ADR-0037 follow-up-queue | PlanStore snapshot도 follow-up-queue snapshot 패턴 거울 — `AgentConfig.planSnapshotStore?` (P7). |
| ADR-0069 typed-tool-failure | 4 plan 도구 모두 ok:false 시 `failure: { mode: "rejected", reason: <PlanMutationErrorCode> }`. |

## 한계 (Limitations)

- **(a) default-OFF byte-identical**: `AgentConfig.planStore?` 부재 시 4 도구 미등록 + dispatch ctx 필드 omit + 6 이벤트 emit 사이트 미배선. 기존 loop 회귀 면적 0. P5(persistence wire)·P6(plan-exit lifecycle)·P7(slash command `/plan`) 통합은 본 ADR이 닫지 않음 — 별도 follow-up 슬라이스.
- **(b) P5 wired, P6/P7는 documented as follow-up**: P5에서 `AgentConfig.planStore`가 있으면 `dispatch.ts`가 `planStoreToMutator` 어댑터를 매 dispatch마다 fresh build, 4 도구가 conditionally 등록된다. P6(plan-exit-three-way → PlanStore.clear()/freeze())와 P7(snapshot persistence + slash command `/plan`)은 follow-up 슬라이스.
- **(c) `plan_cleared` 이벤트는 P6 wiring 전까지 reserved**: 슬롯은 본 ADR에서 union에 박지만 emit 사이트는 P6에서 비로소 채워진다. 그 전까지는 dead-but-typed.
- **(d) `update_plan`의 phase 재정렬은 phaseIds 전체 명시 필요**: 부분 swap 미지원 — 모델은 전체 순서를 보내야 한다. follow-up에서 patch-mode 추가 가능.

## 불변식 (Invariants)

- **byte-identical default**: `AgentConfig.planStore` 부재 시 도구 미등록 + ctx 필드 omit + 이벤트 미emit. `NullStream`은 6 이벤트 전부 swallow. recorder는 recovery family로 fold.
- **슬라이스 격리**: biome `noRestrictedImports`가 `@/tool` → `@/agent/plan` 차단. 도구는 `ToolContext.planMutator` 미러만 본다(ADR-0096 contract).
- **closed-shape 확장 강제**: 새 `TodoStatus`는 `ALL_TODO_STATUSES` 갱신 + `transitions.ts` matrix 추가 강제(exhaustive switch가 컴파일 fail). 새 `PlanMutationError` variant는 모든 producer/consumer switch를 컴파일 fail로 깨운다.
- **신규 npm dep 0**.

## 검증 (Verification)

- **`tests/unit/agent/plan/mutations-hell.test.ts`** — PlanMutationError 9/10 variants 전수: version_conflict / todo_not_found / phase_not_found / dependency_cycle(직접 + 간접 + 7-node 깊은) / dependency_unknown / self_dependency / duplicate_id / content_too_long(3 fields × boundary+1) / invalid_status_transition(9 위반 전부) / empty_plan_create. (`version_conflict`는 state.ts CAS 경로에서 cover.)
- **`tests/unit/agent/plan/dag-hell.test.ts`** — 100-node depth-limited DAG perf gate (<50ms), 100% branched tree (폭 100) 위상정렬 안정성, 깊숙이 숨은 사이클 탐지, multi-source 위상정렬 결정성(tie-break = id 사전순).
- **`tests/unit/agent/plan/transitions-hell.test.ts`** — 5×5 transition matrix 전수 (25 cells, 허용/거부 라벨 모두 명시), terminal에서의 outgoing 거부 전부, exhaustive switch `never` 가드.
- **`tests/unit/agent/plan/snapshot-roundtrip-hell.test.ts`** — 100-todo snapshot → restore → byte-identical JSON, snapshot-중-mutation race(snapshot은 동기 freeze), 손상된 snapshot(9 schema violations) 명확한 거부.
- **`tests/unit/agent/plan/plan-mutator-concurrent.test.ts`** — CAS: 같은 `expected_version`으로 두 번 update → 첫 번째만 ok, 두 번째 `version_conflict`. snapshot 직후 mutation → version +1 일관.
- **도구 hellgate** (`tests/unit/tool/plan/`) — 도구당 closed input schema rejection (zod 부적합 24개) / typed-failure 라우팅 / missing-port(`ctx.planMutator` absent) graceful.
- **e2e** (`tests/integration/plan-mode-e2e.test.ts`) — 6 시나리오: happy path(create→update→exit) / rejection(stale version) / user_input pair / persistence / subagent assignee / changes_requested feedback seed.

> 합산 자산 목표: **239+ hellgate cases / 571+ expects** (P1 hellgate 4 파일 + 도구 hellgate + transitions/DAG perf gate). 회귀 0.

## SOTA++ 자리매김

본 ADR은 plan-mode 협업 루프의 *4번째 평면*이다(이미 잠긴 3개 평면 위에 적층):

1. **Posture 평면 (ADR-0018, ADR-0036)**: 모드 enum + dispatch-seam mutating block. "plan 동안에는 부수효과 차단".
2. **Exit 결정 평면 (ADR-0063, ADR-0086)**: approve/reject/changes_requested 3-way + `request_plan_exit` host port. "plan을 *어떻게* 떠나는가".
3. **운영자 입력 평면 (ADR-0097)**: `request_user_input` host port. "plan 중에 사람에게 *묻기*".
4. **State 평면 (본 ADR-0095)**: typed 4-tool + 6-event + closed mutation taxonomy. "plan을 *모델이 어떻게 갱신하는가*".

세 모델(Codex/Cursor/Claude)은 위 4 평면 중 *부분만* 갖춤:

- Codex: 1 + 4(부분, 이벤트만 — 모델이 mutator 안 가짐).
- Cursor: 1 + 4(maximalist, 그러나 loose enum / no DAG / 묵시 승인).
- Claude: 1 + 2(approve/reject만, 3-way 부족) + state 평면 부재.

> 우리는 4개 평면 모두 closed-shape + slice-isolated + default-OFF로 박는다. ROI-무관 SOTA++ 흡수 — 세 모델 모두 능가하는 자세.

## 위험·완화

| 위험 | 완화 |
|---|---|
| loop.ts hot path 부풀음 | plan 로직은 슬라이스에서 닫고, loop는 1) snapshot hydrate(P7), 2) plan-exit 라이프사이클(P6)만 다룸 (≤20줄 추가). |
| 도구 폭발(4개 신규) | 전부 `ctx.planMutator` 부재 시 미등록 — default-OFF byte-identical. |
| 이벤트 union 확장이 surface 회귀 | NullStream swallow + jsonl mapping을 recovery family로 fold (greppable). |
| DAG validator 성능 | DFS w/ tri-state color로 충분; 100노드 ≤50ms 가드 테스트로 PIN. |
| status transition matrix 드리프트 | exhaustive switch + 25-cell 전수 테스트로 컴파일/CI 단계 차단. |
| plan-exit 인터랙션 모호 | P6 wiring 슬라이스에서 PlanStore 상태머신을 plan-exit-flow.ts에 명시 — approve=freeze, reject=clear, changes_requested=keep+feedback-seed. |
| `Plan.todos`의 deep mutation | `Readonly<Record>` + readonly fields가 컴파일 fail로 1차 방어. 런타임 `Object.freeze`는 P7 검토(snapshot round-trip 시점). |

## 불변식 강제 메커니즘

새 plan 관련 코드를 추가할 때 *컴파일이 자동으로 잡는* 것:

- 새 `TodoStatus` value를 추가하면 `ALL_TODO_STATUSES` readonly 배열·`transitions.ts` matrix·`@/tool` mirror `PlanDeltaKind`·`transitions-hell.test.ts`의 25-cell 전수 모두 컴파일 fail까지 fix해야 통과.
- 새 `PlanMutationError` variant를 추가하면 `errorCode` switch(어댑터)·`@/tool` mirror `PlanMutationErrorCode`·`mutations-hell.test.ts`의 case 전수가 컴파일 fail.
- 새 `PlanDelta` variant를 추가하면 `mutator-adapter.ts`의 `extractIds` switch·stream adapters·jsonl-recorder mapping이 컴파일 fail.
- 새 AgentEvent variant(예: 7번째 plan event)를 추가하면 NullStream/stdout/jsonl-recorder adapter 3종이 컴파일 fail.

이 *컴파일-fail에 의한 drift 차단*이 휴리스틱-0 원칙의 핵심이다. 인간 리뷰는 *마지막* 안전망이며, *1차 안전망*은 닫힌 타입 + exhaustive switch.
