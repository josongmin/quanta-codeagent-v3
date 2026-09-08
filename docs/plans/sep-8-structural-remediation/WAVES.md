# Sep-08 — disjoint write-set wave plan

상태: **분할 계획은 유지. W1·W2·W3는 local `main`에 통합됨. W7 verified 아님.**

- 구조·근거: [README](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/README.md), [ACTIONS](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/ACTIONS.md).
- 실행 배정의 machine-readable 원본: [waves.json](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/waves.json).
- 검사기: [verify-waves.mjs](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/verify-waves.mjs).
- Plan baseline HEAD: `f5f4875799141068af73e604129c8b9a09f76007`.
- Integrated source (W1+W2, W3 착수): `19fc9da2b` on local `main`. W3 land: `742d61d0`. `waves.json` `sourceHead`는 W3 land SHA.
- audit digest는 manifest에 고정한다. `docs/bugbash/sep-8-se-audit/`는 baseline 입력이지 구현 closeout이 아니다.

## 1. 전체 배정 — 39 finding / 16 package / 172 action

기존 R01–R16을 유지한다. finding을 여러 그룹으로 쪼개거나 임의의 미분류 잔여 작업을 만들지 않는다.

| Wave | A | B | C | Finding | 액션 |
|---|---|---|---|---:|---:|
| W0 | Integrator: baseline·scope·선행 계약 | — | — | 0 | 8 |
| W1 | R01 security/redaction | R04 patch/rollback | R09 pricing/report | 6 | 24 |
| W2 | R05 side-agent | R13 benchmark family | R11 MCP | 5 | 20 |
| W3 | R14 remote CLI | R02 file transactions | R12 session protocol | 10 | 40 |
| W4 | R03 session/memory persistence | R06 scheduler recovery | R10 search/embedding | 7 | 28 |
| W5 | R07 cancellation | R08 LSP cache/waiter | R15 boot/config truth | 8 | 32 |
| W6 | R16 skill authority/fallback | — | — | 3 | 12 |
| W7 | Integrator: final compatibility·gates·closeout | — | — | 0 | 8 |
| **합계** | **16개 package, 각 1회** | | | **39** | **172** |

P1은 W1의 보안/파일 무결성/비용, W2의 process/MCP/bench, W3의 remote wiring 순서다. W3-I에서는 R14를 먼저 통합한다. 기존의 “아무 때나 R14 조기 착수” 예외는 제거한다. 앞당기려면 manifest wave 배정을 먼저 바꾸고 disjoint/dependency 검사를 다시 통과해야 한다.

## 2. Disjoint의 정확한 의미

각 병렬 그룹 `g`에 대해:

```text
Declared(g) = sourceScopes ∪ existingTests ∪ newTestScopes ∪ artifactScope
WriteSet(g) = Declared(g) − IntegratorReserved

같은 Wn-P의 서로 다른 g, h:
  WriteSet(g) ∩ WriteSet(h) = ∅

Wn-P 동안 integrator 제품 write set = ∅
Wn-I 동안 worker 제품 write set = ∅
```

- 이 disjoint는 **쓰기 권한**이다. 공통 source/API를 읽거나 의존하는 것은 허용한다. 의존성이나 semantic conflict까지 수학적으로 없다는 뜻은 아니다.
- 파일 소유권만 분리하지 않는다. 기존 test 파일, 새 test 디렉터리, fixture, receipt도 분리한다.
- prefix scope는 같은 owner의 cohesive extraction을 허용하는 상한이지, 하위 모든 파일을 refactor하라는 허가가 아니다. 해당 finding의 reachable 경로만 수정한다.
- scope는 trailing `/`이면 subtree, 아니면 정확한 파일이다. glob/`..`/절대경로 scope는 사용하지 않는다.
- 미래에 만들 파일도 prefix overlap 검사 대상이다. 현재 파일 목록만 비교해 “아직 파일이 없으니 disjoint”라고 하지 않는다.
- manifest에 없는 새 파일은 worker가 만들지 않는다. 먼저 integrator가 scope를 변경하고 검사 후 새 snapshot을 배포한다.

### 공통 파일은 병렬 집합에서 제외

manifest `reservedScopes`/`reservedBasenames`에 고정한다. 주요 대상은 다음과 같다.

- 모든 `index.ts` — public barrel과 app entrypoint를 보수적으로 함께 예약한다. 따라서 eval entrypoint 변경도 R15 worker가 아니라 W5-I가 적용한다.
- `src/shared/`, `src/host/`, CLI index/internal/repl 및 repl 하위 공통 배선.
- agent entrypoint, web authority/runtime/ws handlers, MCP host/agent/plugin construction.
- apply-patch tool projection, session autosave/session-ops/SDK runtime, kernel persisted-event replay 배선.
- shared test fixtures/helpers/architecture config, `tools/`, package/lockfile/tsconfig/Biome, feature catalog와 generated MD.

모든 reserved 파일을 매 wave 수정하는 것은 아니다. integrator는 그 wave package의 필요한 `integrationScopes`, 해당 source scope의 barrel, 관련 공통 gate만 수정한다. 같은 root를 두 package가 필요로 하면 I 단계에서 순서대로 한 사람이 적용한다.

## 3. 단계와 barrier

```text
W0
 ↓
W1-P [R01 ∥ R04 ∥ R09] → W1-I [R01 → R04 → R09]
 ↓
W2-P [R05 ∥ R13 ∥ R11] → W2-I [R05 → R13 → R11]
 ↓
W3-P [R14 ∥ R02 ∥ R12] → W3-I [R14 → R02 → R12]
 ↓
W4-P [R03 ∥ R06 ∥ R10] → W4-I [R03 → R06 → R10]
 ↓
W5-P [R07 ∥ R08 ∥ R15] → W5-I [R07 → R08 → R15]
 ↓
W6-P [R16]           → W6-I [R16]
 ↓
W7 final closeout
```

### Wn-P: 최대 3명, owner-local 구현

1. 직전 I 단계가 고정한 source snapshot과 동일한 audit/계획 snapshot에서 시작한다. 가능하면 각각의 worktree를 사용한다. 이 문서 작성 자체가 worktree/branch 생성 명령은 아니다.
2. 각 package의 baseline RED → owner 구현 → local tests/mutation → 필요한 integration delta 제안을 수행한다.
3. workers는 본인 `work/Rxx/`에만 handoff/receipt를 쓴다. 공용 README/ACTIONS/WAVES/manifest를 수정하지 않는다.
4. reserved root 변경이 필요하면 본인 artifact 디렉터리에 **미적용 integration delta**를 제출한다. 실제 root를 미리 수정하지 않는다.
5. integrator는 read-only 검토/충돌 확인만 한다. worker와 동시에 source/manifest/공용 receipt를 고치지 않는다.

### Wn-I: worker write 정지 후 단일 integrator

1. 세 worker의 write를 멈추고 changed-path allowlist와 diff를 검사한다. 미선언 수정이 있으면 해당 handoff를 되돌려 scope를 조정한다. 사용자 변경을 자동 폐기하지 않는다.
2. manifest의 `integrationOrder` 순서로 owner diff와 root/public export/common dependency 변경을 통합한다.
3. actual producer→consumer, cross-group interface, 타입/경계/회귀 테스트를 **통합된 source**에서 다시 확인한다. worker-local PASS는 최종 PASS가 아니다.
4. coordinator는 workers에 read-only 테스트 실행을 맡길 수 있으나 이 단계의 코드 수정자는 한 명이다. 재수정이 필요하면 I를 멈추고 명시적으로 새 P 회차를 연다.
5. ACTIONS 체크 상태와 source/receipt snapshot을 갱신하고 다음 wave를 연다. 이전 wave의 unresolved integration을 다음 wave에 몰래 넘기지 않는다.

W0의 lock/platform/legacy writer 검토 결과가 R02 착수를 허용하지 못하면 R02의 lock-dependent 액션만 blocked로 남긴다. 같은 W3-P의 R14/R12 및 R02의 독립 validation은 진행할 수 있지만 **W3 전체 완료 또는 W4 개방은 하지 않는다**. 더 넓은 재배치가 필요하면 명시적으로 DAG를 바꾼다.

## 4. 그룹별 배정과 충돌 회피 근거

각 finding의 `.1`–`.4` 액션은 표시한 package에 전부 귀속된다. 구체적인 코드 근거/테스트 기대값은 ACTIONS에서 유지한다. 아래 owner 경계의 정확한 파일·prefix·기존 테스트 목록은 manifest가 원본이다.

### W0 — Serial preflight

- 액션: `W0.1`–`W0.8` 전부. snapshot, exact write set, lock/platform/legacy migration, MCP readiness, pricing/embedding identity, god-code census, baseline RED.
- 제품 구현 완료와 구분한다. 선행 조사에서 미해결된 결정은 영향을 받는 package의 착수 조건으로 기록한다.
- lock adapter의 최종 위치가 정해지면 W3 이전에 R02 또는 W3-I의 reserved scope로 등록한다. 현재 미정인 위치를 worker가 임의 선택해 새 slice를 만들지 않는다.

### W1 — Security / patch / pricing

| Lane | Finding IDs | 병렬 source owner | I 단계 배선 |
|---|---|---|---|
| W1-A / R01 | F-07, SEP7-D-11 | security + stdout renderer | 필요한 shared/barrel 변경만 |
| W1-B / R04 | H-PATCH-01, H-PATCH-02 | patch parser/converter/applier/formatter | apply-patch tool의 typed error/result projection |
| W1-C / R09 | P1-A-02, G-F15 | usage-accounting + ledger/usage sink/stop + eval report | 필요한 public type/export 변경 |

R01의 source sensitivity, R04의 patch operation, R09의 가격 provenance는 서로 다른 결정권자다. `src/tool/apply-patch.ts`는 W1-B worker write set에서 제외해 tool consumer 확장이 다른 security wiring과 경합하지 않게 한다.

**구현 상태:** W1-P/I는 local `main` `29d7e4ff1`에 통합됨. G-F15 `costUsd:null`·F-07 follow-up unwrap·H-PATCH-02 tool-result rail도 같은 HEAD. W7 verified 아님.

### W2 — Side-agent / bench / MCP

| Lane | Finding IDs | 병렬 source owner | I 단계 배선 |
|---|---|---|---|
| W2-A / R05 | H-SA-02, H-SA-01 | side-agent control/IPC/worker | host agent-config assembler |
| W2-B / R13 | G-F5 | bench box-session/profile/warm selection | 필요한 profile/barrel 변경 |
| W2-C / R11 | C-F1, C-F9 | MCP core/transports + plugin-isolation | host/agent/skill/plugin MCP constructors + feature YAML/build |

R05와 R11은 모두 child process를 다루지만 공통 process helper를 병렬로 추출하지 않는다. side-agent는 charter/wake lifecycle, MCP는 carrier/RPC/session lifecycle을 소유한다. host 변경은 W2-I에 예약한다.

**구현 상태:** W2-P/I는 같은 `29d7e4ff1`에 통합됨. G-F5.4 실제 EC2 proof는 열린 갭.

### W3 — Remote / transactions / session protocol

| Lane | Finding IDs | 병렬 source owner | I 단계 배선 |
|---|---|---|---|
| W3-A / R14 | G-F9 | remote runner + CLI remote command/dependencies | CLI index; I 단계 첫 통합 |
| W3-B / R02 | F-03, F-04, F-09, F-10, F-12, F-13, F-11 | auth file CAS/atomic, permission file state, migration persist/ledger, pure trust-store | agent/CLI/web persistence roots + 검증된 dependency |
| W3-C / R12 | C-F2, C-F11 | protocol/session + IPC/session + SDK handle adapter | kernel event-log replay projection + public barrels |

auth transaction과 session protocol은 다른 schema/owner다. 공통 root가 필요한 부분은 모두 제외한다. session event validator는 R12가 소유하며 다른 그룹이 별도 validator를 추가하지 않는다.

### W4 — Persistence / scheduler / search

| Lane | Finding IDs | 병렬 source owner | I 단계 배선 |
|---|---|---|---|
| W4-A / R03 | SEP7-D-05, SEP7-D-06, SEP7-D-07, SEP7-D-10 | session store/index, SDK snapshot rehydrate, memory SQLite update | autosave/session-ops/SDK runtime |
| W4-B / R06 | G-F4 | scheduler engine/ticker/adapter | CLI/host ticker composition |
| W4-C / R10 | E-SEARCH-01, E-EMBED-01 | retrieval + runner search backend/pipeline | host mention-symbol consumer |

R03과 R10이 모두 embedding을 다뤄도 수정 목적은 다르다. R03은 memory SQLite의 raw BLOB 보존, R10은 retrieval index/query 공간 계약이다. 공통 storage abstraction을 이 wave에서 새로 합치지 않는다. R06의 claimToken도 filesystem lock과 합치지 않는다.

### W5 — Cancellation / LSP / boot configuration

| Lane | Finding IDs | 병렬 source owner | I 단계 배선 |
|---|---|---|---|
| W5-A / R07 | G-F12, F-08 | OAuth callback/browser flow + web user-input port | ws/host turn abort wiring |
| W5-B / R08 | P2-A-02, P2-A-05, C-F12 | agent LSP/shadow adapters + diagnostics hub | 필요한 public exports |
| W5-C / R15 | E-PROV-01, G-F6, E-KNOB-01 | runner LLM selector + status/doctor + 두 knob parser | CLI internal/index, eval index, shared env helper |

R07의 OAuth files는 W3 R02가 사용한 file-store owner와 분리되어 있다. R08과 R15는 agent/runner 간 공유 interface를 읽을 수 있지만 서로의 files를 수정하지 않는다. `src/shared/env-files.ts`/`env-flag.ts`는 W5-I에서만 수정한다.

### W6 — Authority inputs / degradation

- W6-A / R16: `G-F11`, `G-F8`, `G-F13`의 12개 액션 전부.
- worker는 skill authority leaf/contracts/tests를 맡는다. CLI session-setup/repl, web authority, agent preset 경고 배선은 W6-I가 적용한다.
- 한 package이므로 B/C 슬롯을 임의의 “잔여 작업”으로 채우지 않는다. 읽기 전용 review/test는 가능하나 새로운 owner write를 만들지 않는다.

### W7 — Serial final closeout

- 액션: `I.1`–`I.8` 전부. 이들은 새로운 finding이 아니라 앞선 전체 작업의 final acceptance owner다.
- Wn-I의 로컬 통합 실행은 해당 package handoff의 일부다. 전역 I 체크박스는 W7에서 모든 package의 증거를 집계한 뒤 한 번만 닫는다.
- 모든 producer/constructor census, compatibility matrix, 원본 보존, mutation, typecheck/lint/fence/ratchet, exact-source prepush, catalog 및 39건 최종 상태를 확인한다.
- 실제 Docker/Lima/EC2 proof가 없으면 해당 gap을 open으로 기록한다. external proof를 누락한 채 verified 39/39로 표시하지 않는다.

## 5. 테스트·문서·운영 자원도 분리

- 기존 tests: manifest의 각 `existingTests`에 정확히 한 owner를 배정한다. source subtree 안의 colocated tests도 그 owner에 속한다.
- 새 unit tests: `tests/unit/sep8-remediation/r01/`처럼 package 전용 경로. integration tests도 `tests/integration/sep8-remediation/r01/`처럼 분리한다.
- shared fixtures/helpers를 worker가 직접 바꾸지 않는다. package-local fixture를 사용하고 공통화가 꼭 필요하면 I 단계로 넘긴다.
- artifacts: `docs/plans/sep-8-structural-remediation/work/R01/` 등. README/ACTIONS/WAVES/manifest/검사기는 integrator-only다.
- OS child/DB/ports/temp roots는 test instance마다 고유하게 할당한다. fixed shared port/DB/process.env를 건드리는 rail은 별도 process 또는 I 단계로 옮긴다.
- worker test receipt에는 scope와 snapshot을 적는다. 같은 checkout에서 다른 worker가 쓰는 중 실행한 전역 gate 결과는 최종 receipt로 쓰지 않는다.

## 6. 검사 명령과 결과

Repo root에서:

```sh
bun docs/plans/sep-8-structural-remediation/verify-waves.mjs
```

특정 worker가 수정하려는 파일의 권한도 확인할 수 있다.

```sh
bun docs/plans/sep-8-structural-remediation/verify-waves.mjs --group R01 src/security/sensitivity-classifier.ts
```

검사 범위:

1. 39 finding/16 group/172 action floor와 exact coverage, 중복 owner, `.1`–`.4` 빠짐.
2. W0→W1…W6→W7 dependency, wave당 writer ≤3, 단일 integration 순서.
3. 같은 wave의 prefix/exact scope 간 symbolic intersection와 현재 파일 목록의 실제 intersection.
4. reserved path 침범, 기존 exact file/test 존재, audit digest/HEAD drift.
5. future-path collision injection, reserved-root exclusion, undeclared write rejection self-test.

작성 시 결과: **PASS — 배정 누락/중복 0, 같은 wave의 병렬 write-set 교집합 0.** 최초 검사에서 eval `index.ts`의 worker/reserved 충돌을 잡아 W5-I로 옮긴 뒤 재검사했다. 이는 계획의 집합 검증이지 제품 테스트 PASS가 아니다.

실제 negative control도 실행했다. R01의 security 파일은 exit 0, R01에서 `src/shared/env-flag.ts` 또는 R04 소유 `src/patch/applier.ts`를 쓰려는 검사는 각각 정확한 경로를 지목하며 exit 1이었다. 판정 결과만으로 mutation을 적용하지 않는다.

Scope 변경 시 이 검사부터 다시 수행한다. source HEAD/audit 입력이 바뀌면 manifest의 값만 기계적으로 바꾸지 말고 finding/owner/consumer와 dependency를 먼저 재검증한다.
