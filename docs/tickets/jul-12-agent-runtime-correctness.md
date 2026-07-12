# Ticket — Agent Runtime Correctness Primitives (OmO 흡수)

- **Date:** 2026-07-12
- **Status:** DESIGN LANDED + DUP-AUDITED + SOTA++ 적대어딧 (`docs/plans/jul-12-omo-absorption/00-final-rfc.md` §0). Implementation NOT started. **스코프 재조정됨 — §"실행 Phase"가 순서 SSOT.**
- **Provenance:** OSS `oh-my-openagent`(SUL-1.0, 코드복붙 금지·패턴흡수만) 4축 어딧 → 흡수후보 12개 점수화 → 80+ 3개 생존 → 3 correctness primitive 재설계(조사초안 실오류 5건 교정) → lane별 중복감사(4 slice 리프레임 + 네임트랩 격리) → 4-track SOTA 적대어딧(스코프 컷).
- **Goal:** agent가 만든 process/resource 누수, async 상태머신 순서버그, stale-edit 복구를 owner primitive(`ResourceScope`/`SimulationKernel`/`VersionedWorkspace`)로 닫는다. observability는 receipt/event 부산물이지 correctness 대체물이 아니다.
- **Design SSOT:** [00-final-rfc.md](../plans/jul-12-omo-absorption/00-final-rfc.md) — 계약/상태머신/불변식/acceptance는 정본(§0가 재조정 우선). 이 티켓은 실행 분해 + 감사 결과. 충돌 시 RFC 우선.
- **Effort legend:** XS(<반나절) · S(1일) · M(2–3일) · L(1주+).
- **브랜치 규율(동시세션 해저드):** 동시 세션이 main에 커밋함 → `feat/agent-runtime-correctness`에서 작업, ref rewrite 금지, 커밋 전 HEAD 재확인, 무인자 stash 금지. 현재 HEAD=main clean(우리 untracked 문서만).

> **North-star 제약:** correctness > observability. (a) lifecycle 첫 proof는 source grep이 아니라 **real-OS 행동 RED**, (b) leak-fix는 measure-first 예외(red-on-injection 충분)지만 edit(V lane)는 default-OFF + A/B 필수, (c) recorder는 observer지 lifecycle authority 아님.

---

## 🎯 실행 Phase (SOTA++ 어딧 재조정 — 순서 SSOT)

최종어딧: "kernel 아님 · minimum core만 지금 · 나머지 효능 baseline 뒤로"(RFC §0). **이 표가 아래 lane별 슬라이스보다 우선한다.**

| Phase | 슬라이스 | 합계 | 게이트 |
|---|---|---|---|
| **0 — 지금 SHIP** | R1-stopgap(XS) → R0(S) → R2-narrow(S) | <2일 | 실 leak 완화 + side-agent 회귀가드, north-star 무해, 위험 0 |
| **1 — 조건부** | S0(S) → S1(M) · V-diff(S/M) → V-hint(S) | | flaky 제거/편집품질 가치 있을 때 (S·V 독립 병렬) |
| **2 — DEFER (효능 게이트 뒤)** | R1-full(L) · R2-full(M, 103-site AST fence) · S2(L) · V1(M) → V2(L) → V3(M) | 주 단위 | RFC §11.1 outcome baseline 미충족 시 **착수 금지** |

**CUT/DEFER 판정 (opportunity-cost, RFC §0.1):**
- **R1-full 재분할:** 실 gap = R1-stopgap **한 줄**뿐. 나머지(pidfd/cgroup/pgroup adapter·StopReceipt)는 성숙한 `escalatingKill`에 계약 두르기 → Phase-2 measured-need로.
- **S2 DEFER:** 기존 crafted test 3파일이 이미 bash-bg 커버 = rigor-around-fine-code.
- **V-lane 다운스코프:** full three-way(§7) 대신 **V-diff(histogram) + V-hint(cheap)**. V1/V2/V3(three-way/CAS)는 A/B가 수요 실증 후.
- **north-star 부채:** 프로그램이 유저 north-star 6항목 중 0개 건드림. **유일한 정렬 지점 = lifecycle `StopReceipt`를 `src/agent/run-ledger/`(RunKind `shell|subagent|mcp_task|exec`, `types.ts:25`)에 report**(현재 미배선) → 별도 backlog, 평행 event stream 금지.

---

## ⚠️ 네임트랩 — 착수 시 여기로 병합 금지 (감사에서 격리)

- **`src/agent/session-resource-registry/`** — "ResourceScope"와 유사하나 **store/cache LRU**지 process lifecycle 무관. R1 병합 금지.
- **`three-way-restore.ts`** — Cline 체크포인트 restore지 **텍스트 merge 아님**. V2 병합 금지.
- **`tests/unit/session-r2-interleaving-hellgate.test.ts`** — interleaving+불변식 있으나 대상이 `subagent-bg` 큐(**bash-bg-registry와 다른 SM**). S2 패턴 참고용, 같은 SM 아님(→ S2 roadmap 두 번째 consumer 후보).
- **`ClockPort` 4중 정의**(connectors/types.ts:113 외 oidc·scheduler·reactor) — slice-boundary 때문. S1 승격 시 **통일 말고 하나 alias**.
- **H9 `rangeHashes`**(stale-read-guard/state.ts:129) — range-keyed opaque hash라 **full-file base 복원 불가**. V1 재활용 금지.

---

## ALREADY DONE — 재구현 금지 (anti-dup, 코드 검증 2026-07-12)

### R lane
- **tree-kill**: `src/runtime/process-tree.ts:91-122`(2-snapshot ppid walk, no-throw/idempotent) — `:16-38`이 process-group 의도적 미ship 명시. **재구현 금지**, R1-full은 위에 OS containment 얹고 ppid는 fallback 강등.
- **escalation**: `src/runtime/guarded-spawn.ts:112-175`(SIGTERM→SIGKILL, `proc.exited` 조기 disarm, recycled-pid latch, pid>0 가드, `:121` `useTree`). **새 알고리즘 금지** — 빠진 건 owner 계약뿐.
- **receipt/await-reap 부분선례**: `bash-bg-registry.ts:341-350`(`kill→await exited→snapshot`), `plugin-host.ts:224-235`(await-reap + idempotent `stopping` promise 공유). `StopReceipt`·"concurrent stop 한 promise 공유" 부분구현 → 패턴 흡수, 신규 타입만.
- **partial audit**: `tests/unit/runtime/single-pid-kill-ban-hellgate.test.ts:66`(정규식 `/escalatingKill\(([^)]*)\)/`, alias/nested-paren 취약 자백). raw `cp.kill`/`process.kill` 못 잡음.
- **AST 스캐너(성숙)**: `tests/unit/_arch/slice-boundary-scanner.ts` = `typescript` compiler API. `collectAstHits:111`·`isPropertyAccessLike:93`·`matchesMember:106`·`scanConsoleCalls:354`. 주석/문자열 native 면역, 33개 테스트 소비. **R2-full 재사용.**
- **uv fork-storm**: `QUANTA_PYENV_SHIM_ACTIVE` sentinel로 fix됨. **재fix 금지.**

### S lane
- **injectable TimerPort 이미 존재**: `src/connectors/token-refresh-scheduler.ts:53`(`interface TimerPort { set(cb,ms):handle; clear }` — RFC §6.1과 동형, 계약 주석 :51) + `ClockPort` DI(`:238`). virtual fake: `token-refresh-scheduler-hellgate.test.ts:81-130` `fakeTimer()`(fireNext/`totalArmed` leak-detector) + `clockOf()`. **S1은 승격, 인터페이스 재발명 금지.**
- **seeded-PRNG 재사용형·중복 다수**: xorshift32 `Rng`(`fuzz-pure-cores-r4-hellgate.test.ts:35` + `surrogate-safe-truncation-guard.test.ts:56`), splitmix(`conflict-parser-differential-fuzz.test.ts:44`), mulberry32(4파일). **하나 승격 + 6~7 중복 수렴 인지**.
- **property-fuzz 계약 수제운용**: 6파일이 seed+≥200iter+counterexample→crafted 승격. **S0 fallback = commands/shrinking/scheduler 레이어만**(미니 fast-check 전체 아님).

### V lane
- **read가 매 read 전체파일 해시 계산**: `src/tool/read/index.ts:442` `hashReadContent`(**SHA-1**). V1은 "hash 추가"가 아니라 "그 hash 색인 **bytes 저장소** + `documentRevision` 노출". ⚠️ digest 통일(read SHA-1 vs edit `expected_hash` sha256 `edit/index.ts:47`)이 숨은 작업.
- **ReadFileState 저장물**: `Map<path,mtimeMs>` + lazy `Map<rangeKey,contentHash>`(`stale-read-guard/state.ts:64,89`). **bytes 아님** → V1 CAS TRUE-GAP.
- **2-way CAS 원형**: `src/runner/hunk-apply.ts`(apply 시점 재read→`before` drift 비교→불일치 stale, **0 bytes write**). ⚠️경로=`@/runner`(dup-audit가 `@/tool/edit`로 오기, 정정). **V2 CAS-recheck는 이걸 3-way 일반화**(재발명 금지); `@/runner` 소속이라 로직도 `@/shared/text-diff`로 함께 추출.
- **exact/fuzzy ladder**: `applyExactEdit`→`applyFuzzyEdit`→`planEdit`(`edit/index.ts:346-356`) + `line_ranges`(line-range.ts). **V2는 ladder 확장.**
- **2-way diff math = LCS**: `@/runner/diff-ops.ts:56,67,151`("line-level LCS, Hunt–McIlroy, Quadratic" 자백). merge/three-way 0건. **V-diff가 histogram 교체 대상.** `@/tool`이 `@/runner` 직접 import 금지(layer 역행) → pure core를 `@/shared/text-diff/`로 추출.
- **trajectory/telemetry rail**: `apps/eval/trajectory/classifier.ts`(세션 분류), `tool-diff-capture.ts:14`(before/after sink, toolCallId 상관, default-OFF), `trajectory-debug-sink.ts`(metadata 단일슬롯). **V3 correlation은 위에 얹음**, request해시 불건드림.

---

## 리프레임 요약 (감사 — 스코프 확정)

| slice | 원 표현 | 감사 후 실체 | 재사용률 |
|---|---|---|---|
| **R2** | "scanner infra 신규" | slice-boundary-scanner에 **predicate 1 + export 3 승격** | ~85% |
| **S1** | "new timer seam 설계" | token-refresh-scheduler **TimerPort/fakeTimer 배선·승격** | ~60% |
| **V1** | "hash 없음" | hashReadContent가 hash 이미 생성 → **bytes 저장소만** | 해시 재사용 |
| **V2** | "완전 신규 three-way CAS" | **hunk-apply 2-way CAS를 3-way 일반화** + ladder 확장 | ladder/2-way/hunk-apply |

**FULL-DUP 없음** — 슬라이스 전부 착수 정당. 위 4개는 "build new" → "extend/wire existing"으로 축소.

---

## 실행 순서 (Phase = SSOT)

```text
Phase 0 (지금):   R1-stopgap ─▶ R0 ─▶ R2-narrow        [<2일, north-star 무해]
Phase 1 (조건부): S0 ─▶ S1          V-diff ─▶ V-hint     [S-lane·V-lane 독립 병렬]
Phase 2 (DEFER):  R1-full ─▶ R2-full   S2   V1 ─▶ V2 ─▶ V3   [RFC §11.1 효능 baseline 뒤]
```
- 각 slice = hellgate(real RED → TDD+구조 → 적대어딧 ≥3R → 셀프어딧 → 구조TDD).
- **R2-narrow 선행 = R1-stopgap** — stopgap이 side-agent raw kill을 닫으면 narrow 가드가 회귀 방지. **blanket AST fence(R2-full)는 103-site 트리아지라 R1-full owner 계약 뒤 Phase 2**(잘못된 구조를 grep으로 먼저 동결 금지).
- Phase 2는 **효능 baseline 없이 착수 금지**(§Acceptance).

---

## R lane — ResourceScope

### R1-stopgap — [Phase 0 · XS] leak 즉시 지혈 — TRUE-GAP(미배선)
- **What:** `side-agent-fork-port.ts:75-78`의 raw `cp.kill("SIGTERM")`(single-shot, no tree-kill, no escalation)을 기존 `escalatingKill(proc, <killer>)`로 라우팅. **우리 메모리 "state=running인데 프로세스 없음" leak의 한 뿌리.** 최종 ResourceScope와 안 충돌(나중 흡수).
- **Done:** red-on-injection = killer 미주입 시 byte-identical(`guarded-spawn.ts:121 useTree` 가드가 보장). fork된 side-agent의 grandchild까지 signalled.

### R0 — [Phase 0 · S] proof rail cleanup — TRUE-GAP(순수 위생)
- **What:** 종료 후 삭제 temp worker 재spawn `Module not found ...valid-then-kill.mjs` stderr = 테스트가 registry를 terminal까지 close 안 함(production leak 증명과 구분).
- **Where/재사용:** `tests/integration/side-agent-ipc-kill-mid-result-e2e.test.ts`(afterAll이 `rmSync`만; per-test `reg` 미종료). `reg.stopAll()` 이미 존재(`src/side-agent/registry.ts:293`) — `afterEach`에서 호출 + owned child/timer ledger 0 pin.
- **⚠️ 증거 신뢰도:** "valid-then-kill.mjs stderr"는 유저 RFC 관찰 출처(내 재현 아님) → R0 착수 시 실 stderr 먼저 재현 확인.
- **Done:** targeted rail 0 fail, post-test stderr 0, lingering process 0.

### R2 — [Phase 0 · S] side-agent kill regression guard (narrow) — PARTIAL-DUP → extend
> **⚠️ 어딧 재스코프(2026-07-12 실측):** src에 `.kill(` 사이트가 **103개**(15개 디렉토리 분산, 대부분 자식-없는 ChildProcess=정당). blanket `.kill(` 밴은 103개 전부 RED → **Phase-0 S-effort 불가**. syntactic하게 "route해야 함 vs 정당"을 못 가름(기존 `escalatingKill`-arity 라쳇이 정확히 이 이유로 좁음). `process.kill(` destruction은 `process-tree.ts:206`(allowlist된 killer)뿐, 나머지 `process.kill(pid,0)`은 liveness(carve-out). **→ Phase-0 R2 = 좁은 회귀가드만.** blanket AST effect-fence + 103-site 트리아지는 **R2-full(Phase 2)**로.
- **What(narrow):** R1-stopgap이 닫은 side-agent raw `cp.kill`이 되돌아오지 못하게 + 기존 `single-pid-kill-ban-hellgate` arity 라쳇의 사각(fork/exec 포트의 raw `cp.kill`) 최소 확장. `signal===0` liveness는 명시 제외.
- **Where/재사용:** 기존 `single-pid-kill-ban-hellgate.test.ts`(정규식 arity)에 side-agent-fork류 raw `cp.kill(` 금지 케이스 추가. AST 전환은 R2-full로 미룸.
- **Done:** side-agent-fork raw kill 재발 시 RED, 기존 103 정당 사이트 false-positive 0(narrow라 안 건드림).

### R2-full — [Phase 2 · M] destruction effect fence (AST, 103-site 트리아지) — **⛔DEFER**
> DEFER: 103개 `.kill(` 사이트를 adapter-capability vs must-route로 분류해야 함 = M+ 트리아지, R1-full owner 계약(ResourceScope) 생긴 뒤라야 "route 대상"이 정의됨.
- **What:** raw `process.kill`/`ChildProcess.kill`/platform raw terminate를 platform adapter 파일에서만 허용. `signal===0` liveness는 별도 `ProcessLivenessPort` owner로 분리.
- **Where/재사용(~85% 인프라):** `slice-boundary-scanner.ts`에 `scanConsoleCalls`(:354) 동형 **`scanRawKillCalls` predicate 추가**. `collectAstHits`(:111)/`isPropertyAccessLike`(:93)/`matchesMember`(:106) **export 승격**. regex hellgate를 이 AST detector **regression-case로 흡수 + regex SSOT 제거**(두 SSOT 금지). 103 사이트 각각 capability 선언 or route.
- **🔺SOTA++(RFC §0.3):** `.kill(` 하나로 3경로 놓침 — `worker.terminate()`·native-addon raw `kill(2)`·`process["kill"]` computed. 커버하거나 **"미커버 표면" 목록으로 정직 문서화**(false-negative 은폐 금지).
- **Done:** comments/strings/probes false-positive 0, alias/raw-kill mutation RED, 103 사이트 전부 좁은 adapter capability 분류 완료.

### R1-full — [Phase 2 · L] side-agent ResourceScope + OS containment — TRUE-GAP(부품 80% 산재) · **⛔DEFER**
> DEFER: 실 gap은 stopgap 한 줄이 이미 닫음. 나머지는 성숙 코드에 계약 두르기 → §11.1 baseline 뒤.
- **What:** `spawn`이 owner scope 등록, `stop`/`close`가 terminal receipt(descendant reaped await). 첫 proof = **real-OS**: TERM-trapping child+grandchild → `scope.close("shutdown")` → identity 기준 둘 다 reaped + pending timer/port/IPC 0.
- **Where:** `src/host/runtime/side-agent-fork-port.ts`(`kill():void`→awaitable stop), `src/side-agent/{process,process-registry}.ts`, 신규 `src/host/runtime/resource-scope/`.
- **재사용(재구현 금지):** escalation/disarm/reaped-latch=`escalatingKill`. tree-kill=`defaultPpidWalkKiller`. receipt·await-reap·idempotent-stop=`plugin-host.stop()`·`bash-bg-registry.kill()` 흡수. **순수 신규 = (a) owner scope 등록/close 계약 (b) `StopReceipt` 타입 (c) Linux pidfd-signaling + cgroup capability-probe adapter (d) POSIX pgroup adapter. Windows Job Object = deferred(실 target 미확인, capability port stub만).**
- **🔺SOTA++(RFC §0.3):** identity = Linux **pidfd**(signal SSOT, recycled-pid에 ESRCH); `generation` nonce는 pidfd 미가용 전용 관측 identity로 강등(signal 경로 금지, 이중구현 방지). hard phase = **freeze→cgroup.kill** 원자(**우리 uv fork-storm 실장애 차단**). `close()`는 **close-deadline**(S1 TimerPort seam 위) 내 미도달 시 hang 아니라 `terminal:false+unkillable`(D-state). cgroup **capability-probe**로 non-root/nested 명시 degrade(RFC §5.3↔5.5 모순 해소).
- **Done:** child/grandchild reaped, duplicate stop signal 중복 0, close 후 pending resource 0, cgroup 미가용 probe 후 명시 degrade receipt, D-state는 `terminal:false+unkillable`(hang 금지), lifecycle `StopReceipt`를 run-ledger에 report.

---

## S lane — SimulationKernel

### S0 — [Phase 1 · S] fast-check × Bun compat + 결정론 gate — TRUE-GAP(compat 미증명)
- **What:** `fast-check`(pinned dev dep) `commands`/`asyncModelRun`/controlled scheduling/seed·replayPath/shrinking이 Bun에서 도는지 owner-test. 실패 시 custom-PRNG-only 후퇴 금지 — 동일 command shrinking/replay/scheduler 계약 repo-local adapter가 대체.
- **재사용:** fallback baseline = property-fuzz 6파일 → 자작분 commands/shrinking/scheduler만.
- **🔺SOTA++(RFC §0.4):** compat = "도느냐"뿐 아니라 **결정론 canary** — 동일 seed 2회 run byte-identical trace(microtask/Promise-continuation 스케줄 결정론)인가. 비결정론이면 fast-check 채택해도 G4 무효 → repo-local deterministic scheduler 필수.
- **Done:** compat+결정론 canary 판정 + 채택/대체 결정 문서화. **S1 착수 차단조건.**

### S1 — [Phase 1 · M] deterministic timer/scheduler seam — PARTIAL-DUP(seam 존재·미이식)
- **What:** `escalatingKill`이 global `setTimeout` 직접소유 대신 `TimerPort` 수령(prod default=현 semantics, test=virtual). `ClockPort.now()`만 fake로는 실 setTimeout 제어 불가.
- **Where/재사용(~60%):** `guarded-spawn.ts`(raw setTimeout :130,:162,:169,:218)·`bash-bg-registry.ts`(DeadlineSignal setTimeout :231,:268, sleepUntilDeadline :262, **await-poll `while(true)` :289**) = 미이식 seam gap. `TimerPort`·virtual fake는 `token-refresh-scheduler.ts:53`+`fakeTimer`를 **`tests/test-support/simulation/`(신규)로 승격**. 시그니처(`set(cb,ms)` vs RFC `schedule(ms,task)`) 통일 SSOT 하나.
- **🔺SOTA++(RFC §0.4):** TimerPort화 대상은 escalatingKill만이 아니라 **poll-loop(`:289`)까지 전부** + AbortSignal을 virtual event로. poll 누락 시 "regex-match vs process-exit vs timeout" 순서가 wall-clock 종속 → 결정론 샌다. **추가 산출물: bash-bg 로직을 순수 reducer `(state,command)→(state',effects)`로 추출**(S2 differential 전제, model-oracle 회피).
- **Done:** owner test real-time sleep 0, same-schedule replay snapshot identical, prod parity green, 순수 reducer 추출 완료.
- **⚠️:** `ClockPort` 4중 정의 통일 말고 alias. seeded-PRNG 승격 시 중복 수렴 인지.

### S2 — [Phase 2 · L] model-based chaos rail (bash-bg-registry) — TRUE-GAP · **⛔DEFER**
> DEFER: 기존 crafted test 3파일이 bash-bg 커버 = rigor-around-fine-code. §11.1 baseline(leaked-timer류가 실 실패 유발 실증) 없이 착수 금지.
- **What:** **실 reducer(S1 산출) + 생성 command**(register/adopt/emitChunk/exit/await/timeout/kill/killAll/abort/overflow/deliverLateExit/throwFromNotifier/advanceTime/runNextScheduled) + shrinking/replay. 축약 `BgRegistryModel`은 oracle 아니라 **differential 참조**(real reducer vs reduced spec 불일치=RED). **magic cap(OmO `tasks*4+40`) 금지 → fixpoint quiescence**(runnable+timer queue empty ∧ 모든 resource terminal ∧ pending waiter/listener/process 0; **canonical snapshot**(id→정렬인덱스·시각 제거) 반복 = livelock RED).
- **불변식(RFC §6.3+):** capacity/conservation/terminal-monotonicity/effect-bounds(gen당 TERM≤1·KILL≤1·reap≤1)/resource-quiescence/late-event-idempotence/error-containment/determinism + **temporal inv9 progressive-termination**(외부 kill 없이 register된 handle은 ◇ terminal, liveness). **⚠️ `exactly-once-disarm` callback-count 불변식 금지**(정상 fire면 clear 0회여도 맞음) → pending-timer=0 + hard-signal 상한 + terminal 후 re-arm 부재. global `unhandledRejection` observer를 parallel test에 설치 금지.
- **🔺SOTA++(RFC §0.4):** fast-check = random **sampling**(exhaustive/DPOR 아님 — 정직 표기). late-exit/abort/evict/await **critical-pair만 bounded exhaustive permutation** 자작. **swarm**: capacity/timeoutMs/pollInterval/buffer-budget run별 랜덤화. **buggify-as-command**: fault를 소스 mutation 아니라 command로. mutation matrix = **regression-lock only, completeness 증명 아님**(정직 라벨).
- **Where:** `tests/unit/runtime/bash-bg-registry-model.test.ts`, `tests/test-support/simulation/`. 현 bash-bg 테스트 3파일 hand-crafted(chaos 0).
- **Done(anti-vacuous 하드게이트):** §6.3+9 불변식 green **AND** owner-failure mutation **전부 RED**(eviction off-by-one/terminal-guard 제거/re-arm guard 제거/registry delete 누락/late-exit 두번/notifier-throw가 cleanup 중단) **AND** real-reducer↔reduced-spec differential green. shrunk trace fix 후 replay green. **증거 없으면 랜딩 금지.**
- **Roadmap:** kernel 계약 SM-agnostic → `side-agent/process-registry.ts`·subagent-bg 큐 확장.

---

## V lane — VersionedWorkspace (default-OFF, measure-first)

> **⚠️ 다운스코프(RFC §0.5):** V-lane은 3 primitive 중 최약. full three-way+CAS는 자기 점수(cheap-hint 78 vs full 63) 거스름, base 대부분 evict돼 실동작이 cheap-hint로 수렴. *(design-knowledge, 코드검증 아님: 경쟁사 0곳이 stale-edit auto-merge 안 함 — Claude Code/Aider/OpenHands 전부 실패→conflict/재시도. V2 착수 전 재확인 권장.)* **근term = V-diff + V-hint. V1/V2/V3는 A/B가 three-way 수요 실증 후.**

### V-diff — [Phase 1 · S/M] LCS→histogram diff + shared 추출 — TRUE-GAP, V-lane과 독립
- **What:** `src/runner/diff-ops.ts`의 Hunt-McIlroy LCS(`:56,67,151` "Quadratic" 자백)를 **histogram diff**로 교체. 코드에서 `}`·빈줄·`import` 반복라인 앵커 오정렬 감소. **V-lane 최고 ROI SOTA 상승** — cheap-hint 품질·향후 three-way non-overlap 게이트의 공통 전제.
- **⚠️ 어딧: 추출 소유권.** V-hint(@/tool, Phase 1)가 이 코어를 쓰는데 `@/tool`→`@/runner/diff-ops` import 금지(layer fence). 따라서 V-diff가 **pure core를 `@/shared/text-diff/`로 추출**(diff-ops는 compat re-export)까지 소유해야 함 — 인플레이스 교체만으론 V-hint가 import할 대상이 없음(원래 V2로 미뤘던 추출을 앞당김 → S가 아니라 S/M).
- **Where:** 신규 `@/shared/text-diff/`(histogram pure core) + `diff-ops.ts` compat re-export. property test(LCS 오정렬 케이스 red-on-LCS).
- **Done:** 기존 diff 소비자(diff-preview 등) 회귀 0, `@/shared/text-diff` leaf import 가능, 반복라인 앵커 오정렬 케이스가 histogram에서 correct.

### V-hint — [Phase 1 · S] cheap remap hint on edit failure (RFC 03) — TRUE-GAP, V-lane v1 실체
- **What:** 편집 precondition 실패 시 "re-read" 산문 대신 **국소 diff 힌트**(`old_string` 앵커, stale 줄 지목) → 모델이 전체 재read 없이 국소 재조준. read 계약 불변 = 상시 토큰세 0.
- **Where:** `edit/index.ts` 3 failure-result site(stale_read/stale_precondition/not_found)에 histogram diff core(`@/shared/text-diff`, `diff-preview` 역수입 금지) 재사용.
- **Knob:** `QUANTA_EDIT_REMAP_HINT` default-OFF.
- **Done:** default-OFF byte-identical, A/B(edit-success-rate/re-read-count/tokens-per-successful-edit) 효능 게이트. **leak-fix 예외 아님 — 측정 필수.**

### V1 — [Phase 2 · M] revision CAS + versioned read — TRUE-GAP(bytes), 해시 PARTIAL-DUP · **⛔DEFER**
> DEFER: V-hint A/B가 "cheap-hint로 못 잡는 unrelated-region auto-merge 수요" 실증 전 착수 금지(V2 없이 inert).
- **What:** read 결과에 content-addressed `documentRevision`(전체 파일 bytes 해시). session-scoped `RevisionStore`(`revision→immutable full-file bytes` CAS, 동일 content 1회, budget=injected policy, eviction observable·miss는 fail-closed conflict).
- **Where/재사용:** `src/tool/read/`. `hashReadContent`(read/index.ts:442) 재사용(SHA-1→sha256 통일). H9 `rangeHashes` 재활용 금지. eviction FIFO(state.ts:142) budget 참고. `expected_hash`를 migration alias 흡수(SSOT 하나).
- **🔺SOTA++(RFC §0.5):** `documentRevision` = **raw on-disk bytes** sha256(EOL/BOM 정규화는 fuzzy ladder 내부만). RevisionStore bounded budget → **압박 시 base evict → three-way 미발화 → efficacy 메모리 종속**(correctness 아닌 efficacy degrade, 정직 명시). base 생존율을 V3 metric으로 측정 — 낮으면 three-way 분기는 dead code.
- **Done:** same-bytes dedup, revision이 exact raw base bytes 복원 or typed miss, telemetry content leak 0.

### V2 — [Phase 2 · L] three-way edit + typed conflict — PARTIAL-DUP · **⛔DEFER**
> DEFER: 경쟁사 0곳이 auto-merge 안 하는 미검증 프론티어. V-hint A/B 수요 실증 뒤.
- **What:** `base`/`intended`/`current` 3-way. 자동적용 4조건 전부(base uniqueness ∧ base→current와 base→intended가 target에서 non-overlap ∧ current mapping 정확히 1 ∧ commit 직전 CAS 재일치). 실패 = `EditConflict`(base_snapshot_missing/target_changed/ambiguous_mapping/commit_raced), similarity score만으로 write 금지, first-match 금지.
- **Where/재사용:** `src/tool/edit/`. **`src/runner/hunk-apply.ts` 2-way CAS(re-read→drift→zero-write)를 3-way 일반화**(재발명 금지); `@/runner` 소속이라 로직을 `@/shared/text-diff/`로 함께 추출(diff-ops compat re-export). ladder(exact/fuzzy) 확장. **`@/tool`→`@/runner`/`diff-preview.ts` import 금지**(layer 역행). tool은 typed conflict + bounded plain renderer만.
- **🔺SOTA++(RFC §0.5):** non-overlap 판정은 **V-diff histogram 위에서**(LCS 앵커 오정렬이면 게이트 vacuous — false-non-overlap이 겹치는 edit을 auto-write). `ConflictHunk`는 기존 `src/git/conflict-parser.ts` `parseConflicts` 위에 정렬(SSOT 2개 금지).
- **Knob:** `QUANTA_EDIT_THREEWAY` default-OFF, `QUANTA_EDIT_CONFLICT_HINT` default-OFF(V3 shadow green 전 model 노출 금지).
- **Done:** non-overlapping concurrent edit auto-apply, overlapping/ambiguous/raced edit 0 bytes write, snapshot-miss output이 changed-lines 주장 안 함, **LCS 오정렬로 겹치는 edit을 non-overlap 오판해 write하는 mutation이 property test에서 RED**.

### V3 — [Phase 2 · M] shadow measurement + rollout — TRUE-GAP(correlation) · **⛔DEFER**
- **What:** edit attempt chain `sessionId+turn+pathHash+attemptChainId`, 기록: failure mode / 다음이 same-path read였나 / N회내 success / conflict output tokens / 후속 read tokens / wrong-location auto-apply 0. **safety(CAS/fail-closed)와 quality(hint prose) A/B 분리.** shadow green → hint A/B → success 개선 없이 token/wrong-write 증가 시 중단.
- **Where/재사용:** correlation 계산 신규, **trajectory rail 위에 얹음** — `classifier.ts`에 edit-attempt-chain 필드 추가, sink는 `tool-diff-capture` default-OFF 패턴, debug는 `trajectory-debug-sink` metadata 슬롯 준수.
- **Done:** correlated recovery metric 존재, shadow false-locality 0, model-facing default 결정에 측정 리포트. **V3 전 hint default-ON 금지.**

---

## Acceptance (RFC §11 매트릭스가 정본)

closeout = R-A1~4 / S-A1~4 / V-A1~5 / O-A1~2 전부 current HEAD green **AND** mutation/fault row RED 증거 보존. 상태보드(RFC §13) `TODO`를 문서점수·historical green으로 승격 금지.

| Slice | Phase | Effort | 분류 | 선행 | 첫 proof |
|---|---|---|---|---|---|
| R1-stopgap | **0 SHIP** | XS | TRUE-GAP | — | killer 미주입 byte-identical + grandchild signalled |
| R0 | **0 SHIP** | S | TRUE-GAP | — | noisy post-test respawn 제거 |
| R2-narrow | **0 SHIP** | S | PARTIAL-DUP→extend | R1-stopgap | side-agent raw kill 재발 RED, 103 정당사이트 FP 0 |
| S0 | 1 조건부 | S | TRUE-GAP | — | fast-check compat + 결정론 canary |
| S1 | 1 조건부 | M | PARTIAL-DUP(seam 존재) | S0 | timer/scheduler replay identical + reducer 추출 |
| V-diff | 1 | S/M | TRUE-GAP(histogram+shared추출) | — | LCS 오정렬 red, `@/shared/text-diff` leaf import |
| V-hint | 1 | S | TRUE-GAP(cheap) | V-diff | edit-success A/B (measure-first) |
| R1-full | 2 DEFER | L | TRUE-GAP(부품산재) | R0·§11.1 | real descendant leak RED(OS E2E)+pidfd/freezer |
| R2-full | 2 DEFER | M | PARTIAL-DUP(AST infra ~85%) | R1-full | 103-site adapter-capability 분류 + AST mutation RED |
| S2 | 2 DEFER | L | TRUE-GAP | S1·§11.1 | invariant green + mutation 전부 RED + differential |
| V1 | 2 DEFER | M | TRUE-GAP(bytes) | V-hint A/B | revision→raw base bytes or typed miss |
| V2 | 2 DEFER | L | PARTIAL-DUP(hunk-apply 일반화) | V1 | overlap/ambiguity/CAS-race 0-byte-write |
| V3 | 2 DEFER | M | TRUE-GAP(correlation) | V2 | correlated A/B rail + false-locality 0 |

**Phase 2 착수 차단조건(RFC §11.1 효능 baseline):** (a) orphan/leaked process가 실패·stuck 세션 몇 %를 유발하는지(trajectory 스캔), (b) stale-edit fail-closed가 실 fail taxonomy(`jun-29-gap-essence`)에서 차지하는 비중. 무의미하면 해당 lane CUT.
