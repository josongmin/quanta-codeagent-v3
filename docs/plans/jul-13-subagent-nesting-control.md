# RFC: Sub-agent nesting control — explicit lineage authority

| | |
|---|---|
| **상태** | Draft / implementation migration required |
| **날짜** | 2026-07-14 (rev.4 — current-main 기반 SOTA++ authority 재설계) |
| **범위** | 모든 descendant agent 실행의 lineage, depth admission, tool projection, resume/persistence를 하나의 권위 모델로 통제 |
| **선행 문맥** | ADR-0011(subagent), ADR-0158/0159(persistence/resume), ADR-0416(sibling identity), ADR-0437(followup), ADR-0503(knob control plane) |

---

## 0. Executive decision

현재 `origin/main`에는 이미 nesting-control Wave 1/2가 들어가 있다.

- `src/agent/spawn-depth-policy.ts`: `spawnDepthCap()` / `spawnToolsAvailable()`
- `QUANTA_MAX_SPAWN_DEPTH`: default `1`, `0` = 새 descendant 생성 kill switch
- `config.subagent.maxDepth` / `QUANTA_SUBAGENT_MAX_DEPTH`: 별도 legacy override
- `tier1/subagent.ts`, `subagent-batch.ts`, `delegate.ts`, `team.ts`: builder-local capability gates
- background/delegate caller: `parentDepth + 1` 전달
- `subagent-runner.ts`: 여전히 `req.depth`를 child config, reject, run id, metadata에 사용

따라서 이 RFC는 신규 기능안이 아니다. **부분 구현을 단일 authority로 마이그레이션하는 repair RFC**다.
default를 `3`으로 되돌렸다가 다시 `1`로 flip하지 않는다. 현재 live default `1`을 유지한다.

최종 결정:

> A descendant agent may run only with an authority-issued grant. Root identity is explicit,
> child depth is derived exactly once, policy is session-pinned, and resume preserves persisted lineage.

Capability projection은 최적화다. 권위 경계는 모든 descendant `runAgent` 진입 직전의 typed admission이다.

---

## 1. Problem statement

현재 depth는 숫자 plumbing에 가깝고 provenance가 없다.

1. `AgentConfig.depth?: number`에서 `undefined`를 root로 취급한다. 실제 root라는 증거가 없다.
2. `SubagentRequest.depth`가 caller-asserted이며 runner의 여러 후속 동작에 남아 있다.
3. standard `SubagentRunner`를 우회하고 `runAgent`를 직접 호출하는 descendant 경로가 있다
   (`branch_search`가 대표적).
4. tool-name 수동 집합은 실제 spawn surface를 완전하게 표현하지 못한다.
   `subagent_fork`, `git_review_diff`, `branch_search`는 agent를 만들지만 `team_create`는 만들지 않는다.
5. persisted background handle에는 depth/lineage가 없다. Resume은 저장된 depth를 복원하지 않고
   `scheduler.fork(spec)`를 다시 호출한다.
6. `runtimeConfig()`는 `/knobs set` override에 의해 live invalidation된다. first-access immutable snapshot이 아니다.
7. `QUANTA_MAX_SPAWN_DEPTH`, `QUANTA_SUBAGENT_MAX_DEPTH`, per-call `max_depth`의 역할과 우선순위가 분산돼 있다.

이 상태에서 builder filter만 강화하면 새로운 spawn surface, direct `runAgent`, resume, live knob 변경에서
동일한 hole이 재발한다.

---

## 2. Goals / non-goals

### Goals

- **G1 — explicit root:** root는 `undefined`가 아니라 명시적 `kind:"root", depth:0` authority를 가진다.
- **G2 — derived child lineage:** 새 child depth는 authority가 `parent.depth + 1`로 한 번만 계산한다.
- **G3 — single runtime boundary:** 모든 descendant `runAgent` 실행은 `SpawnGrantV1` 또는 `ResumeGrantV1`을 요구한다.
- **G4 — fail-closed:** missing/malformed/unsafe depth, policy conflict, lineage-less resume는 typed deny다. throw나 root fallback이 아니다.
- **G5 — complete projection:** runtime tool metadata로 spawn/manage/observe capability를 분류한다. 이름 문자열 목록을 권위로 쓰지 않는다.
- **G6 — session-pinned policy:** root에서 resolve한 policy snapshot을 모든 자식이 상속한다. 같은 lineage에서 live widening은 없다.
- **G7 — deterministic resume:** resume은 새 edge를 만들지 않고 persisted lineage를 복원한다.
- **G8 — executable completeness:** 새 descendant entry가 authority를 우회하면 AST/static hellgate가 RED가 된다.
- **G9 — observable invariants:** projection/admission은 effective `policyId`를, resume은 persisted/effective policy ID와 보존 depth를 함께 기록한다.

### Non-goals

- UI용 전체 agent graph나 genealogy viewer.
- 모델 행동을 프롬프트로 유도하는 heuristic leaf policy.
- team membership를 spawn으로 재정의. `team_create`/`team_delete`는 coordination 관리다.
- 이미 실행 중인 agent process를 cap `0`으로 강제 종료. cap은 **새 lineage edge 생성**을 막는다.
- 경쟁사와의 최초성 주장. 목적은 novelty가 아니라 authority correctness다.

---

## 3. Normative invariants

| ID | Invariant |
|---|---|
| INV-01 | Root lineage는 `kind:"root" && depth===0`으로 명시된다. `undefined ⇒ root` 금지. |
| INV-02 | New child는 `childDepth === parent.depth + 1`이며 safe integer다. |
| INV-03 | Descendant `runAgent`는 authority-issued grant 없이는 호출할 수 없다. |
| INV-04 | `SubagentRequest`의 caller field는 child config, run id, metadata, telemetry authority로 사용되지 않는다. |
| INV-05 | `childDepth > policy.maxDescendantDepth`이면 child loop, worktree, registry task를 만들기 전에 deny한다. |
| INV-06 | Tool projection과 runtime admission은 동일한 immutable `policyId`를 사용한다. |
| INV-07 | `agentEffect:"spawn-descendant"` tool이 노출된 parent는 host policy상 최소 한 child를 admit할 수 있다. |
| INV-08 | Per-call requested cap은 host cap을 낮출 수만 있다. 이 deny는 host-depth deny와 별도 reason이다. |
| INV-09 | Resume은 persisted lineage depth를 보존한다. 현재 parent에서 depth를 재계산하지 않는다. |
| INV-10 | Legacy persisted record에 lineage가 없으면 자동 resume하지 않는다. |
| INV-11 | Tool 이름 추가/변경만으로 spawn capability를 우회할 수 없다. |
| INV-12 | Metrics label에는 session/agent/task id를 넣지 않는다. 고 cardinality 값은 structured event에만 둔다. |
| INV-13 | Spawn/Resume grant는 single-consumer다. 같은 grant로 두 agent loop를 시작할 수 없다. |

---

## 4. Authority model

### 4.1 Explicit lineage and pinned policy

신규 작은 carrier 두 개를 둔다. 대형 graph registry는 필요 없지만, optional number만으로는 root provenance와
resume을 증명할 수 없으므로 discriminated lineage는 필요하다.

```ts
export interface SpawnPolicySnapshotV1 {
  readonly version: 1
  readonly policyId: string                 // canonical fields digest
  readonly maxDescendantDepth: number       // non-negative safe integer
  readonly source: "default" | "env" | "legacy-env" | "managed"
}

export type AgentLineageV1 =
  | {
      readonly version: 1
      readonly kind: "root"
      readonly depth: 0
      readonly rootSessionId: string
      readonly policy: SpawnPolicySnapshotV1
    }
  | {
      readonly version: 1
      readonly kind: "descendant"
      readonly depth: number                // positive safe integer
      readonly rootSessionId: string
      readonly parentAgentId: string
      readonly policy: SpawnPolicySnapshotV1
    }
```

Validation은 `Number.isSafeInteger` + non-negative를 쓴다. `Number.isInteger`만 쓰면 overflow/precision loss를
허용한다.

Root assembly만 `RootGrantV1`을 만들 수 있다. 기존 `runAgent(config)` public surface는 migration 후 다음 두
entry로 분리한다.

```ts
type AgentExecutionAuthorityV1 = RootGrantV1 | SpawnGrantV1 | ResumeGrantV1

// 세 grant 모두 lineage와 이번 execution에 적용할 effectivePolicy를 가진다.
runRootAgent(rootGrant: RootGrantV1, config: RootAgentConfig)
runDescendantAgent(grant: SpawnGrantV1 | ResumeGrantV1, config: ChildAgentConfig)
```

둘은 private `runAgentKernel(config)`로 합류한다. repo AST gate는 kernel/root/descendant owner 외부의
`runAgentKernel` 및 descendant-shaped `runAgent` 직접 호출을 금지한다.

Grant는 구조체 복사만으로 권위가 복제되지 않도록 private brand + random nonce를 갖는다. Authority owner의
consumption ledger가 `issued → consumed`를 atomic transition하며, 두 번째 consume은 `grant_reused` typed deny다.
Receipt가 필요한 path는 `issued → receipt_committed → consumed` 순서를 사용한다.

### 4.2 Admission is a typed result, never an exception

```ts
export type SpawnSourceV1 =
  | "agent"
  | "spawn_agent"
  | "spawn_batch"
  | "spawn_agents_on_csv"
  | "run_workflow"
  | "subagent_fork"
  | "delegate"
  | "branch_search"
  | "git_review_diff"
  | "guardian_reviewer"
  | "side_agent"

export type SpawnDenyCodeV1 =
  | "invalid_parent_lineage"
  | "invalid_policy"
  | "host_depth_exceeded"
  | "requested_depth_exceeded"
  | "policy_conflict"
  | "grant_reused"
  | "lineage_missing"
  | "policy_digest_mismatch"

export type SpawnAdmissionV1 =
  | { readonly ok: true; readonly grant: SpawnGrantV1 }
  | { readonly ok: false; readonly code: SpawnDenyCodeV1; readonly detail: SpawnDenyDetailV1 }
```

`authorizeNewChild(parentLineage, source, requestedCap?)`는 다음을 한 번만 수행한다.

1. parent lineage와 policy safe-integer validation
2. checked `childDepth = parent.depth + 1`
3. `effectiveCap = min(policy.maxDescendantDepth, requestedCap ?? +∞)`
4. host cap deny와 requested-cap deny 분리
5. 성공 시 immutable `SpawnGrantV1` 발급

Runner는 grant의 `childLineage`를 child config, run id, metadata, hook, telemetry에 공통 사용한다.
`SubagentRequest.depth`는 제거한다. 호환 기간에는 `assertedDepth?: number`로 rename해 mismatch 관측에만 쓰고
어떤 결정에도 사용하지 않는다.

### 4.3 Every descendant path must cross the boundary

현재 경로를 다음과 같이 분류한다.

| Path | Current execution seam | Required migration |
|---|---|---|
| `agent`, `spawn_agent`, workflow, CSV | `tier1/subagent.ts` → `createSubagentRunner` | runner가 grant를 발급하고 `runDescendantAgent` 호출 |
| `spawn_batch` | `tier1/subagent-batch.ts` → `createSubagentRunner` | 동일 runner authority 사용 |
| `subagent_fork` | background scheduler → injected runner | scheduler에서 depth 계산 제거, runner authority만 사용 |
| `delegate` | `wrapSubagentRunner` / delegation runner | request depth 제거, source만 전달 |
| `git_review_diff`, guardian | `materializeReviewerAgent` → runner | internal source로 동일 admission 사용 |
| `branch_search` | `branch-search-runner.ts` → direct `runAgent` | candidate마다 grant 발급 후 `runDescendantAgent` 호출 |
| side-agent pass | `side-agent-runner.ts` → runner | hardcoded depth 제거, lineage/grant 전달 |
| root/side conversation/eval root | direct `runAgent` | `runRootAgent` + explicit root grant로 분류 |

Static hellgate는 production의 `runAgent`/`runAgentKernel`/`createSubagentRunner` call site inventory를 snapshot하고,
새 call site가 분류 없이 추가되면 실패한다. 문자열 grep만 하지 않고 TypeScript AST로 callee와 import source를
확인한다.

---

## 5. Capability projection

### 5.1 Runtime metadata, not `SPAWN_TOOL_NAMES`

`Set<string>`은 rename, alias, scoped tool name, hidden internal spawner에서 drift한다. `Tool` runtime contract에
capability metadata를 추가한다.

```ts
export type AgentToolEffect =
  | "none"
  | "spawn-descendant"
  | "manage-descendant"
  | "observe-descendant"

interface Tool {
  readonly agentEffect: AgentToolEffect
}
```

분류:

- spawn: `agent`, `spawn_agent`, `spawn_batch`, `spawn_agents_on_csv`, `run_workflow`, `subagent_fork`,
  `delegate`, `branch_search`, `git_review_diff`
- manage: `task_stop`, `close_agent`, `send_input`, `subagent_force_background`
- observe: `task_output`, `wait_agent`, `list_agents`, `subagent_poll`, `subagent_await`, introspection
- coordination only: `team_create`, `team_delete`, mailbox tools — spawn capability 없음

Internal guardian reviewer는 LLM-visible tool projection과 별개지만 runtime admission은 동일하게 적용한다.

### 5.2 Projection seam

`agentEffect`는 필수다. 모든 tool factory가 `none`까지 명시해야 하므로 새 tool이 metadata 없이 compile되지
않는다. Spawn port를 소비하는 tool factory와 `agentEffect:"spawn-descendant"`의 parity는 AST hellgate로
검증한다.

`buildSessionFeatures`가 `extraTools`만 필터하면 base registry의 spawn-capable tool을 놓친다. Projection은
base registry + feature tools를 합친 **effective tool registry materialization 이후**, model prompt/schema를 만들기
전에 한 번 적용한다.

```ts
projectToolsForAuthority(tools, authority: AgentExecutionAuthorityV1): Tool[] {
  return canAdmitAnyNewChild(authority.lineage, authority.effectivePolicy)
    ? tools
    : tools.filter((t) => t.agentEffect !== "spawn-descendant")
}
```

`Tool.agentEffect`, `GATED_TOOLS.risk`, feature catalog의 spawn 분류는 parity test로 묶는다. 문서 manifest는
runtime authority가 아니지만 drift detector로 사용한다.

---

## 6. Policy configuration and migration

### 6.1 One canonical field

내부 SSOT는 `maxDescendantDepth` 하나다. 현재 default `1`을 유지한다.

```ts
readonly maxDescendantDepth: number // 1=root-only, 0=no new lineage edge
```

환경변수 migration:

| Env | Status |
|---|---|
| `QUANTA_MAX_DESCENDANT_DEPTH` | 신규 canonical name |
| `QUANTA_MAX_SPAWN_DEPTH` | legacy alias, deprecation warning |
| `QUANTA_SUBAGENT_MAX_DEPTH` | legacy alias, root assembly에서만 변환 |

규칙:

1. 하나만 설정되면 canonical field로 변환한다.
2. 둘 이상이 같은 값이면 허용 + deprecation event.
3. 둘 이상이 다른 값이면 startup/config assembly를 `policy_conflict`로 fail-closed한다. 조용한 precedence 금지.
4. invalid/unsafe integer는 default fallback이 아니라 명시적 config error다.
5. 세 knob 모두 `SESSION_FORBIDDEN_KNOBS`에 넣는다. `/knobs set`으로 mid-session widening/tightening하지 않는다.
6. per-call `spawn_agent.max_depth`는 canonical policy를 변경하지 않고 해당 호출만 tighten한다.
7. `opts.maxDepth` 숫자 주입은 production authority에서 제거한다. 테스트는 policy snapshot fixture를 주입한다.

### 6.2 Snapshot semantics

Root assembly가 `SpawnPolicySnapshotV1`을 한 번 resolve하고 lineage에 넣는다. 자식은 env/runtimeConfig를 다시
읽지 않는다. 정책 변경은 새 root session부터 적용한다.

Resume은 persisted policy와 현재 managed ceiling 중 더 엄격한 값을 사용한다. 재시작으로 정책이 넓어지지 않는다.
`persistedPolicyId`는 provenance로 보존하고, 실제 projection/admission은 새 `effectivePolicyId`를 사용한다.

---

## 7. Persistence and resume

### 7.1 Persisted schema V2

`PersistedHandle`에 lineage와 policy receipt를 추가한다.

```ts
interface PersistedHandleV2 {
  readonly version: 2
  readonly id: string
  readonly spec: SubagentSpec
  readonly lineage: AgentLineageV1
  readonly policyReceipt: {
    readonly policyId: string
    readonly maxDescendantDepth: number
  }
  // existing status/timestamps/output fields
}
```

쓰기 순서: grant 발급 → running handle에 lineage receipt durable write → child loop 시작. Receipt write 실패 시
child를 시작하지 않는다. 실행 후 저장만 시도하면 crash window에서 lineage 없는 running handle이 생긴다.

### 7.2 Resume is not a new lineage edge

`authorizeResume(handle, currentManagedCeiling)`은:

1. V2 lineage/policy digest 검증
2. persisted depth 그대로 보존
3. effective future-spawn cap을 `min(persistedCap, currentManagedCeiling)`으로 고정
4. `persistedPolicyId`와 `effectivePolicyId`를 함께 가진 `ResumeGrantV1` 발급

Resume 자체는 `parent.depth + 1`을 다시 계산하지 않는다. 예:

```text
root(d0) └─ A(d1) └─ B(d2)
root process에서 B를 resume해도 B.depth === 2
현재 managed cap이 1이면 B는 실행 가능하지만 새 child는 만들 수 없다.
```

cap `0`도 새 lineage edge만 금지한다. 기존 handle resume까지 차단하려면 별도 resume policy가 필요하다.

V1/legacy handle에 lineage가 없으면 자동 resume하지 않고 `lineage_missing`으로 interrupted 상태를 유지한다.
사용자는 명시적으로 “new task로 restart”할 수 있지만 이는 root/new-child 정책을 새로 적용하는 별개 작업이다.

---

## 8. Observability

### 8.1 Events

두 이벤트를 구분한다.

`agent.spawn.projection.v1` — effective registry materialization 시 1회:

- `depth`, `policyId`, `maxDescendantDepth`
- `spawnToolCountBefore`, `spawnToolCountAfter`
- `decision: exposed | removed`

`agent.spawn.admission.v1` — 실제 spawn/resume 시도마다:

- `source`, `parentDepth`, `childDepth`
- `policyId`, `persistedPolicyId`(resume only), `hostCap`, `requestedCap`, `effectiveCap`
- `decision: admitted | denied | resumed`
- `denyCode`
- optional structured-only ids: `rootSessionId`, `parentAgentId`, `childAgentId`

### 8.2 Valid invariants

- 같은 `policyId`에서 `host_depth_exceeded && projectionDecision==exposed`는 0이어야 한다.
- `requested_depth_exceeded && projectionDecision==exposed`는 정상이다. 모델이 self-tighten할 수 있다.
- forced injection은 projection을 우회하지만 runtime deny가 반드시 기록된다.
- direct internal spawn은 `projectionDecision:null`이며 runtime admission만 기록한다.
- 모든 admitted new child에서 `childDepth === parentDepth + 1`.
- 모든 resume에서 `childDepth === persistedDepth`.

Metrics는 `source/decision/denyCode/depth bucket`만 label로 사용한다. raw ids는 trace/log attribute로만 둔다.

---

## 9. Implementation plan

### Phase 0 — freeze current truth and RED rails

- 현재 default `1`, legacy knobs, builder gates, direct agent forks를 inventory fixture로 고정.
- RED: undefined root, forged request depth, `subagent_fork` projection miss, `branch_search` cap-0 bypass,
  lineage-less resume, conflicting knobs, live override widening.
- 기존 builder-local tests가 `team_create`를 spawn으로 오분류한 부분을 분리.

### Phase 1 — policy snapshot + explicit root

- `SpawnPolicySnapshotV1`, `AgentLineageV1`, validators 추가.
- root assemblers가 explicit `RootGrantV1`을 만들도록 배선.
- canonical config field + legacy alias conflict handling.
- 세 depth knob를 session-live override denylist에 추가.

### Phase 2 — single admission + run entry split

- `authorizeNewChild` / `SpawnGrantV1` 구현.
- `runRootAgent`, `runDescendantAgent`, private kernel 분리.
- `createSubagentRunner`가 derived grant만 사용하도록 변경.
- `SubagentRequest.depth` 제거 또는 diagnostic-only `assertedDepth`로 migration.
- run id, metadata, hooks에 grant lineage 사용.

### Phase 3 — convert every child producer

- foreground/6-tool/batch/CSV/workflow/background/delegate/reviewer/branch-search/side-agent 변환.
- caller-side `parentDepth + 1`, `depth:0`, hardcoded `depth:1` 제거.
- AST call-site fence 도입. 새 direct child `runAgent` 호출은 CI RED.

### Phase 4 — capability metadata + single projection

- required `Tool.agentEffect` 추가.
- spawn/manage/observe 분류 및 effective registry projection.
- builder-local spawn-depth gates 제거.
- `team_create`/`team_delete`는 coordination tool로 유지.
- Tool metadata ↔ `GATED_TOOLS` ↔ feature catalog parity hellgate.

### Phase 5 — persistence V2 + resume grant

- durable receipt-before-run ordering.
- V2 codec + corruption/unsafe-number/digest tests.
- `authorizeResume` + persisted depth preservation.
- V1 automatic resume fail-closed migration.

### Phase 6 — telemetry, catalog, cleanup

- projection/admission events와 low-cardinality metrics.
- 기존 `spawn-depth-policy.ts`, builder-local gate, duplicate default literal 제거.
- 신규 feature YAML 추가 금지. 기존
  `tools/feature-catalog/features/06-tier1/0150-subagent-spawn-depth-policy.yaml`을 migration 완료 상태로 수정.
- `bun fc validate`, `bun fc build`, `bun fc diff`, evidence check 실행.

---

## 10. Acceptance hellgates

### Authority

- root grant 없이 root kernel 호출 → compile/static gate RED.
- `depth: undefined`, `NaN`, `-1`, `0.5`, unsafe integer → typed deny; loop/worktree/task 미생성.
- forged `assertedDepth:0` from parent d2 → child d3; run id/meta/telemetry 모두 d3.
- authority throw injection → runner returns typed failure; rejected Promise 없음.
- grant reuse/double-run → `grant_reused` deny; 두 번째 loop/worktree/task 미생성.

### Complete path coverage

- source truth table의 모든 source가 authority event를 1회 발생.
- `branch_search` cap0 → candidate `runAgent` 0회.
- `subagent_fork` leaf config → tool absent; forced scheduler injection → runtime deny.
- internal `git_review_diff`/guardian spawn도 cap 적용.
- AST mutation: 새 direct descendant `runAgent` call 추가 → RED.

### Projection

- leaf에서 spawn capability tool 전부 부재.
- manage/observe/team/mailbox tool은 잔존.
- rename/namespace된 spawn tool도 capability metadata로 제거.
- spawn effect를 `none`으로 바꾸는 mutation → spawner-port/manifest parity RED.
- base registry와 feature tools 양쪽을 포함한 effective registry에서 검증.

### Policy

- default `1`; cap `0/1/2` truth table.
- 세 alias 중 단일 값은 동일 snapshot 생성.
- conflicting aliases → `policy_conflict`, silent precedence 없음.
- `/knobs set`으로 세 depth knob 변경 시 거부.
- per-call cap은 host cap을 절대 widen하지 못함.
- new child의 parent/child `policyId` 일치.
- resume은 `persistedPolicyId` 보존 + `effectivePolicyId`가 persisted/current 어느 쪽보다도 넓지 않음.

### Persistence / resume

- receipt write 실패 → child loop 미시작.
- d2 handle을 root에서 resume → d2 보존.
- persisted cap3 + current managed cap1 → resumed d2는 child spawn 불가.
- V1/missing/malformed lineage → automatic resume deny.
- tampered policy digest/depth → deny.

### Regression

- 기존 subagent/background/delegate/reviewer/branch-search/side-agent owner-local suites green.
- `side-agent-ipc-kill-mid-result-e2e` green.
- god-code ratchet green; 신규 함수 150줄 이하, 신규 module 1000줄 이하.
- typecheck, lint, focused unit/integration, feature-catalog validate/build/diff green.

---

## 11. Compatibility and risk

| Change | Compatibility | Risk |
|---|---|---|
| default `1` 유지 | 현재 main과 동일 | 낮음 |
| explicit root lineage | config/test fixture migration 필요 | 중 |
| direct `runAgent` entry split | call-site 다수, AST fence 필요 | 중~높음 |
| required tool effect metadata | Tool factories 전반 exhaustive annotation 필요 | 중~높음 |
| legacy knob conflict fail | conflicting production config는 startup failure | 중 |
| persistence V2 | legacy auto-resume 중단 | 중~높음 |
| telemetry | sink wiring/cardinality 검증 필요 | 낮음~중 |

전체 effort는 **M~L**이다. 순수함수 두 개짜리 S 작업이 아니다. 가장 큰 리스크는 root/descendant call-site
분류와 persistence migration이며, capability filter 자체가 아니다.

의도된 behavior changes:

- leaf에서 모든 실제 spawn-capability tool 제거.
- `team_create`/`team_delete`는 leaf에도 유지.
- cap0가 `branch_search` 같은 direct child producer에도 적용.
- legacy lineage-less handle은 자동 resume하지 않음.
- conflicting depth knobs는 조용히 한 값을 선택하지 않음.

---

## 12. Competitive evidence posture

- Claude Code `v2.1.172` [공식 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.172)는
  nested subagent를 최대 5단계까지 지원한다고 명시한다.
- capability absence, per-agent disallowed tools, resume-depth preservation의 정확한 구현 라인은
  `.extracted_source` snapshot과 공식 source/release를 함께 line-pin한 뒤 인용한다.
- Codex V1/V2의 `max_depth`, collab projection, runtime reject 차이는 버전별 source line이 없으면 확정 표현하지 않는다.
- Cursor prompt-only 평가는 구조적 보장 유무만 비교하며 내부 구현을 추정하지 않는다.

경쟁사 수치는 이 RFC의 correctness proof가 아니다. 이 RFC의 proof는 owner-local authority gates,
call-site completeness, persistence codec, mutation tests다.

---

## 13. Resolved decisions / remaining questions

### Resolved

- default는 현재 main과 같은 `1`.
- canonical semantics는 “생성 가능한 descendant의 최대 depth”.
- root는 explicit lineage.
- request depth는 authority 아님.
- name set 대신 runtime capability metadata.
- `team_create`는 spawn 아님.
- resume은 persisted lineage를 보존하는 별도 grant.
- grant는 private brand + nonce ledger 기반 single-consumer.
- policy는 session-pinned; `/knobs set` 대상 아님.
- 기존 feature YAML을 갱신하며 중복 feature를 만들지 않음.

### Remaining

- `rootSessionId`/`parentAgentId`의 기존 run/mailbox identity 중 무엇을 canonical lineage id로 재사용할지.
- lineage receipt durable write를 background JSONL store와 reviewer/branch-search ephemeral path에서 어떤 공통 port로 묶을지.
- legacy V1 handle의 explicit user-approved “restart as new task” UX를 어느 surface가 소유할지.
