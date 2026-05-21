# ADR-0042: agent_role enum (explorer/worker/none) + maestro nickname pool

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: Cluster E F16+F17, codex-subagent-tools, ADR-0041(6-tool standard), ADR-0019(four-surface edit)

## 맥락

Codex `codex-subagent-tools` 분석은 subagent 의도를 3개 role로 분류한다:

```
explorer  42%   read-only, wide-scope 탐색/조사
none      28%   no role; parent의 tool set 그대로 상속
worker    16%   mutating tool enable, narrow scope
                (나머지 ~14% other/experimental → none으로 collapse)
```

이 분류는 child registry가 받는 tool filter를 derive하는 데 쓰인다 —
explorer에게 `edit/shell/network/subagent` 노출 안 함, worker에게는
mutator 노출 + LSP/network/subagent 차단. role이 없으면 (`none`) parent
policy 그대로.

별개로 Codex는 child subagent에게 친근한 식별자 (nickname pool)를 부여 —
세션 로그/UI에서 `task_a3f8b921` 같은 UUID 대신 `Karajan` / `Mozart`
같은 39개 maestro 이름 중 하나가 등장. 가독성 ROI는 높지만 deterministic
seed → name 매핑이 반드시 필요 (replay reproducibility).

문제: (a) role enforcement는 in-flight `agent-tool.ts` 와이어업 필요 —
worktree minimum-touch 정책상 이번엔 contract + table만. (b) 39 nickname
은 closed set이며 collision 없는 deterministic 매핑이 SSOT.

## 결정

### Part 1 — `AgentRole` enum + tool-policy 표

`src/subagent/role.ts`:

- `AgentRole = "explorer" | "worker" | "none"`. `AGENT_ROLES` frozen
  array.
- `TOOL_KINDS = ["read","edit","shell","network","subagent","memory","lsp"]
  as const`. 신규 ToolKind 추가는 role table 동시 갱신 필수 (테스트가 빌드
  타이밍 enforce).
- `POLICY_TABLE: Record<AgentRole, { allowedToolKinds, deniedToolKinds }>`
  명시적 표:
  - **explorer**: allow `read/lsp/memory`, deny `edit/shell/network/
    subagent`.
  - **worker**: allow `read/edit/shell/memory`, deny `network/subagent/
    lsp` (worker는 좁은 surface, LSP는 explorer 영역).
  - **none**: 양쪽 empty (`[]/[]`) — host에게 "parent policy 상속"
    signal. heuristic 금지 — empty/empty 이외 형태로 inherit 신호 보내지
    않음.
- `getToolPolicyForRole(role)` — unknown role은 `UnknownAgentRoleError`
  throw (defensive runtime guard, schema 통과 후에도).
- `roleAllowsKind(role, kind)` — predicate. `none`은 모든 kind에 true
  (inherit semantics).

### Part 2 — 39 maestro nickname pool

`src/subagent/nicknames.ts`:

- `MAESTRO_NICKNAMES: readonly string[]` — frozen, 정확히 **39 entries**.
  15 conductors (Karajan, Bernstein, Solti, Toscanini, Furtwangler,
  Abbado, Muti, Mehta, Boulez, Rattle, Haitink, Levine, Ozawa, Barenboim,
  Klemperer) + 24 composers (Bach, Mozart, Beethoven, Brahms, Mahler,
  Chopin, Wagner, Verdi, Puccini, Schubert, Sibelius, Dvorak, Ravel,
  Debussy, Handel, Haydn, Strauss, Bizet, Berlioz, Liszt, Tchaikov,
  Stravinsk, Bartok, Rachman).
- 모든 entry: ASCII letters only, 길이 1..12. Import-time `validatePool()`
  가 invariant fail-fast.
- `assignNickname(seed: string | number) → string` — FNV-1a 32-bit hash
  → `% 39`. **deterministic**: 동일 seed (string or number) → 동일 name
  across processes/platforms. `Math.random()` 미사용 (단어로도 source에
  등장 안 함, 회귀 테스트 보장).
- `nextSequentialNickname(usedSet) → string | null` — pool 첫 미사용
  entry. **39개 모두 사용 시 `null`** (no fallback, no reuse) — Cluster
  E hard rule.

### Part 3 — 명시성 강제 (no-heuristic)

- `none` role의 빈 표가 "inherit" 외 다른 의미를 갖지 않음을 doc + 테스트로
  명시.
- nickname 39개 invariant (개수/중복/문자) violation 시 import-time
  throw — 향후 list 편집 시 회귀를 빌드 타이밍에 잡음.
- nickname 재사용 0 — 39 subagent 초과 시 host가 별도 정책 결정 (예: 일련
  번호 suffix) 해야 함. 자동 fallback 절대 없음.

## 근거

- 3 role / 39 nickname 모두 Codex 분포 + 자원 풀 그대로. 인지 부담 낮은
  closed set.
- empty/empty inherit signal: `null` policy 객체보다 type-safe —
  exactOptionalPropertyTypes 환경에서 optional 사용 회피.
- FNV-1a 32-bit: dependency-free, deterministic, < 200 byte source.
  `crypto.subtle.digest`는 async + Browser-only API surface 회피.

## 대안

- **role enum에 더 많은 분류 (researcher / planner / reviewer 등) 추가**:
  기각 — Codex 통계상 1% 미만 사용량. 3개로 충분.
- **`Math.random()` 기반 nickname 할당**: 기각 — non-determinism이 trace
  replay 불가능하게 만듦.
- **nickname pool을 외부 JSON 파일로**: 기각 — runtime 파일 의존이 추가
  되며, frozen ASCII list는 source에 상수로 두는 게 더 단순.
- **`none` role을 `null` (optional)** 로 표현: 기각 — TS exactOptional 환경
  에서 분기가 복잡. enum literal `"none"`이 더 명료.

## 결과·트레이드오프

- **얻은 것**: role-to-policy 표가 빌드 타이밍에 exhaustiveness 보장
  (`agent-role-policy.test.ts` 12 case). nickname pool invariants가
  import-time fail-fast. 17 nickname + 8 role tests all green.
- **비용**: role enforcement 실제 wiring은 follow-up — 이번엔 surface만.

## 한계 (LIMITATIONS)

- **(a) role 적용은 task-spawn 시점 wiring follow-up**: 본 ADR은 enum +
  policy 표까지. 실제 spawn 시 `getToolPolicyForRole(req.role)`을 호출하여
  child registry filter에 적용하는 와이어업은 in-flight
  `src/subagent/agent-tool.ts` 안정화 후.
- **(b) 39 nickname 초과 시 host 정책 미정의**: 본 ADR은 `null` 반환만
  명세. 일련 번호 suffix / pool 회전 / 다른 풀 추가 등은 호스트 결정.
- **(c) `none` role의 inherit signal이 empty/empty 컨벤션 의존**: 호스트가
  표를 직접 합쳐서 사용하는 게 아니라 `roleAllowsKind` helper로 query 해야
  함. 직접 사용 시 두 list 모두 empty 검사 필요.

## 불변식 영향

- **슬라이스 격리 유지**: `src/subagent/role.ts` / `nicknames.ts` 신규
  파일. 다른 슬라이스 import 0.
- **in-flight 파일 무수정**: `src/subagent/agent-tool.ts` 등 worktree
  수정 0.
- **RFC/ADR 동기**: ADR-0041 (6-tool)의 `spawn_agent` 입력에 role 필드
  추가는 follow-up — 현재 schema는 role 미포함, ADR 개정 시 추가 예정.
- **신규 npm dep 0**.
