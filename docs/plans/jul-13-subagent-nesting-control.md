# RFC: Sub-agent nesting control — lineage-derived depth admission

- **상태**: Draft design / implementation not started
- **날짜**: 2026-07-13 (rev.2 — 경쟁사 최신화 + authority/fail-closed 재설계)
- **범위**: 서브에이전트가 다시 서브에이전트를 스폰하는 것(네스팅)을 아키텍처적으로 통제.
  현재는 spawn surface마다 depth 배선이 제각각(일부 fail-open)이고, 권위(authority)가 caller가
  넘긴 숫자에 있다. 이걸 **lineage-derived depth + centralized admission + fail-closed**로 재정렬.
- **관련 코드 (HEAD 실측 2026-07-13)**:
  - 조립부: `src/agent/features.ts:208`(`buildSubagentBlock(config)`), `src/agent/tier1/subagent.ts`(agent trio + 6-tool + workflow + csv), `src/agent/tier1/subagent-batch.ts`(spawn_batch), `src/agent/tier1/delegate.ts`, `src/agent/tier1/team.ts`
  - depth: `src/agent/types.ts:418`(`AgentConfig.depth?: number`, 0=root)
  - child depth 세팅: `src/agent/subagent-runner.ts:637`(`buildChildConfig`), `:751`(`req.depth > maxDepth ⇒ deny`), `DEFAULT_MAX_DEPTH=3`
  - **HOLE 경로**: `src/agent/subagent-background.ts:300`(`depth:0` 하드코딩), `src/agent/subagent-runner/delegation-router.ts:89` + `src/host/runtime/agent-arg-builder.ts:427`(delegate `depth:0`)
  - **재사용 씨앗(anti-dup)**: `src/capability/{descriptor,resolve,registry}.ts`(ADR-0503 cross-surface exposure, `resolveExposure`), `src/agent/fork-session/lineage.ts`(`Map<sessionId,{parent,forkedAt}>` + cycle guard), `src/shared/runtime-config/parsers.ts:54`(`parseNonNegativeInt`, 0 허용)
- **증거 SSOT (경쟁사)**: `.extracted_source/{codex,claude-code-cli,cursor}/` (2026-07-13 재수집; Claude v2.1.172+, Codex 5059)

> **North-star 제약**: correctness > feature. (a) 휴리스틱 금지 — depth는 결정론적 lineage 파생값,
> "usually leaf"류 추정 금지. (b) Phase 0(lineage correctness)은 **선존 fail-open 버그 fix**라
> measure-first 예외. (c) Phase 4(정책 flip 3→1)는 기본동작 변경이라 별도 gated flip. (d) 재구현 금지 —
> `@/capability` 노출 패턴·fork-session lineage·runtime reject 재사용, 새 if-복붙 금지.

---

## 1. 문제

포크된 서브에이전트는 자기 agent loop를 돌며 bash/test/LSP + **또 다른 서브에이전트**를 스폰할 수 있다.
무제한 네스팅은 (a) fan-out 폭주(비용/토큰), (b) 조정 오버헤드, (c) 관측 불가능한 계보를 만든다.
사용자 의도: **서브에이전트는 leaf여야 한다**(root만 스폰, 자식은 못 깜). 단 휴리스틱이 아니라 아키텍처로.

핵심은 "leaf로 만들기"가 아니다 — 그건 이미 여러 제품이 한다(§3). 진짜 어려운 건 **권위(authority)를
어디에 두느냐**다. 현재 우리 시스템의 depth는 각 spawn 경로가 자기 request에 숫자를 넣어 넘기는
**caller-asserted 값**이고, 넣지 않으면 `?? 0`으로 root 취급된다. 이 fail-open 모델이 지금 두 홀(§2)의
공통 원인이고, 새 경로가 추가될 때마다 재발한다. 이 RFC의 논지:

> **Depth is lineage-derived, not caller-asserted. Unknown depth is denied, not defaulted to root.**

## 2. 현재 상태 (anti-dup, HEAD 실측)

**우리 = "런타임 depth reject" (capability는 자식이 다 받음):**
- 자식이 spawn 도구 패밀리(agent/spawn_agent/spawn_batch/spawn_agents_on_csv/team/delegate)를 **다 받는다**.
- `AgentConfig.depth`(0=root)가 배선돼 있고, `req.depth > maxDepth(=3) ⇒ denied`(`subagent-runner.ts:751`)로
  **호출 시점에** 거부. 모델이 도구를 보고 → 시도 → 튕김.

**🔴 fail-open 홀 2개 (딥어딧 발견, 공통 원인 = caller-asserted depth + `?? 0`):**
1. **background** (`subagent-background.ts:300-311`): `specToRequest`가 무조건 `depth: 0`. 주석은
   "host bridge가 upstream서 depth+1"이라는데 **그 bridge가 코드에 없다**. → 백그라운드 자식이 depth 0에서
   돈다. `req.depth > maxDepth` reject가 **영원히 미도달**(bg 재귀 무한 허용). default-OFF지만 배선 즉시 홀.
2. **delegate** (`delegation-router.ts:89`, `agent-arg-builder.ts:427`): 동일 `depth: 0` 하드코딩.
   delegate 전용 `MAX_DEPTH` 게이트도 `spec.depth ?? 0`이 항상 0이라 top-level만 인지.

**clean 경로:** foreground `agent`·6-tool·`spawn_batch`·`spawn_agents_on_csv`·`run_workflow`는 parentDepth+1을
자식 config.depth로 박음(`buildChildConfig:637`). — **단 이것도 caller-asserted다.** 지금은 맞게 넘기지만
권위 모델로는 background/delegate와 같은 등급이다(다음 경로가 틀리게 넘기면 똑같이 샌다).

## 3. SOTA 분석 (경쟁사 **최신** 메커니즘, corpus 실측)

> ⚠️ rev.1의 "capability-absence는 Claude 하나뿐 / 아무도 셋 다 결합 안 함 / 미개척 최초 조합" 주장은
> **stale corpus(Jul-3) 기반 오류였고 삭제**한다. 최신 기준으로 depth-bound capability-absence는 이미
> Claude·Codex 둘 다 갖고 있다.

| 축 | Claude Code (v2.1.172+) | Codex (V1) | Codex (MultiAgent V2) | Cursor |
|---|---|---|---|---|
| **numeric depth** | ✅ depth 계산, **depth 5**에서 Agent 툴 미제공 | ✅ `agents.max_depth`(default 1) | ⚠️ V1식 depth check **미확인**(`collab_tools_enabled()`가 V2엔 무조건 true) | ❌ |
| **depth-bound capability-absence** | ✅ depth 도달 시 Agent 툴 미제공 + per-agent `disallowedTools:[Agent]` | ✅ depth 초과 예상 시 collab 도구를 registry에 **아예 미등록** | ⚠️ 미확인 | ❌ |
| **runtime admission (typed reject)** | ✅ `subagent_recursive_fork`/`subagent_nested_teammate` | ✅ spawn handler가 우회/주입 시 재-reject | ? | ❌ |
| **resume가 depth 보존** | ✅ background agent를 root서 resume해도 최초 depth 유지 | (미확인) | (미확인) | ❌ |
| per-agent leaf 지정 | ✅ `tools`에서 Agent 제거 / `disallowedTools` | (전역 depth) | ? | 프롬프트 `d3` only |

**평결 (정직한 버전):** capability-absence + depth + runtime admission의 **조합은 이미 SOTA에 존재한다**
(Claude·Codex V1). 우리가 "최초"가 아니다. 단 두 제품 모두 **버전/모드별로 일관성이 갈린다** —
Codex V2 tool planning엔 V1의 depth check가 안 보이고, 우리 시스템은 §2처럼 경로마다 배선이 다르다.

> **우리의 차별점 = 권위 모델의 엄밀성(more rigorous correctness), 새 조합이 아니다.**
> 검증된 depth-bound capability projection과 runtime admission을, **우리 런타임의 모든 spawn surface에
> 하나의 함수로 일관 적용**하고 — 그 depth를 **caller가 아니라 lineage에서 파생**하고 — **unknown depth를
> root로 default 하지 않고 deny**한다. Claude/Codex가 "대개 leaf로 만든다"라면, 우리는 "위조·누락·
> 우회·resume 어느 경우에도 fail-closed"를 목표한다.

## 4. 설계 — 권위 계층 (authority layering)

rev.1의 "L1=capability-absence primary / L2=runtime belt-and-suspenders"는 **우선순위가 반대였다**.
background/delegate처럼 block-builder를 안 거치는 direct-runner 경로가 있으므로, 실제 권위는 반드시
런타임 admission이어야 한다. 도구를 안 보여주는 건 최적화지 보안 경계가 아니다.

```text
1. Runtime admission  ── authoritative safety boundary (모든 경로가 통과, 위조 불가)
2. Capability projection ── least-privilege / context 최적화 (도구 미노출 → 왕복·토큰 절감)
3. Prompt guidance    ── UX (모델에게 "너는 leaf" 안내)
4. Observability      ── 검증 (exposure↔admission 불변식 계측)
```

### 4.1 코어 — lineage 파생 depth + 단일 admission 함수

```ts
// src/agent/spawn-policy/lineage.ts (fork-session/lineage.ts 위에 depth 파생)
type AgentDepth = number        // 0 = root, child = parent+1
interface AgentLineage {
  readonly agentId: AgentId
  readonly parentAgentId: AgentId | null
  readonly depth: AgentDepth              // lineage 파생 (caller 미신뢰)
  readonly source: SpawnSource            // "foreground"|"background"|"delegate"|"batch"|"team"|"workflow"
  readonly policy: SpawnPolicySnapshot    // session-pinned (아래)
}
interface SpawnPolicySnapshot {           // root session서 1회 resolve, 모든 자식이 상속
  readonly maxDescendantDepth: number     // 생성 가능한 자식의 최대 depth. 1 = root-only. 0 = kill switch.
  readonly version: string
}
```

```ts
// 단일 admission — 모든 spawn 경로가 이 함수 아래로 모임
type SpawnDenied =
  | { code: "SPAWN_DEPTH_LIMIT"; parentDepth: number; childDepth: number
      maxDescendantDepth: number; source: SpawnSource; policyVersion: string }
  | { code: "SPAWN_LINEAGE_INVALID"; parentAgentId: string | null; reason: string }

type SpawnAdmission =
  | { allowed: true; childLineage: AgentLineage }
  | { allowed: false; error: SpawnDenied }

export const authorizeSpawn = (parent: AgentLineage, source: SpawnSource): SpawnAdmission => {
  // fail-closed: parent depth가 finite-nonneg-int이 아니면 lineage invalid
  if (!Number.isInteger(parent.depth) || parent.depth < 0)
    return { allowed: false, error: { code: "SPAWN_LINEAGE_INVALID",
      parentAgentId: parent.agentId, reason: `non-integer/negative parent depth ${parent.depth}` } }
  const childDepth = parent.depth + 1                       // checkedIncrement
  if (childDepth > parent.policy.maxDescendantDepth)
    return { allowed: false, error: { code: "SPAWN_DEPTH_LIMIT",
      parentDepth: parent.depth, childDepth, maxDescendantDepth: parent.policy.maxDescendantDepth,
      source, policyVersion: parent.policy.version } }
  return { allowed: true, childLineage: {
    agentId: /* minted */, parentAgentId: parent.agentId, depth: childDepth, source, policy: parent.policy } }
}
```

**불변식 (fail-closed):**
- `authorizeSpawn`은 `parent.depth`가 정수·비음수일 때만 허용. `undefined`/`NaN`/음수/소수 → `SPAWN_LINEAGE_INVALID` deny.
- **undefined → root(0) 변환 금지.** root는 오직 **root session 생성 시점**에만 명시적으로 `depth:0`.
- child depth는 항상 parent lineage에서 `+1` 파생 — caller/tool payload/adapter가 넘긴 숫자 미신뢰
  (Bash·IPC·CLI·구 adapter·강제 tool injection이 `depth:0`을 위조 가능).

### 4.2 두 파생 술어 (off-by-one 제거)

rev.1의 `maxSpawnDepth`("스폰 도구 받는 max depth, 1=root-only")는 **의미 모순**이었다 — root-only면
스폰 도구 받는 max depth는 0이다. 정책값은 "생성 가능한 자식의 최대 depth"로 명명·정의:

```ts
// exposure(L2)와 admission(L1)이 같은 policy에서 파생되는 두 술어
canExposeSpawnTools(parentDepth, maxDescendantDepth) = parentDepth < maxDescendantDepth
canAdmitChildDepth(childDepth,  maxDescendantDepth) = childDepth  <= maxDescendantDepth
```

| cap | parent depth | spawn 도구 노출 | 생성될 child depth | admission |
|---|---|---|---|---|
| 1 | 0 (root) | O | 1 | O |
| 1 | 1 | X | 2 | X |
| 2 | 1 | O | 2 | O |
| 0 | 0 | X | 1 | X (kill switch) |

두 술어는 **정적 정책에서 항상 정합**해야 한다(§4.4 불변식). cap=0은 전면 kill switch로 지원 —
`parseNonNegativeInt`(0 허용, 이미 존재)로 파싱하고 finite/integer/bounded 검증.

### 4.3 Capability projection — `@/capability` 재사용 + spawn/manage/observe 분리

rev.1은 4개 builder에 `if (!spawnToolsAvailable) return []`를 복붙했다 — 새 spawn 도구(`spawn_map` 등)가
추가되면 게이트를 빼먹는다. 대신 **capability tag + 중앙 필터**. `@/capability`(ADR-0503 `resolveExposure`)가
이미 cross-surface exposure를 tag 기반으로 한다 — 단 그건 **env-static per-surface boolean**이라 그대로는
못 쓴다(depth는 per-agent-instance). 정직한 재사용: **패턴/registry는 재사용, depth 입력을 받는 sibling
projection을 추가**.

```ts
type SpawnCapability = "agent.spawn" | "agent.manage" | "agent.observe"
// tool descriptor에 태그 (기존 @/capability descriptor 확장)
//   agent, spawn_agent, spawn_batch, spawn_agents_on_csv, run_workflow, delegate, team_create → "agent.spawn"
//   team_delete, wait, list, close                                                            → "agent.manage"
//   introspect, status                                                                        → "agent.observe"
const projectSpawnTools = (tools: Tool[], lineage: AgentLineage): Tool[] =>
  tools.filter(t => t.spawnCapability === "agent.spawn"
    ? canExposeSpawnTools(lineage.depth, lineage.policy.maxDescendantDepth)
    : true)   // manage/observe는 생성 권한과 별개 — leaf도 자기 팀/상태는 관리·관측
```

**중요:** `team_create`(생성)와 `team_delete`/`wait`/`list`/`close`(관리·관측)는 다른 capability다. rev.1처럼
team/delegate 블록을 통째로 제거하면 leaf가 자기 하위 상태를 못 보는 부작용. **생성 권한만** 제거.

### 4.4 관측성 — 필수(옵션 아님)

이번 홀 2개를 발견한 이유 자체가 lineage가 관측 불가였기 때문. admission과 **함께** 최소 telemetry 탑재:

각 spawn 시도 기록: `parentAgentId, childAgentId, parentDepth, childDepth, source, maxDescendantDepth,
policyVersion, toolExposed, decision, denialCode`.

**핵심 불변식 계측:** `toolExposed === true && deniedByDepth === true` → production normal path에서 **0**
이어야 함(정적 정책이면 exposure와 admission이 정합하므로). 강제 injection 테스트에서만 의도적으로 발생.
전체 SubAgentSource UI는 backlog여도, 이 lineage/depth/admission telemetry는 필수.

### 4.5 session-pinned policy (SSOT 진짜 하나)

rev.1의 `opts.maxDepth ?? spawnDepthCap()`은 exposure와 runtime이 **다른 값**을 쓸 수 있었다(exposure는
config, runtime은 opts 우선 → root-only 선언인데 direct-runner는 3단 허용). 대신 **root session 생성 시
`SpawnPolicySnapshot`를 1회 resolve**하고 모든 자식이 상속. 실행 중 env/config 변경이 기존 agent 권한을
바꾸면 안 됨. exposure·admission 둘 다 `lineage.policy.maxDescendantDepth` 한 곳만 읽음.

### 4.6 resume / persistence 불변식

Claude도 "resume해도 최초 depth 유지"를 명시(§3). nesting control의 핵심 불변식:

```text
root(d0) └─ A(d1) └─ B(d2, background)
root 화면에서 B를 resume해도 B.depth === 2 (재계산으로 1/0 금지)
```

시나리오별 정책(모두 **fail-closed**):
- persisted agent에 depth 없음 → lineage로 재구성 가능하면 재구성+검증, 불가면 **spawn capability deny**.
- parent 있으나 depth 불일치 → lineage 우선 재구성, 불일치 지속 시 deny.
- parent 삭제됨 / 다른 agent가 이어받음(delegate handoff) → lineage 끊기면 deny.
- 구 policy(cap=3)서 만든 child를 cap=1 환경서 resume → **그 자식은 더 못 스폰**(현 policy admission 적용),
  단 자기 depth 값은 보존.
- **절대 depth=0 fallback 금지.**

## 5. 왜 이게 SOTA-grade 인가 (정직한 근거)

- "새 조합"이 아니다 — capability-absence+depth+admission은 Claude·Codex에 이미 존재(§3).
- **더 엄밀한 correctness architecture**라는 근거: (1) depth가 caller가 아니라 lineage 파생, (2) unknown
  depth fail-closed(root default 금지), (3) 모든 spawn surface가 단일 `authorizeSpawn` 통과(경로별 배선
  drift 불가), (4) session-pinned policy(mid-run 권한 변동 불가), (5) resume/persistence 불변식 명시,
  (6) exposure↔admission 불변식 계측. 경쟁 제품이 버전/모드별로 갈리는 지점(Codex V2, 우리 §2)을
  구조적으로 봉인.

## 6. Phase / 순서 (안전한 재배열)

rev.1 순서(P0 depth fix → P1 cap=1 capability 제거 → P2 runtime 정렬)는 **P1만 배포된 중간 상태가
위험**했다: 일반 builder 경로는 자식 도구 제거하는데 background/delegate direct-runner는 기존
runtime maxDepth=3까지 허용 → "root-only 선언인데 일부 경로 3단 허용". 수정 순서:

```text
Phase 0 — Lineage correctness (fail-closed)                      [correctness, measure-first 예외]
   · unknown/missing depth → deny (undefined→root 제거)
   · background/delegate/resume/persisted lineage 정정 → 단일 파생
Phase 1 — Central admission (동작 변화 0)                        [refactor, byte-identical]
   · authorizeSpawn 도입, 기존 cap=3 그대로 → 모든 경로를 이 함수로 통합
   · typed SpawnDenied + zero-side-effect 보장
Phase 2 — Capability projection (@/capability 재사용)            [least-privilege]
   · spawn-capability tag + 중앙 필터로 spawn 도구 미노출
   · exposure ↔ admission 불변식 비교 (mismatch 0)
Phase 3 — Observability / shadow                                 [필수]
   · source·parent·depth·cap·decision·denialCode 기록, mismatch 0 확인
Phase 4 — Default policy flip 3 → 1                              [gated behavior change]
   · maxDescendantDepth 기본 3 → 1 (root-only). 손자-의존 0 확인 후.
```

- **P1과 P2는 원자 배포 가능하면 합쳐도 됨**(중간 상태 없음). rev.1처럼 "P1 후 P2 순차"는 금지.
- Phase 0은 선존 fail-open fix → measure-first 예외(red-on-injection).
- Phase 4만 실제 동작 변경(3단→1단). 그 전까지 전부 byte-identical(cap=3 유지).

## 6.5 상세 설계 — config · 모듈 · 작업 워크플로 (HEAD 시그니처 실측)

### A. Config 설계
정책값 = `maxDescendantDepth`(생성 가능한 자식 최대 depth). session-pinned snapshot의 소스.

```ts
// src/shared/runtime-config.ts — parseCapabilitySlice (parseNonNegativeInt: 0 허용 = kill switch)
maxDescendantDepth: parseNonNegativeInt(env["QUANTA_MAX_DESCENDANT_DEPTH"], "QUANTA_MAX_DESCENDANT_DEPTH") ?? 3,
// src/shared/runtime-config/types.ts
readonly maxDescendantDepth: number   // 생성 가능한 자식의 최대 depth. 1=root-only, 0=kill switch. default 3(Phase4서 1).
// src/shared/runtime-config-knobs/knobs-a.ts (inventory, group:"tool")
{ envKey: "QUANTA_MAX_DESCENDANT_DEPTH", kind: "int", default: 3,
  describe: "Max descendant agent depth (children a spawn may create). 1 = root-only, 0 = no spawning." }
```
- **default 3까지 Phase 0-3 (byte-identical)**, Phase 4서 정책 결정으로 1 flip. 이 knob은 숫자 정책이라
  bool-default-off 가드 대상 아님 → 전용 핀(default 값 + 0/1/2 진리표 + fail-closed 파싱).
- fc: `tools/feature-catalog/features/06-tier1/`에 feature YAML.

### B. 모듈 설계

**신규** `src/agent/spawn-policy/` (@/agent — block builder + runner + resume 공유):
- `lineage.ts` — `AgentLineage`/`SpawnPolicySnapshot`/`SpawnSource` 타입 + `deriveChildDepth(parent)`
  (fork-session/lineage.ts의 parent-chain 위에 depth 파생). fail-closed 검증 포함.
- `admission.ts` — `authorizeSpawn(parent, source): SpawnAdmission`(§4.1). 순수 함수.
- `projection.ts` — `projectSpawnTools(tools, lineage)`(§4.3, @/capability tag 필터).
- `denial-render.ts` — `SpawnDenied → {model, user}` 메시지 renderer(§4.1 typed→string 분리).
- `snapshot.ts` — root session서 `SpawnPolicySnapshot` 1회 resolve(runtimeConfig → pin).

**Phase 0 — depth 전파 정정 + fail-closed** (2 홀):
```ts
// subagent-background.ts:298  specToRequest — parentDepth를 lineage서 받고 미주입시 deny
- export const specToRequest = (spec, signal): SubagentRequest => ({ prompt: spec.task, depth: 0, ... })
+ export const specToRequest = (spec, signal, parent: AgentLineage): SubagentRequest =>
+   ({ prompt: spec.task, lineage: authorizeSpawn(parent, "background") /* deny면 스폰 자체 차단 */, ... })
// subagent-typed/delegation-router.ts:85  wrapSubagentRunner — 동일
- export const wrapSubagentRunner = (runner) => ... ({ depth: 0, ... })
+ export const wrapSubagentRunner = (runner, parent: AgentLineage) => ... admission 통과분만 실행
```

**Phase 1 — central admission** (subagent-runner.ts:751, 동작 불변):
```ts
- const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH   // caller가 opts로 우회 가능
- if (req.depth > maxDepth) return { ok:false, finalText:"max subagent depth exceeded", turns:0 }
+ const admission = authorizeSpawn(req.parentLineage, req.source)  // session-pinned policy 사용
+ if (!admission.allowed) return denyResult(admission.error)       // typed → renderer
//   cap은 lineage.policy(=snapshot)에서만. opts.maxDepth 우회 제거. cap=3 유지라 동작 byte-identical.
```

**Phase 2 — capability projection** (블록 빌더 — 복붙 대신 중앙 필터):
```ts
// features.ts 조립 최종단에서 1회 필터 (각 builder에 if 복붙 X)
  const assembled = [...subagentBlock, ...batchBlock, ...teamBlock, ...delegateBlock, ...]
+ return projectSpawnTools(assembled, thisLineage)   // agent.spawn 태그만 depth 게이트
```

### C. 작업 워크플로 (Phase별 hellgate 순서)

```text
Phase 0 ─ P0-a fail-closed 파생: deriveChildDepth + authorizeSpawn 코어 [단위: undefined/NaN/음수/소수→deny 진리표]
        ─ P0-b background 정정 (specToRequest가 lineage 받음)          [hellgate: bg 자식 depth===parent+1, 미주입→deny(RED)]
        ─ P0-c delegate 정정 (wrapSubagentRunner/arg-builder)          [hellgate: delegate 자식 depth===parent+1]
        ─ P0-d resume 불변식 (persisted depth 보존, 없으면 deny)        [hellgate: resume 후 depth 불변, depth-less→deny]
Phase 1 ─ P1-a authorizeSpawn을 subagent-runner에 배선(cap=3 유지)      [hellgate: 전 경로 admission 통과, 동작 byte-identical]
        ─ P1-b typed SpawnDenied + renderer                            [단위: code 검증(문자열 아님)]
        ─ P1-c runtime-config maxDescendantDepth 필드+inventory+fc      [핀: default===3, parseNonNegativeInt 0허용]
Phase 2 ─ P2-a spawn-capability 태그(@/capability descriptor 확장)      [단위: 태그 분류 spawn/manage/observe]
        ─ P2-b projectSpawnTools 중앙 필터 배선                          [hellgate: depth≥cap→spawn 부재/manage 존재, exposure↔admission 정합]
Phase 3 ─ P3-a lineage/admission telemetry (필수)                       [hellgate: 불변식 mismatch===0, injection시 계측]
Phase 4 ─ P4-a default 3→1 flip                                        [gated: 손자-의존 0 확인 후, red-on-flip]
```

각 Phase = hellgate(RED e2e → 구현 → 적대어딧≥3R → 셀프어딧). 순서 하드:
- **P0(fail-closed) 없이 이후 금지** — caller-asserted depth 남으면 admission이 위조당함.
- **P2가 P1 뒤** — admission(권위)이 먼저, projection(최적화)은 그 위 read-only. P1·P2 원자배포면 합침 OK.
- **P4는 맨 끝** — 그 전까지 cap=3 byte-identical, flip만 별도 gated.

### D. 영향 표면 / 회귀
- 신규: `spawn-policy/{lineage,admission,projection,denial-render,snapshot}.ts`.
- 변경: `subagent-background.ts`·`subagent-typed/delegation-router.ts`·`agent-arg-builder.ts`(lineage 파생),
  `subagent-runner.ts`(central admission), `features.ts`(projection 1지점), `capability/descriptor.ts`(spawn 태그),
  `runtime-config{,/types,-knobs/knobs-a}.ts`(knob), fc YAML.
- **불변(Phase 0-3)**: cap=3 유지라 실제 스폰 동작 byte-identical. root 도구셋도 불변(cap>0이면 root 노출).
  Phase 4 flip에서만 3단→1단 동작 변경.
- 손자-의존 워크플로 **0 확인**(grep clean) → Phase 4 회귀 위험 낮음.

## 7. Acceptance (hellgate)

- **Phase 0**: `authorizeSpawn` 진리표 — `undefined`/`NaN`/`-1`/`0.5` parent depth → `SPAWN_LINEAGE_INVALID`
  (RED 없으면 fail). background/delegate 자식 `depth===parent+1`; lineage 미주입 mutation → deny(RED).
  resume 후 depth 보존; depth-less persisted → spawn deny.
- **Phase 1**: 전 경로가 `authorizeSpawn` 통과, cap=3 동작 byte-identical(기존 스위트 green). deny는
  **code**(`SPAWN_DEPTH_LIMIT`)로 검증(문자열 매칭 금지). `opts.maxDepth` 우회 제거 핀.
- **Phase 2**: depth≥cap 자식 tool 리스트에 `agent.spawn` 태그 부재, `agent.manage`/`observe` 존재.
  exposure↔admission 정합(둘 다 lineage.policy 참조). 태그 누락한 새 도구가 게이트 우회 못 함(중앙 필터).
- **Phase 3**: `toolExposed && deniedByDepth` production normal → 0; 강제 injection 테스트 → 1(계측 증명).
- **Phase 4**: default 1 flip 후 자식(depth1) 스폰 시도 → deny; flip 되돌리는 mutation → RED.
- 회귀: 기존 subagent 스위트 + `side-agent-ipc-kill-mid-result-e2e` green. (선존 `features.ts` init-cycle
  fail은 무관 — 분기점서도 재현.)

## 8. effort / risk

- Phase 0: **M** (lineage 파생 + fail-closed + resume 불변식). 위험 낮음(선존 fix, red-on-injection).
- Phase 1: **M** (central admission refactor, 전 경로 통합). 위험 낮음(cap=3 byte-identical).
- Phase 2: **S** (@/capability 태그 + 중앙 필터). Phase 3: **S** (telemetry, 필수). Phase 4: **XS** (flip).

## 9. 기각한 방향
- **"미개척 최초 조합" 서사 (rev.1)**: stale corpus 오류. Claude·Codex 이미 조합 보유. 차별점은 엄밀성으로 재정의.
- **caller-asserted depth 유지 + 홀 2개만 패치 (rev.1)**: 배선 버그엔 대응하나 권위 모델이 약함 —
  다음 경로가 또 틀리게 넘김. lineage 파생으로 대체.
- **`depth ?? 0` fail-open**: 홀의 공통 원인. undefined→root 금지, fail-closed로 대체.
- **capability-absence를 primary로 (rev.1)**: direct-runner 경로가 우회 → 권위는 runtime admission. projection은 최적화.
- **4 builder에 if 복붙 (rev.1)**: 새 spawn 도구가 게이트 누락. capability tag + 중앙 필터로 대체.
- **stringly-typed reject (rev.1)**: `finalText:"..."` → discriminated `SpawnDenied` + renderer. acceptance는 code 검증.
- **관측성을 Phase 3 옵션으로 (rev.1)**: 홀 발견 자체가 lineage 불투명 때문. admission과 동반 필수.
- **Cursor식 프롬프트-only**: 모델이 무시 가능. 구조 보장 없음. 기각.
