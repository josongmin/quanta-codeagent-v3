# Plan-mode SOTA++ implementation plan

2026-05-23. **ROI-무관 풀스택 흡수 설계**. 목표: 구조화 plan-state mutation 도구를
Cursor maximalist 모델 + Codex 이벤트 관측 + Claude 승인 ergonomics를 합쳐 **세
모델 모두 능가**하는 형태로 우리 슬라이스/HITL/follow-up-queue/plan-exit 패턴
위에 적층. L1 의식적 보류 → L4 정식 흡수로 가는 경로.

## 0. 흡수하지 *않는* 것 (negative invariants)
- Cursor `auto_approved` 묵시 승인 — 우리 HITL 4-tier(ADR-0047)로 명시 게이트.
- Cursor `bubble_id` 등 UI 내부 트래킹 — surface 책임이라 제외.
- Codex의 plan-state를 *이벤트로만* 노출하는 비대칭(읽기는 모델 외부, 쓰기는 모델 내부) — 우리는 양방향 모두 1급.
- Claude의 plan-state 부재(ExitPlanMode 단독) — 이미 흡수 완료(ADR-0086), 본 작업으로 보강.

## 1. 데이터 모델 (closed shapes, version-tracked)

`src/agent/plan/types.ts` — 닫힌 union·literal·readonly. zod 없음(plain TS, 우리 핫패스 패턴).

```ts
/** 5-state 닫힌 enum + ALL_TODO_STATUSES exhaustive 가드 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked"
export const ALL_TODO_STATUSES: readonly TodoStatus[] = Object.freeze([
  "pending", "in_progress", "completed", "cancelled", "blocked",
] as const)

export interface TodoItem {
  readonly id: string                       // ULID, monotonic
  readonly content: string                  // ≤500 chars (MAX_CONTENT)
  readonly status: TodoStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly dependencies: readonly string[]  // todo IDs (DAG-validated)
  readonly phaseId?: string
  readonly assignee?: string                // subagent nickname (ADR-0042)
  readonly verifyHint?: string              // "어느 도구로 검증?" — verify-guard 연결
}

export interface Phase {
  readonly id: string
  readonly name: string
  readonly todoIds: readonly string[]
  readonly order: number                    // strictly monotonic, gap-allowed
}

/** 닫힌 plan envelope. version은 CAS optimistic concurrency. */
export interface Plan {
  readonly version: number                  // 0부터 시작, mutation마다 +1
  readonly name: string                     // ≤120 chars
  readonly overview: string                 // ≤2000 chars
  readonly isProject: boolean
  readonly todos: Readonly<Record<string, TodoItem>>
  readonly phases: readonly Phase[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** mutation 결과의 typed delta (이벤트 + UI rendering 양쪽에 동일 shape). */
export type PlanDelta =
  | { kind: "created"; plan: Plan }
  | { kind: "todos_added"; added: readonly TodoItem[]; plan: Plan }
  | { kind: "todos_updated"; updated: readonly TodoItem[]; plan: Plan }
  | { kind: "todos_removed"; removedIds: readonly string[]; plan: Plan }
  | { kind: "phases_reordered"; plan: Plan }
  | { kind: "noop"; plan: Plan }            // empty patch는 변화 없음 (idempotent)

/** 닫힌 거부 사유 (mutations + DAG validator 공통). */
export type PlanMutationError =
  | { kind: "version_conflict"; expected: number; actual: number }
  | { kind: "todo_not_found"; id: string }
  | { kind: "phase_not_found"; id: string }
  | { kind: "dependency_cycle"; path: readonly string[] }
  | { kind: "dependency_unknown"; from: string; to: string }
  | { kind: "self_dependency"; id: string }
  | { kind: "content_too_long"; field: "name" | "overview" | "content"; max: number }
  | { kind: "invalid_status_transition"; from: TodoStatus; to: TodoStatus; id: string }
  | { kind: "duplicate_id"; id: string }
  | { kind: "empty_plan_create" }            // create with 0 todos AND 0 phases
```

**상태 전이 규칙** (`invalid_status_transition`):
```
pending      → in_progress | cancelled | blocked
in_progress  → completed | blocked | cancelled
blocked      → in_progress | cancelled
completed    → (terminal)
cancelled    → (terminal)
```
Terminal 위반 시 typed 거부.

## 2. 코어 모듈 (slice `@/agent/plan`)

```
src/agent/plan/
├── types.ts          // 위 데이터 모델
├── state.ts          // PlanStore class (Result<T, PlanMutationError> 반환)
├── mutations.ts      // pure reducers (create/addTodo/updateTodo/removeTodo/reorderPhases)
├── dag.ts            // 위상정렬 + 사이클 탐지 (DFS w/ color tri-state)
├── transitions.ts    // 닫힌 status-transition matrix + exhaustive check
├── events.ts         // emitPlanDelta(stream, delta) helper
├── snapshot.ts       // PlanSnapshot serialize/deserialize (round-trip identity 보장)
└── index.ts          // barrel
```

**PlanStore 인터페이스** (`state.ts`):
```ts
export type PlanResult<T = PlanDelta> =
  | { ok: true; value: T }
  | { ok: false; error: PlanMutationError }

export interface PlanStore {
  current(): Plan | null
  /** 모든 mutation은 expected version으로 CAS. 충돌 시 version_conflict. */
  create(args: CreatePlanArgs, expectedVersion?: number): PlanResult
  addTodos(items: readonly NewTodo[], expectedVersion: number): PlanResult
  updateTodos(patches: readonly TodoPatch[], merge: boolean, expectedVersion: number): PlanResult
  removeTodos(ids: readonly string[], expectedVersion: number): PlanResult
  reorderPhases(phaseIds: readonly string[], expectedVersion: number): PlanResult
  snapshot(): PlanSnapshot
  restore(snap: PlanSnapshot): void
}
```

순수성: `mutations.ts`의 reducer는 `(plan, patch) => PlanResult`(side-effect 0). `state.ts`는 reducer를 wrap해 version bump + emit.

## 3. 모델-호출 도구 (`src/tool/plan/`, 슬라이스 격리 ToolContext seam)

**ToolContext duck-typed seam** (`src/tool/types.ts`에 추가):
```ts
export interface PlanMutator {
  create(args: CreatePlanInput): PlanMutationResult
  addTodos(items: readonly NewTodoInput[], expectedVersion: number): PlanMutationResult
  updateTodos(patches: readonly TodoPatchInput[], merge: boolean, expectedVersion: number): PlanMutationResult
  removeTodos(ids: readonly string[], expectedVersion: number): PlanMutationResult
  reorderPhases(phaseIds: readonly string[], expectedVersion: number): PlanMutationResult
  current(): PlanReadonly | null            // tool 측은 readonly 미러만
}
export type PlanMutationResult =
  | { ok: true; version: number; deltaKind: PlanDeltaKind; touchedIds: readonly string[] }
  | { ok: false; reason: string; code: PlanMutationErrorCode }
```
@/tool은 @/agent/plan을 import 안 함 — biome noRestrictedImports로 격리. dispatch.ts(@/agent)가 PlanStore→PlanMutator 어댑터로 wire.

**도구 4개** (Cursor 흡수 + Codex 이벤트 + 우리 typed-failure 적용):

| 도구 | 입력 | 출력 (성공) | 비고 |
|---|---|---|---|
| `create_plan` | `{name, overview, isProject?, todos[], phases?[]}` | `{version:0, plan_uri}` | 기존 plan 존재 시 `version_conflict` |
| `update_todos` | `{patches[]: TodoPatch, merge?: boolean, expected_version}` | `{version, delta_kind, touched_ids}` | merge=true → 부분 갱신, false → 전체 교체 |
| `update_plan` | `{name?, overview?, phases?[], expected_version}` | `{version, delta_kind}` | 메타 + phase 재정렬 전용 |
| `remove_todos` | `{ids[], expected_version}` | `{version, delta_kind, touched_ids}` | 의존성 가진 todo 삭제 시 `dependency_unknown` (dangling) |

도구는 전부 **`typed-tool-failure` 적용**: ok:false 시 `failure: { mode: "rejected", reason: "version_conflict" | "dependency_cycle" | ... }` (ADR-0069 5-mode + plan-specific reason 코드를 detail로).

zod 스키마는 `src/tool/plan/schemas.ts`에 — 우리 도구 표준.

## 4. 운영자 입력 도구 — `request_user_input` (host port mirror)

ADR-0086 `request_plan_exit` 패턴 그대로 미러:
- `ToolContext.requestUserInput?: (prompt: string, opts?: {choices?:string[]; multiline?:boolean}) => Promise<{decision:"answer"; text:string} | {decision:"cancelled"}>`
- AgentConfig.userInputPort 부재 시 도구 미등록 → byte-identical.
- 운영자(CLI/IDE)가 port 구현.
- 닫힌 outcome enum: `answer | cancelled`.

새 ADR-0095로 ADR-0086의 자매 ADR로 등재.

## 5. 이벤트 스트림 (Codex `plan_delta`/`plan_update` 흡수 + 우리 AgentEvent union 확장)

`src/stream/types.ts`에 추가:
```ts
  | { type: "plan_created"; plan: PlanReadonly }
  | { type: "plan_updated"; delta: PlanDeltaReadonly; version: number }
  | { type: "plan_snapshot"; plan: PlanReadonly }   // late-attach surface용
  | { type: "plan_user_input_requested"; promptId: string; prompt: string; choices?: readonly string[] }
  | { type: "plan_user_input_resolved"; promptId: string; decision: "answer" | "cancelled"; text?: string }
```

- `plan_updated.delta`는 §1의 `PlanDelta` readonly 미러 — UI는 incremental render 가능.
- `plan_snapshot`은 늦게 붙는 surface(재연결한 web/IDE) 위한 full-state.
- `NullStream`은 전부 swallow → default-OFF byte-identical.
- `jsonl-recorder`는 recovery family에 mapping(우리 컨벤션).
- `stdout` adapter는 dim 1-line render: `📋 plan v3: 5 todos (3 done, 2 pending)`.

## 6. 통합 (기존 ADR과의 wiring)

| 기존 메커니즘 | 통합 방식 |
|---|---|
| ADR-0036 plan-mode dispatch-block | `MUTATING_TOOL_TABLE`에 plan 도구 = `plan_allowed:true` 플래그. plan posture에서 다른 mutating은 차단되지만 plan 도구는 **명시적으로 허용**. |
| ADR-0086 plan-exit-three-way | `request_plan_exit` 승인 → PlanStore의 plan을 default-mode 첫 턴 system reminder에 주입(읽기전용). 거부 → PlanStore.clear(). changes_requested → plan 유지 + feedback을 다음 prompt 시드로. |
| ADR-0047 HITL 4-tier | plan 도구 4종은 자체적으로 `no_confirm`(모델 주도, 사용자 review는 plan-exit 단계). `request_user_input`은 `hand_off_required`(blocking). |
| ADR-0042 subagent nickname | `TodoItem.assignee?` 필드로 자식 subagent에 todo 할당 가능. spawn_agent와 짝. |
| ADR-0013 verify-guard | `TodoItem.verifyHint?` → completed 전이 시 verify-guard에 "이 todo 검증했나?" 힌트. |
| ADR-0037 follow-up-queue | PlanStore.snapshot도 동일한 `AgentConfig.planSnapshotStore?` 패턴으로 session-resume hydrate + save. |

## 7. 영속화

- `AgentConfig.planStore?: PlanStore` (default-OFF byte-identical).
- `AgentConfig.planSnapshotStore?: { load(): Promise<PlanSnapshot|null>; save(s: PlanSnapshot): Promise<void> }` — follow-up-queue snapshot 패턴 거울.
- session-start: loop가 snapshot 로드 → `planStore.restore(snap)` → `plan_snapshot` 이벤트 emit.
- session-end: loop가 `planStore.snapshot()` 저장 + 실패 시 recovery emit (조용히 죽지 않음).

## 8. 슬라이스 격리 (biome noRestrictedImports)

```
@/agent/plan  ─┐
               ├── @/storage, @/shared ✓
               └── @/agent/* ✓ (같은 슬라이스)

@/tool        ─┐
               ├── @/agent/plan ✗ (slice isolation)
               └── PlanMutator는 ToolContext duck-typed seam
```

biome.json `overrides`에 plan 슬라이스 항목 추가. `src/agent/plan`이 `@/tool`/`@/permission`/`@/mcp` 등 가로지르지 않도록 별도 fence. `@/tool/plan`은 plan 슬라이스 미import.

## 9. 헬게이트 + e2e 테스트 (짜치는 거 0)

### 9.1 단위 hellgate (`tests/unit/agent/plan/`)

**`mutations-hell.test.ts`** — 모든 PlanMutationError 변형:
- `version_conflict`: stale expected_version
- `todo_not_found`: update/remove unknown id
- `phase_not_found`: assign to unknown phase
- `dependency_cycle`: A→B→A (직접) + A→B→C→A (간접) + 7-노드 깊은 사이클
- `dependency_unknown`: 외부 todo 참조
- `self_dependency`: A→A
- `duplicate_id`: 같은 ULID 두 번 add
- `content_too_long`: name/overview/content 각각 경계+1
- `invalid_status_transition`: completed→pending 등 9가지 위반 전부
- `empty_plan_create`

**`dag-hell.test.ts`** — DAG 알고리즘:
- 100-노드 깊이-제한 DAG 검증 perf gate (≤5ms)
- 100% 분기된 트리(폭 100) 위상정렬 안정성
- 사이클이 큰 그래프 내부 깊숙이 숨어있을 때 탐지
- 다중 시작점 위상정렬 결정성 (tie-break는 id 사전순)

**`transitions-hell.test.ts`** — status transition matrix:
- 5×5 전이 행렬 전수 (25개) — 허용/거부 라벨 모두 명시
- terminal에서의 모든 outgoing 거부
- exhaustive switch `never` 가드

**`snapshot-roundtrip-hell.test.ts`**:
- 100-todo plan snapshot → restore → 동일 (byte-identical JSON)
- snapshot 중 mutation race (snapshot은 동기적 freeze)
- 손상된 snapshot(스키마 violations 9가지) → 명확한 거부

**`plan-mutator-concurrent.test.ts`** — CAS 동시성:
- 같은 expected_version으로 두 번 update → 첫 번째만 성공, 두 번째는 version_conflict
- snapshot 직후 mutation → version +1 일관

### 9.2 도구 hellgate (`tests/unit/tool/plan/`)

각 도구당 closed input schema rejection (zod 부적합 24가지), typed-failure 라우팅, missing-port (ctx.planMutator absent) graceful.

### 9.3 e2e (`tests/integration/plan-mode-e2e.test.ts`)

**runAgent 전수 흐름**:
1. **happy path**: model이 `create_plan` → `plan_created` 이벤트 emit → model이 `update_todos` → `plan_updated{delta_kind:"todos_added"}` emit → `request_plan_exit` 승인 → default mode 진입 + plan이 system reminder에 주입됨 → model이 첫 todo 실행 → completed 전이.
2. **rejection path**: model 도구 호출 → version stale → typed failure `rejected{reason:"version_conflict"}` → model이 current() 재읽기 후 재시도.
3. **user_input path**: model이 `request_user_input` → host가 응답 → plan_user_input_resolved 이벤트 → model 진행.
4. **persistence**: 첫 세션에서 plan 만들고 종료 → snapshot 저장 → 새 세션 시작 → hydrate → `plan_snapshot` 이벤트 → model이 current()로 복구 확인.
5. **subagent assignment**: `TodoItem.assignee="lyra"` → `spawn_agent({nickname:"lyra"})` → 자식 종료 시 부모 plan에 completed 반영.
6. **plan-exit changes_requested**: 피드백 텍스트가 다음 prompt에 주입 + plan 유지.

총 자산: 헬게이트 ~120 케이스 / 350+ expects / 6 e2e 시나리오.

## 10. 새 ADR 3개 (draft 필요)

| ADR | 제목 | 범위 |
|---|---|---|
| **0093** | Structured plan-mode tools (data model + 도구 4개 + 이벤트 5개) | §1-§5 |
| **0094** | PlanStore port + 슬라이스 격리 contract | §2, §3, §8 |
| **0095** | `request_user_input` host port (ADR-0086 자매) | §4 |

각 ADR은 negative invariants 명시(§0).

## 11. 단계별 롤아웃

| Phase | 범위 | 산출물 | Effort |
|---|---|---|---|
| **P1** | `@/agent/plan` 슬라이스 — types/mutations/dag/transitions/snapshot/state | 6 파일 + §9.1의 mutations/dag/transitions/snapshot hellgate 4 파일 | M (1-2일) |
| **P2** | 4 도구 (`@/tool/plan`) + ToolContext seam | 4 도구 + schemas + plan-mutator 인터페이스 + §9.2 도구 hellgate | M (1-2일) |
| **P3** | dispatch.ts wiring + plan-mode 카브아웃 + AgentEvent 5 변형 + jsonl/stdout 어댑터 | dispatch.ts edits + stream/types.ts + adapters | S (0.5일) |
| **P4** | `request_user_input` port + ToolContext seam + 자매 ADR-0095 | tool + dispatch wire + ADR 문서 | S (0.5일) |
| **P5** | snapshot 영속화 — AgentConfig.planStore/planSnapshotStore + loop 하이드레이트/저장 | loop.ts edits + tests | S (0.5일) |
| **P6** | plan-exit-three-way 통합 — 승인/거부/changes-requested → plan 라이프사이클 | plan-exit-flow.ts edits + e2e | M (1일) |
| **P7** | §9.3 e2e 6 시나리오 + biome 슬라이스 격리 추가 | 1 e2e 파일 + biome.json | S (0.5일) |
| **P8** | 3 ADR 작성 + fc YAML L1→L4 + docs/10 빌드 | docs/decisions/* + fc 갱신 | S (0.5일) |

**총 예상**: 7-8일 (병렬화하면 worktree 3-4 에이전트로 3-4일).

## 12. SOTA++ 차별화 요약 (세 모델 능가 지점)

| 차원 | Codex | Cursor | Claude | **우리 (계획)** |
|---|---|---|---|---|
| Plan-mutation 도구 | 없음(이벤트만) | 2개(create_plan, update_todos) | 없음 | **4개** + CAS version + typed failures |
| Status enum | — | `UNSPECIFIED` 포함 (loose) | — | **5-state 닫힌 + exhaustive switch + transition matrix** |
| 의존성 검증 | — | 없음(필드만 있음) | — | **DAG validator + 사이클 탐지 + dangling 거부** |
| 이벤트 | 2종(delta+update) | UI 통합 모호 | 0종 | **5종** + 늦은-attach snapshot + user_input 페어 |
| 영속화 | 내부 | 내부 | 없음 | **명시적 port + session-resume hydrate** |
| 승인 | — | 묵시(`auto_approved` 플래그) | message-level | **명시 HITL 4-tier + plan-exit 3-way 결합** |
| 슬라이스 격리 | N/A (TS 아님) | 없음 | 없음 | **biome fence + ToolContext duck-typed seam** |
| 운영자 입력 | 이벤트(request_user_input) | 없음 | 없음 | **1급 도구 + port mirror of ADR-0086** |
| subagent 통합 | 없음 | 없음 | 없음 | **TodoItem.assignee → ADR-0042 nickname** |
| verify-guard 통합 | 없음 | 없음 | 없음 | **TodoItem.verifyHint → ADR-0013 후크** |

## 13. 위험·완화

| 위험 | 완화 |
|---|---|
| loop.ts hot path 부풀음 | plan 로직은 슬라이스에서 닫고, loop는 1) snapshot hydrate, 2) plan-exit 라이프사이클만 다룸 (≤20줄 추가) |
| 도구 폭발(4개 신규) | 전부 ctx 부재 시 미등록 — default-OFF byte-identical |
| 이벤트 union 확장이 surface 회귀 | NullStream swallow + jsonl mapping을 recovery family로 fold (greppable) |
| DAG validator 성능 | tarjan SCC 아니라 DFS w/ tri-state color로 충분; 100노드 ≤5ms 가드 테스트로 PIN |
| status transition matrix 드리프트 | exhaustive switch + 25-cell 전수 테스트 |
| plan-exit 인터랙션 모호 | plan-exit-flow.ts에서 PlanStore 상태머신 명시 — approve=freeze, reject=clear, changes_requested=keep+feedback-seed |

## 14. 시작 신호

`@/agent/plan/types.ts` 작성부터 — types만 박혀도 hellgate 4 파일을 병렬로 쓸 수 있다(slice 1 agent, hellgate 1 agent, e2e 1 agent). 5-7일 총 일정.
