# RFC: Agent Runtime Correctness Primitives

- **상태**: Final design / implementation not started
- **날짜**: 2026-07-12 (SOTA++ 최종어딧 반영)
- **권위**: 이 디렉터리의 구현 방향 SSOT. `01`–`03`은 조사·대안 기록이며 충돌 시 이 문서가 우선한다. **§0(최종어딧 재조정)이 이하 본문 중 상충하는 스코프·설계 주장을 override한다.**
- **범위**: process/resource lifecycle, asynchronous state-machine verification,
  versioned edit recovery
- **관련 코드**:
  - `src/host/runtime/side-agent-fork-port.ts`
  - `src/runtime/{guarded-spawn,process-tree,bash-bg-registry}.ts`
  - `src/side-agent/{process,process-registry}.ts`
  - `src/agent/run-ledger/` (north-star substrate — lifecycle receipt 배선 대상)
  - `src/tool/edit/index.ts`
  - `src/tool/stale-read-guard/`
  - `src/runner/diff-ops.ts`, `src/apps/cli/diff-preview.ts`, `src/git/conflict-parser.ts`

---

## 0. 최종어딧 재조정 (SOTA++, 4-track 적대어딧 2026-07-12)

> **트랙 범위 주의**: 이 문서는 **Track 1(Agent Runtime Correctness Primitives)**의 SSOT다.
> OmO 흡수의 두 번째 트랙(UX·MCP·세션-연속성)은 [05-ux-mcp-track.md](05-ux-mcp-track.md)에
> 있으며 이 문서와 disjoint하다(hashline만 겹치고 결론 동일 — `03`/`05 §3.7` 참조).

각 primitive를 그 도메인 SOTA에 대고 적대적으로 깠다(structured-concurrency/cgroup/pidfd · deterministic-simulation-testing(FDB/madsim/loom) · diff3/histogram/CRDT). 어딧이 스코프를 크게 잘랐다. 이하 본문은 원설계이며, **아래 재조정이 우선한다.**

### 0.1 스코프 판정 — kernel 아님, minimum core만 지금
- 이건 통합 kernel이 아니라 **3개 독립 correctness primitive**다(§1이 이미 인정). "kernel" 프레이밍과 §8 `RuntimeCorrectnessEvent` union을 unifying seam으로 주장하지 않는다.
- **Minimum core (Phase 0, 지금, 합계 <2일):** R0 + **R1-stopgap** + R2. 실 leak 완화 + false-green fence, north-star 무해.
- **Phase 1 (조건부):** S0 → S1 (flaky 제거 가치 있을 때).
- **Phase 2 (§11.1 효능 게이트 뒤, measured-need까지 착수 금지):** R1-full · S2-full · V lane 전량.
- 근거: 우리 `escalatingKill`은 이미 production-grade(티켓 자백) — 진짜 gap은 `side-agent-fork-port.ts:78` **한 줄**(R1-stopgap). R1-full 대부분은 "이미 잘 도는 코드에 rigor 두르기". 프로그램이 north-star 6항목 중 **0개**를 건드림. 벤치 프론티어(oracle-loop/synthesis 수렴, `jun-29-gap-essence`)와도 어긋남.

### 0.2 누락된 unifying seam — Run Ledger에 배선 (평행 stream 금지)
- `src/agent/run-ledger/`(north-star #2, LANDED)에 `RunKind=shell|subagent|…` + `waitingOn`/`resumeAction`이 이미 있다. lifecycle `StopReceipt`와 bg-handle 상태는 **새 event stream을 만들지 말고 Run Ledger로 report**한다. 이것이 §8 observability의 SSOT 경로이자 이 프로그램이 north-star를 움직이는 유일한 지점 → 별도 backlog로 승격.

### 0.3 Primitive A (ResourceScope) SOTA++ 델타 — §5 override
- **P0 pidfd-first**(Linux): `pidfd_open`@spawn + `pidfd_send_signal`이 signal SSOT. recycled-pid에 ESRCH로 race를 구조적으로 차단. `generation` nonce는 pidfd 미가용(macOS/fallback) 전용 관측 identity로 강등 — signal 경로에 두지 않음(이중구현 방지).
- **P0 freezer-then-kill**(Linux): hard phase = `cgroup.freeze → cgroup.kill` 원자 시퀀스. **우리가 겪은 uv fork-storm(teardown 중 재귀 fork) 실장애를 구조적으로 닫음.** enumerate-then-kill은 수렴 안 함.
- **P0 close-deadline**: `close()`는 `closeDeadlineMs` 내 terminal 미도달 시 hang 대신 `terminal:false + unkillable` 반환(D-state 정직 처리). 이 deadline timer는 S1 TimerPort seam 위에 얹는다.
- **cgroup capability-probe**: non-root/nested/systemd-Delegate-미설정 시 cgroup 미가용 → probe 후 pidfd+pgroup degrade를 receipt에 명시. **§5.3(cgroup 무조건 primary)↔§5.5(몰래 degrade 금지) 모순 해소.**
- **Windows Job Object adapter = deferred**(실 deploy target 미확인; `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`는 만들 때 채택). day-1 미구현, capability port stub만.
- **effect-fence 미커버 표면 정직화**: `worker.terminate()`·native-addon raw kill·`process["kill"]` computed access는 `.kill(` member 매칭이 놓침 → allowlist 아니라 "미커버 표면"으로 문서화.

### 0.4 Primitive B (SimulationKernel) SOTA++ 델타 — §6 override
- **최대 미스콜: reference-model을 oracle로 두는 게 SOTA 정반대.** FDB/madsim/TigerBeetle 통찰 = "모델은 drift하는 부채, 실코드를 결정론화하라". → bash-bg 로직을 **순수 reducer `(state,command)→(state',effects)`로 추출**(S1 산출물), sim이 그 실 reducer를 돌린다. 축약 model은 oracle 아니라 **differential 참조**(real reducer vs reduced spec 불일치=RED, `conflict-parser-differential-fuzz` 패턴). model-drift를 자기검증으로 전환.
- **fast-check = random schedule sampling, NOT exhaustive/DPOR.** "systematic 탐색" 표현 정정. late-exit/abort/evict/await **critical-pair만 bounded exhaustive permutation** 자작(loop 전면 DPOR는 과투자).
- **swarm 추가**: capacity/timeoutMs/pollInterval/buffer-budget을 arbitrary로 run별 랜덤화(FDB swarm). 저비용 고효과.
- **buggify-as-command**: notifier-throw/late-exit-reorder/evict-race를 소스 mutation이 아니라 **command로 생성**(fault injection). mutation matrix는 "regression-lock only, completeness 증명 아님"으로 정직 라벨.
- **temporal invariant 추가**(inv 9): "외부 kill 없이 register된 handle은 유한 command 후 ◇ terminal"(no-starvation, liveness). 기존 8개는 전부 safety.
- **livelock snapshot canonical form**: id→정렬인덱스, `Date.now`/UUID 제거 후 비교(안 하면 nondeterministic field가 livelock을 progress로 위장).
- **poll-loop까지 timer 결정론화**: `bash-bg-registry.ts:231/268/501`(DeadlineSignal+await-poll while) + AbortSignal virtual event 전부 S1 대상(escalatingKill만이 아님).
- **S0 = 결정론 canary**: fast-check가 Bun에서 "도느냐"뿐 아니라 "동일 seed 2회 run byte-identical trace"(microtask/Promise-continuation 스케줄 결정론)까지 검증. 비결정론이면 fast-check 채택해도 G4 무효.

### 0.5 Primitive C (VersionedWorkspace) SOTA++ 델타 — §7 다운스코프
- **V-lane은 3 primitive 중 최약. full three-way+CAS는 자기 점수(cheap-hint 78 vs full 63)를 거스른 over-engineering.** three-way 실동작 ≈ cheap-hint(base 대부분 evict → 세 번째 분기로 항상 degrade), 경쟁사 0곳이 stale-edit auto-merge 안 함(Claude Code/Aider/OpenHands 전부 실패→conflict/재시도).
- **다운스코프 결정: V-lane v1 = cheap-hint(RFC 03)만** — 편집실패 시 국소 diff 힌트(`old_string` 앵커, `renderUnified` 재사용, default-OFF, A/B). RevisionStore/CAS/three-way 전부 Phase-2 이후로.
- **진짜 SOTA 격차 = LCS→histogram diff.** 현 `diff-ops.ts`는 Hunt-McIlroy LCS(코드에서 `}`·빈줄 앵커 오정렬 → non-overlap 게이트를 vacuous하게). histogram 교체가 V-lane에서 가장 값싸고 확실한 SOTA 상승(three-way 하든 안 하든 전제). **V-lane과 독립 slice로 우선.**
- three-way를 하게 되면: `documentRevision` = **raw on-disk bytes** sha256(정규화는 fuzzy ladder 내부만) 명시, non-overlap 판정은 histogram 위에서, `ConflictHunk`는 기존 `src/git/conflict-parser.ts` `parseConflicts` 위에 정렬(SSOT 2개 금지).
- **§12 기각 추가**: AST/tree-sitter structural merge(단일에이전트 빈도 대비 grammar 유지비 과다, git merge-ort도 line) · OT/CRDT(concurrent-convergence 도구인데 우리 문제는 sequential stale-recovery, CAS 직렬화가 correct).

### 0.6 효능 게이트 (§11.1) — Phase 2 착수 차단조건
- 현 §11 매트릭스 17행 전부 mechanism 검증(outcome 0). Phase 2 진입 전 baseline 측정: (a) orphan/leaked process가 실패·stuck 세션 몇 %를 유발하는지(trajectory 스캔), (b) stale-edit fail-closed가 실 fail taxonomy에서 차지하는 비중. 무의미하면 해당 lane CUT.

---

## 1. 결정 요약

세 초안이 해결하려는 문제는 하나의 observability 기능이 아니다. 서로 다른 세
correctness 문제이며, 각각 독립된 owner primitive로 해결한다.

| 문제 | 최종 primitive | 보장 |
|---|---|---|
| agent가 만든 process/resource가 남음 | `ResourceScope` | scope 종료가 descendant terminal/reaped까지 await |
| async 상태머신이 특정 순서에서 깨짐 | `SimulationKernel` | time/random/timer/scheduler/fault를 결정론적으로 탐색·재생 |
| 모델이 읽은 뒤 파일이 바뀜 | `VersionedWorkspace` | base revision 기준 apply/three-way/conflict를 fail-closed 처리 |

최종 결정:

1. 전역 `kill()` 함수나 문자열 grep을 아키텍처 중심으로 삼지 않는다.
2. `spawn`은 반드시 owner scope에 resource를 등록하고, `close()`는 terminal receipt를
   반환한다.
3. Linux cgroup / POSIX process group / Windows Job Object를 우선 containment로 사용하고,
   현재 ppid walk는 portable fallback으로 유지한다.
4. 수제 seeded loop가 아니라 reference model + controlled scheduler + shrinking/replay를
   갖춘 model-based deterministic simulation을 사용한다.
5. edit 복구는 임의 neighborhood 합성 diff가 아니라 content-addressed base revision과
   true three-way 비교를 사용한다.
6. snapshot이 없거나 후보가 ambiguous하면 자동 remap하지 않는다. 현재 context만
   구조화해 반환하고 write는 수행하지 않는다.
7. observability는 세 primitive의 receipt/event를 기록하는 공통 결과이지 correctness의
   대체물이 아니다.

---

## 2. 현재 코드가 증명하는 문제

### 2.1 Resource lifecycle

- `src/host/runtime/side-agent-fork-port.ts:75-82`의 `kill(): void`는
  `cp.kill("SIGTERM")`만 호출한다. completion/reap을 await하지 않고 descendant
  containment도 없다.
- `src/runtime/guarded-spawn.ts:112-175`에는 SIGTERM→SIGKILL escalation과 reaped latch가
  이미 있다. 새 escalation 알고리즘이 아니라 owner 계약이 빠진 상태다.
- `src/runtime/process-tree.ts:91-122`의 두-snapshot ppid walk는 race를 줄이는 fallback이다.
  process group/cgroup보다 강한 containment로 간주하지 않는다.
- `tests/unit/runtime/single-pid-kill-ban-hellgate.test.ts`는 이미 one-arg
  `escalatingKill(proc)`를 막는다. 따라서 audit 부재가 아니라 **부분 audit** 상태다.
- 2026-07-12 targeted rail은 23/23 pass였지만 종료 후 삭제된 temp worker를 재spawn하려는
  `Module not found ...valid-then-kill.mjs`가 출력됐다. 테스트가 registry를 terminal까지
  close하지 않은 직접 증거이며 production descendant leak 자체의 증명과는 구분한다.

### 2.2 Async state machines

- `bash-bg-registry`는 cap/eviction/terminal/abort/timer가 결합된 상태머신이다.
- 현재 crafted tests는 개별 경로를 검증하지만 Promise continuation, timer, late exit,
  abort, eviction의 실행 순서를 systematic하게 탐색하지 않는다.
- `ClockPort.now()`만 fake로 바꿔도 `guarded-spawn.ts`의 실제 `setTimeout`은 제어되지 않는다.
  현재 초안의 injected clock만으로는 deterministic timer test가 성립하지 않는다.

### 2.3 Edit recovery

- `expected_hash`, mtime guard, exact/fuzzy content match는 write safety를 제공한다.
- `stale_read` 검사 시 `planned.before`는 caller frame에 있지만 guard는 `statFile()`만 하고
  current bytes를 보유하지 않는다.
- `stale_precondition`은 파일의 unrelated region만 바뀌어도 실패할 수 있다. `old_string`
  대 임의 current neighborhood를 “changed lines”로 표시하면 거짓 locality가 된다.
- `@/tool`은 `src/apps/cli/diff-preview.ts`를 import할 수 없다. 기존 초안의 직접 재사용은
  repo slice fence 위반이다.

---

## 3. 목표와 비목표

### 3.1 목표

- **G1 — ownership**: 생성된 모든 managed resource는 정확히 하나의 live scope owner를 가진다.
- **G2 — terminal close**: scope close 반환 시 child process는 terminal/reaped이고 pending
  cleanup work가 없다.
- **G3 — containment**: descendant 생성 race를 userspace PID 추측이 아니라 OS containment로
  우선 차단한다.
- **G4 — deterministic proof**: 동일 seed/path/schedule은 동일 trace와 verdict를 생성한다.
- **G5 — model oracle**: implementation과 독립된 축약 reference model을 기준으로 검증한다.
- **G6 — minimal counterexample**: 실패 trace는 shrink되고 그대로 replay 가능하다.
- **G7 — versioned edit**: edit는 모델이 읽은 base revision을 식별한다.
- **G8 — fail-closed conflict**: unique safe apply를 증명하지 못하면 write하지 않는다.
- **G9 — bounded feedback**: conflict는 machine-readable candidate/hunk로 반환하고 standing
  read-token tax를 추가하지 않는다.
- **G10 — honest telemetry**: stop/edit/simulation 결과는 typed receipt로 기록되며 throw를
  success로 바꾸지 않는다.

### 3.2 비목표

- 모든 `src/**/.kill()`을 한 PR에서 수렴시키지 않는다.
- ppid walk를 삭제하지 않는다. containment 미지원 환경의 fallback으로 남긴다.
- exhaustive model checking을 주장하지 않는다. bounded generated trace와 controlled
  schedules로 탐색하고 범위를 report한다.
- line-hash prefix를 모든 read line에 추가하지 않는다.
- ambiguous edit를 similarity score만으로 자동 적용하지 않는다.
- cleanup/telemetry 실패를 원래 agent error와 합쳐 원인을 잃지 않는다.
- recorder를 process supervisor의 authority로 만들지 않는다. recorder는 observer다.

---

## 4. 최종 아키텍처

```text
Agent / Host composition
├─ ResourceScope
│  └─ ManagedProcessPort
│     └─ ProcessContainmentPort
│        ├─ LinuxCgroupAdapter
│        ├─ PosixProcessGroupAdapter
│        ├─ WindowsJobObjectAdapter
│        └─ PpidWalkFallback
├─ SimulationKernel                         test-only composition
│  ├─ ClockPort / TimerPort
│  ├─ SchedulerPort / RandomPort
│  ├─ ProcessSimulationPort
│  └─ Reference models + command generators
└─ VersionedWorkspace
   ├─ RevisionStore                         session-scoped bounded CAS
   ├─ VersionedReadPort
   ├─ VersionedEditPort
   └─ TextMergeCore                         pure, surface-agnostic
```

Owner 규칙:

- `ResourceScope`가 lifecycle authority다.
- platform adapter만 OS destruction effect를 소유한다.
- `SimulationKernel`은 production authority가 아니라 production과 같은 ports를 구현하는
  test composition이다.
- `VersionedWorkspace`가 revision/apply/conflict authority다.
- CLI/web/bench는 typed result를 render할 뿐 lifecycle/edit semantics를 소유하지 않는다.

---

## 5. Primitive A — ResourceScope

### 5.1 계약

```ts
type StopCause =
  | "abort"
  | "timeout"
  | "evict"
  | "shutdown"
  | "reconcile_lost"
  | "owner_failed"

interface ProcessIdentity {
  readonly pid: number
  readonly generation: string
  readonly containmentId: string
}

interface StopReceipt {
  readonly identity: ProcessIdentity
  readonly cause: StopCause
  readonly terminal: boolean
  readonly reaped: boolean
  readonly escalated: boolean
  readonly remainingMembers: number
  readonly errors: readonly ResourceCleanupError[]
}

interface ManagedProcessHandle {
  readonly identity: ProcessIdentity
  readonly exited: Promise<ProcessExit>
  stop(cause: StopCause): Promise<StopReceipt>
}

interface ResourceScope {
  spawn(spec: ManagedProcessSpec): Promise<ManagedProcessHandle>
  close(cause: StopCause): Promise<ScopeCloseReceipt>
}
```

`generation`은 PID 단독 identity를 금지한다. platform이 제공하는 start token, pidfd,
process handle 또는 scope-local nonce와 spawn receipt를 결합한다. delayed escalation이
재사용된 PID에 전달되지 않아야 한다.

### 5.2 상태머신

```text
scope: OPEN ──close──> CLOSING ──all receipts──> CLOSED

process: RUNNING
  ├─ natural exit ────────────────────────────> REAPED
  └─ stop ─> TERM_SENT ─┬─ exit ─────────────> REAPED
                        └─ grace expiry ─> KILL_SENT ─> REAPED | CLEANUP_FAILED
```

보장:

- `close()` 중 새 `spawn()`은 typed `scope_closing` deny다.
- 동일 resource의 concurrent `stop()`은 하나의 in-flight promise를 공유한다.
- `close()`는 reverse registration order로 cleanup을 시작하되 독립 resource의 await는
  bounded concurrency로 수행할 수 있다.
- cleanup error는 receipt에 보존한다. primary failure를 덮지 않는다.
- `terminal:false` 또는 `remainingMembers>0`이면 close는 green이 아니다.

### 5.3 Platform containment

| 플랫폼 | primary | graceful phase | hard phase |
|---|---|---|---|
| Linux | dedicated cgroup v2 | members에 SIGTERM | `cgroup.kill` |
| macOS/POSIX | dedicated process group/session | group SIGTERM | group SIGKILL |
| Windows | Job Object | cooperative shutdown/CTRL event when available | terminate Job Object |
| fallback | ppid snapshot walk | tree SIGTERM | second tree SIGKILL |

side-agent는 IPC channel 때문에 `shutdown` message를 먼저 보낼 수 있지만, 그것은 stop의
graceful hint이지 cleanup completion 증거가 아니다.

### 5.4 Effect fence

문자열 grep을 도입하지 않는다. TypeScript AST scanner가 다음 direct effects를 찾는다.

- `process.kill(...)`
- Node/Bun `ChildProcess.kill(...)`
- platform adapter의 raw terminate APIs

규칙:

- `signal === 0`인 liveness probe는 별도 `ProcessLivenessPort` owner로 분류한다.
- destruction effect는 platform adapter 파일에서만 허용한다.
- library/host caller는 `ManagedProcessHandle.stop` 또는 `ResourceScope.close`만 호출한다.
- alias/computed access 때문에 syntax-only 판정이 불가능하면 명시적 imported capability를
  기준으로 검사한다.
- 예외는 파일 allowlist가 아니라 좁은 adapter capability 선언으로 남긴다.

기존 `single-pid-kill-ban-hellgate`는 새 AST rule이 동일 위반을 잡는 것이 증명된 후 제거하거나
AST scanner의 regression case로 흡수한다. 두 SSOT를 유지하지 않는다.

### 5.5 Proof rail

첫 RED는 source grep이 아니라 real OS behavior다.

1. side-agent child가 TERM을 trap한다.
2. child가 별도 grandchild를 spawn하고 grandchild도 TERM을 trap한다.
3. `scope.close("shutdown")`을 호출한다.
4. close 반환 뒤 child/grandchild 모두 identity 기준 dead/reaped임을 검증한다.
5. port/lock/IPC channel과 pending escalation timer가 0임을 검증한다.

필수 paired controls:

- natural exit는 SIGKILL을 보내지 않는다.
- duplicate stop은 signal sequence를 중복하지 않는다.
- PID/generation mismatch는 signal하지 않고 cleanup error를 반환한다.
- containment setup 실패는 몰래 ppid fallback하지 않는다. fallback 선택을 receipt/event에
  기록하고 policy가 허용한 경우에만 degrade한다.

---

## 6. Primitive B — SimulationKernel

### 6.1 계약

Production의 nondeterminism을 다음 ports 뒤로 이동한다.

```ts
interface TimerPort {
  schedule(delayMs: number, task: () => void): TimerHandle
  cancel(handle: TimerHandle): void
}

interface SchedulerPort {
  enqueue(label: string, task: () => Promise<void> | void): void
}

interface SimulationKernel {
  readonly clock: ClockPort
  readonly timers: TimerPort
  readonly scheduler: SchedulerPort
  readonly random: RandomPort
  readonly processes: ProcessSimulationPort
}
```

`escalatingKill`은 global `setTimeout/clearTimeout`을 직접 소유하지 않고 `TimerPort`를 받는다.
production default adapter는 현재 semantics를 보존하고 tests는 virtual timer를 주입한다.

### 6.2 Model-based testing

`fast-check`를 pinned dev dependency로 도입해 다음 기능을 사용한다.

- `commands` / `asyncModelRun`
- controlled async scheduling (`scheduledModelRun` 또는 동등 scheduler integration)
- seed + path + replayPath
- automatic command-trace shrinking

도입 전 Bun runner compatibility owner test를 통과해야 한다. 호환되지 않으면 custom PRNG만
사용하는 것으로 후퇴하지 않는다. 동일한 command shrinking/replay/scheduler 계약을 제공하는
repo-local adapter가 대체 조건이다.

reference model은 implementation의 Map/status logic을 복사하지 않는다. 최소 상태만 가진다.

```ts
interface BgRegistryModel {
  readonly capacity: number
  readonly handles: ReadonlyMap<HandleId, "running" | "terminal">
  readonly pendingTimers: ReadonlySet<TimerId>
  readonly pendingWaiters: ReadonlySet<WaiterId>
}
```

생성 command:

- `register`, `adopt`, `emitChunk`, `exit`
- `awaitHandle`, `timeoutWaiter`
- `kill`, `killAll`, `abort`
- `overflow`, `deliverLateExit`
- `throwFromNotifier`, `advanceTime`, `runNextScheduled`

각 command는 model precondition, real action, model transition, assertions, stable `toString()`을
가진다.

### 6.3 불변식

1. **capacity**: 모든 observable boundary에서 live registry size ≤ capacity.
2. **conservation**: created handle은 정확히 live/terminal/evicted 중 하나이며 유실·중복되지 않는다.
3. **terminal monotonicity**: terminal 이후 running으로 돌아가지 않는다.
4. **effect bounds**: process generation당 TERM ≤ 1, SIGKILL ≤ 1, reap receipt ≤ 1.
5. **resource quiescence**: terminal run 뒤 pending timer/waiter/listener/process가 0이다.
6. **late-event idempotence**: duplicate exit/abort/kill이 state와 receipts를 중복시키지 않는다.
7. **error containment**: notifier/drain throw가 다른 handle의 cleanup과 scheduler를 중단하지 않는다.
8. **determinism**: 동일 seed/path/schedule의 trace와 final snapshot이 동일하다.

`exactly-once-disarm` callback count는 invariant로 사용하지 않는다. timer가 정상 fire하면
clear가 0회여도 올바르다. 검증 대상은 pending timer 0, hard signal 상한, terminal 이후
re-arm 부재다.

### 6.4 Quiescence

magic iteration cap으로 semantic completion을 판정하지 않는다.

```text
quiescent = runnable queue empty
         && virtual timer queue empty
         && all model resources terminal
         && no pending waiter/listener/process
```

- virtual scheduler가 runnable event를 하나씩 소비한다.
- `(model snapshot, pending event multiset)`가 반복되면 deterministic cycle/livelock RED다.
- 별도 wall-clock watchdog은 CI process 보호용이다. semantic success 조건으로 사용하지 않는다.
- global `process.on("unhandledRejection")` observer를 parallel test에 설치하지 않는다. isolated
  harness 또는 owned promise ledger로 검증한다.

### 6.5 CI tiers

| tier | 실행 | 목적 |
|---|---|---|
| PR | fixed regression corpus + bounded generated cases | 빠른 결정론 gate |
| merge | 더 넓은 seeds/schedules | schedule coverage |
| nightly | rotating seeds + mutation batch | 새 counterexample 탐색 |

실패 artifact에는 seed/path/replayPath, shrunk command trace, model snapshot, real snapshot,
pending event ledger를 저장한다. 발견된 최소 trace는 crafted regression corpus로 승격한다.

필수 mutations:

- eviction off-by-one
- terminal status guard 제거
- timer re-arm guard 제거
- registry delete 누락
- late exit 두 번 반영
- notifier throw가 cleanup을 중단하도록 변조

최소 3개가 아니라 위 owner failure classes 모두 RED여야 한다.

---

## 7. Primitive C — VersionedWorkspace

### 7.1 계약

read 결과에 content-addressed revision을 제공한다.

```ts
interface VersionedReadResult {
  readonly path: string
  readonly documentRevision: string // sha256 of the full file bytes used for this read
  readonly visibleRange: LineRange
  readonly visibleContent: string // exact bytes shown to the model for visibleRange
}

interface VersionedEditRequest {
  readonly path: string
  readonly baseRevision: string // prior documentRevision, never a partial-range hash
  readonly oldString: string
  readonly newString: string
  readonly lineRanges?: readonly LineRange[]
}
```

`documentRevision`은 partial read의 출력 hash가 아니다. read가 range만 모델에 보여줘도 해당
range를 산출한 **전체 파일 bytes**의 revision이다. 그래야 edit 시 current full-file revision과
비교하고 true three-way base를 복원할 수 있다.

session-scoped `RevisionStore`는 `documentRevision -> immutable full-file bytes` CAS다.

- 동일 full-file content는 한 번만 저장한다.
- budget은 injected session policy가 소유한다.
- eviction은 observable이며 correctness를 바꾸지 않는다. snapshot miss는 fail-closed conflict
  feedback으로 degrade한다.
- secret/redaction policy는 기존 read result와 동일하다. recorder/metrics에 file bytes를 넣지 않는다.

기존 `expected_hash`는 migration 기간에 `baseRevision` alias로 수용할 수 있지만 SSOT는 하나다.

### 7.2 Apply algorithm

```text
baseRevision == currentRevision
  └─ exact/fuzzy ladder under existing uniqueness rules

baseRevision != currentRevision AND base snapshot exists
  └─ base / intended / current three-way analysis
       ├─ unique, non-overlapping safe mapping → apply
       └─ overlap or ambiguity → no write + EditConflict

baseRevision != currentRevision AND base snapshot missing
  └─ no write + current candidate contexts only
```

세 입력:

- `base`: 모델이 실제로 읽은 bytes
- `intended`: base에 `oldString -> newString`을 적용한 bytes
- `current`: commit 직전 다시 읽은 bytes

자동 적용 조건은 모두 만족해야 한다.

1. base에서 edit target이 기존 uniqueness/range 계약을 만족한다.
2. base→current 변화와 base→intended 변화가 target semantics에서 overlap하지 않는다.
3. current에서 mapping된 target이 정확히 하나다.
4. commit 직전 current revision compare-and-swap가 다시 일치한다.

하나라도 실패하면 conflict다. similarity score만으로 write하지 않는다.

### 7.3 Conflict contract

```ts
interface EditConflict {
  readonly mode: "edit_conflict"
  readonly path: string
  readonly baseRevision: string
  readonly currentRevision: string
  readonly reason:
    | "base_snapshot_missing"
    | "target_changed"
    | "ambiguous_mapping"
    | "commit_raced"
  readonly candidates: readonly EditCandidate[]
  readonly hunks: readonly ConflictHunk[]
}
```

규칙:

- snapshot이 없으면 `hunks`는 비고 current candidate context만 제공한다.
- unrelated file change로 hash가 달라졌는데 target이 동일하면 “target changed”라고 표시하지 않는다.
- candidate가 여러 개면 first match를 선택하지 않는다. 모든 bounded spans 또는 omitted-count를
  반환한다.
- model-facing prose는 typed conflict에서 render한다. prose sniffing이 authority가 아니다.
- output cap은 line 수 추측이 아니라 injected output budget에 맞춰 deterministic truncation한다.

### 7.4 Pure diff/merge owner

`@/tool -> src/apps/cli/diff-preview.ts` import는 금지한다.

구현 시 `src/runner/diff-ops.ts`의 surface-agnostic core를 `src/shared/text-diff/`로 추출한다.

- `@/shared/text-diff`: pure diff/hunk/three-way primitives
- runner: compatibility re-export 후 점진 이동
- CLI: ANSI/text renderer만 소유
- tool: typed conflict 생성과 bounded plain renderer만 소유

알고리즘 SSOT는 shared pure core 하나이며 CLI formatting은 별도다.

### 7.5 Measurement gate

default-ON 전 먼저 correlation 가능한 metric rail을 만든다.

한 edit attempt chain을 `sessionId + turn + pathHash + attemptChainId`로 묶고 다음을 기록한다.

- failure mode
- 다음 action이 same-path read였는지
- N회 이내 edit success 여부
- conflict output tokens
- 후속 read tokens
- wrong-location/ambiguous auto-apply 0 여부

비교 지표:

1. failed edit 이후 successful edit까지의 tool calls
2. same-path reread rate
3. tokens per successful edit recovery
4. conflict 이후 wrong-write/revert rate

rollout:

- typed conflict generation은 opt-in shadow에서 기존 output과 함께 내부 비교하되 모델에는 노출하지 않는다.
- shadow correctness가 green이면 model-facing hint A/B를 연다.
- success 개선 없이 token 또는 wrong-write가 증가하면 model-facing rollout을 중단한다.
- safety gate와 quality A/B를 혼합하지 않는다. CAS/fail-closed는 safety, hint prose는 quality다.

---

## 8. 공통 observability

세 primitive가 typed events를 emit한다.

```ts
type RuntimeCorrectnessEvent =
  | ResourceStopStarted
  | ResourceSignalSent
  | ResourceStopCompleted
  | ResourceCleanupFailed
  | SimulationCounterexample
  | EditConflictDetected
  | EditThreeWayApplied
```

event 규칙:

- correlation ID, categorical cause/result, duration, counts만 recorder/metrics에 보낸다.
- command line, environment, file bytes, diff body는 telemetry에 넣지 않는다.
- detailed conflict/cleanup artifact는 session-owned artifact store를 사용한다.
- observer throw는 owner operation을 중단하지 않지만 receipt에 observer failure를 success로 섞지 않는다.
- event emission 여부로 cleanup/edit success를 판정하지 않는다.

---

## 9. 구현 slices

### Slice R0 — proof rail cleanup

Owner:

- `tests/integration/side-agent-ipc-kill-mid-result-e2e.test.ts`

작업:

- 모든 registry를 `afterEach`에서 terminal까지 stop/await한다.
- 삭제된 temp module에 post-test respawn이 없는지 pin한다.
- 테스트 runner 종료 시 owned child/timer ledger가 0인지 검증한다.

Exit:

- targeted rail 0 fail, post-test stderr 0, lingering owned process 0.

### Slice R1 — side-agent ResourceScope

Owner:

- `src/host/runtime/side-agent-fork-port.ts`
- `src/side-agent/process.ts`
- 신규 `src/host/runtime/resource-scope/`

작업:

- real descendant-leak RED E2E.
- `kill(): void`를 awaitable managed stop 계약으로 migration.
- POSIX process group adapter 우선 구현; ppid walk fallback을 explicit receipt로 노출.
- side-agent supervisor/registry stop과 teardown을 terminal await로 변경.

Exit:

- TERM-trapping child/grandchild 모두 reaped.
- duplicate stop signal 중복 0.
- scope close 후 pending resource 0.

### Slice R2 — destruction effect fence

Owner:

- `tests/unit/_arch/` scanner infrastructure
- platform adapter declarations

작업:

- AST/capability-based raw destruction detector.
- liveness probe와 destruction 분리.
- 기존 source ratchet을 단일 AST SSOT로 흡수.

Exit:

- comments/strings/probes false positive 0.
- alias/direct raw kill mutations RED.
- allowlist가 아니라 좁은 adapter capability만 존재.

### Slice S1 — deterministic timer/scheduler seam

Owner:

- `src/runtime/guarded-spawn.ts`
- `src/runtime/bash-bg-registry.ts`
- test-support simulation ports

작업:

- `TimerPort`/`SchedulerPort` 주입.
- production default behavior parity tests.
- virtual event/timer ledger와 quiescence 정의.

Exit:

- owner tests에 real-time sleep 0.
- same schedule replay snapshot identical.

### Slice S2 — model-based chaos rail

Owner:

- `tests/unit/runtime/bash-bg-registry-model.test.ts`
- `tests/test-support/simulation/`

작업:

- fast-check compatibility/pinned dependency.
- independent model/commands/shrinking/replay.
- 전체 mutation matrix.

Exit:

- 모든 §6.3 invariant green.
- 모든 §6.5 mutation RED.
- shrunk trace replay green-after-fix.

### Slice V1 — revision CAS and versioned read

Owner:

- `src/tool/read/`
- 신규 session-scoped revision-store port/adapter

작업:

- exact returned bytes의 revision 제공.
- bounded content-addressed snapshot store.
- eviction/miss semantics.

Exit:

- same bytes dedup.
- revision resolves exact base bytes or typed miss.
- telemetry content leak 0.

### Slice V2 — three-way edit and typed conflict

Owner:

- `src/tool/edit/`
- `src/shared/text-diff/`
- `src/runner/diff-ops.ts` compatibility surface

작업:

- base/intended/current analysis.
- compare-and-swap commit.
- typed conflict/candidates/hunks.
- CLI diff core 역수입 없이 renderer 분리.

Exit:

- non-overlapping concurrent edit auto-applies.
- overlapping/ambiguous/raced edit writes 0 bytes.
- snapshot-miss output never claims changed lines.

### Slice V3 — shadow measurement and rollout

Owner:

- tool instrumentation composition
- eval/trajectory analyzer

Exit:

- correlated recovery metrics exist.
- shadow false-locality 0.
- model-facing default decision has measured report.

---

## 10. 의존성과 실행 순서

```text
R0 → R1 → R2
      │
      └──────┐
             v
            S1 → S2

V1 → V2 → V3
```

- R0/R1이 첫 우선순위다. 현재 실 lifecycle gap을 닫는다.
- R2는 R1의 실제 owner 계약이 생긴 뒤 강제한다. 잘못된 구조를 grep으로 먼저 동결하지 않는다.
- S1은 R1의 timer/stop state machine을 deterministic하게 검증할 seam을 제공한다.
- V lane은 resource lane과 코드상 독립이지만, implementation concurrency는 현재 repo lane
  정책과 verifier ownership을 따른다.
- V3 이전에 remap hint를 default-ON하지 않는다.

---

## 11. 통합 acceptance matrix

| ID | 시나리오 | 기대 결과 | proof |
|---|---|---|---|
| R-A1 | TERM-trapping grandchild | scope close 후 child tree 0 | real OS E2E |
| R-A2 | duplicate concurrent stop | shared receipt, signal 중복 0 | deterministic unit |
| R-A3 | PID generation mismatch | unrelated process signal 0 | fault injection |
| R-A4 | containment adapter 실패 | explicit failure/degrade receipt | adapter test |
| S-A1 | eviction/exit/kill permutation | cap·terminal invariant | model commands |
| S-A2 | timer re-arm mutation | pending/effect invariant RED | mutation |
| S-A3 | late duplicate exit | receipt/state 중복 0 | scheduled model |
| S-A4 | livelock | repeated state+event cycle RED | virtual scheduler |
| V-A1 | unrelated concurrent edit | safe three-way apply | unit + integration |
| V-A2 | target overlapping edit | no write + conflict | integration |
| V-A3 | duplicate candidates | no arbitrary first-match | property test |
| V-A4 | base snapshot evicted | no changed-lines claim | typed contract |
| V-A5 | commit race after analysis | CAS reject, no clobber | fault injection |
| O-A1 | observer throw | owner verdict preserved | no-throw observer test |
| O-A2 | telemetry payload | process args/file bytes absent | schema audit |

프로그램 closeout은 위 matrix 전체가 current HEAD에서 green이고, mutation/fault rows의 RED
evidence가 보존된 경우만 가능하다.

---

## 12. 기각한 방향

- **전역 문자열 grep allowlist**: semantic distinction이 없고 tech debt를 allowlist로 정상화한다.
- **ppid walk 최상위화**: portable fallback이지 kernel containment가 아니다.
- **`kill(): void` 유지**: signal delivery와 terminal cleanup을 혼동한다.
- **수제 xorshift loop만 사용**: model/shrink/scheduler coverage가 없다.
- **무한 quiesce loop**: livelock이 CI hang으로 바뀐다.
- **global unhandledRejection observer**: parallel test ownership을 깨뜨린다.
- **CLI diff renderer의 tool 역수입**: slice fence 위반이다.
- **`old_string` 대 임의 neighborhood 합성 diff**: deterministic이어도 거짓 locality가 가능하다.
- **full hashline read format**: 기존 revision/hash safety와 중복되고 standing token tax가 있다.
- **similarity-only auto-remap**: ambiguous write를 fail-open한다.
- **관측 이벤트를 lifecycle authority로 사용**: recorder loss가 cleanup semantics를 바꾸게 된다.

---

## 13. 상태 보드

| Slice | 상태 | 코드 | proof | 차단 조건 |
|---|---|---|---|---|
| R0 proof cleanup | TODO | 없음 | noisy post-test respawn 관찰 | 없음 |
| R1 ResourceScope | TODO | 없음 | real descendant RED 필요 | R0 |
| R2 effect fence | TODO | 기존 partial regex gate만 존재 | AST mutation 필요 | R1 |
| S1 deterministic seams | TODO | partial clock/kill seams | timer/scheduler proof 필요 | R1 |
| S2 model rail | TODO | 없음 | model/shrink/replay 필요 | S1 |
| V1 revision CAS | TODO | expected_hash/read state 일부 | snapshot contract 필요 | 없음 |
| V2 three-way edit | TODO | exact/fuzzy ladder만 존재 | conflict matrix 필요 | V1 |
| V3 rollout | TODO | generic tool metrics 일부 | correlated A/B rail 필요 | V2 |

이 문서가 final design이라는 것은 구현 완료를 뜻하지 않는다. 상태 보드의 `TODO`를 문서 점수나
historical green으로 승격하지 않는다.

---

## 14. 조사 문서와의 관계

- `01-destruction-port-single-writer.md`: raw kill 분산과 side-agent gap 조사 근거.
- `02-chaos-property-testing.md`: bg registry failure classes와 seeded test 후보 조사 근거.
- `03-hashline-remap-selfcorrect.md`: standing token tax와 mismatch feedback 후보 조사 근거.

위 문서의 점수·구현 순서·강도 주장이 이 RFC와 충돌하면 이 RFC를 따른다.
