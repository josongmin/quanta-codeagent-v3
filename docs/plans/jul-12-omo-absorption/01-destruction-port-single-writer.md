# jul-12 — single-writer 프로세스-파괴 포트 + 정적감사 테스트 (OmO 흡수)

North-star: **agent-state observability**. Constraints (hard): no duplicate
implementation, no cheap heuristics, hellgate protocol (RED→green→adversarial ≥3R).
measure-first — EXCEPT: leak/orphan-fix은 correctness class라 A/B 없이 **red-on-injection**
증명이면 랜딩 자격(효능 벤치 대기 불필요; "죽어야 할 프로세스가 안 죽음"은 측정갭이 아니라 버그).

흡수원(OmO): `/tmp/oh-my-openagent/packages/senpi-task/src/lifecycle/{destroy.ts,port.ts}`
+ `single-writer-audit.test.ts`. 두 축을 흡수한다 — (a) dispose/terminate/OS-kill을
**단 하나의 함수**만 호출(single-writer 포트, cancel/evict/ttl/shutdown/reconcile가 전부 여길
경유), (b) 패키지 소스 전체를 grep해서 allowlist 밖의 파일이 `.dispose(`/`.terminate(`/
`process.kill(`를 호출하면 **red**로 떨어지는 정적감사 테스트 — 규율을 문서가 아니라 CI로 집행.
그들의 detached + `process.kill(-pid)` group-kill(`lsp-core/src/lsp/process.ts:99-106`)은
우리가 이미 능가하므로 **흡수 안 함**(§NOT).

---

## 현황 (증거 기반)

**우리가 이미 가진 것 (mechanism-equal-or-better):**

- `ProcessTreeKiller` / ppid-walk — `src/runtime/process-tree.ts:91-122`. `ps -A -o
  pid=,ppid=` 두-스냅샷 race-min BFS, no-throw + idempotent(`safeSend`
  `process-tree.ts:94-100`). 공유 call-site 8개: `src/runtime/{shell,sandbox,bash-bg-registry,index}.ts`,
  `src/host/runtime/pty-backend.ts`, `src/runner/batch/eval/exec.ts`,
  `src/agent/lsp-bridge/servers.ts`, `src/agent/command-hooks/sandbox-exec.ts`
  (grep `defaultPpidWalkKiller|PTY_TREE_KILLER`). OmO는 group-kill 하나뿐, tree-walk 없음.
- `escalatingKill` — `src/runtime/guarded-spawn.ts:112-175`. OmO의 **고정 5s delay**
  (`destroy.ts:57` `orphanKillDelayMs` default 5s, `port.ts:47-48`)보다 정교:
  SIGTERM→SIGKILL 2s escalation(`guarded-spawn.ts:55,162-169`), `proc.exited` 조기 disarm
  (`:151`), **recycled-pid latch**(`reaped` 래치가 2s 뒤 재사용된 pid에 SIGKILL 쏘는 것 방지,
  `:146-154`), **`pid > 0` guard**(`signalTree(0)`=caller 프로세스그룹 자살 방지, `:116-121`).
- exec 경로 tree-kill — `src/runner/batch/eval/exec.ts:40-57` `armTreeKillTimeout`
  (SIGTERM→SIGKILL, bench pytest 트리 reap).
- crash-safe recorder(ADR-0539) — `docs/decisions/0539-tracing-observability-architecture.md`,
  `src/stream/adapters/jsonl-recorder.ts` (correlation `{runId,...}` `EMPTY_CTX` `:25`,
  turn-boundary flush + 시그널 tail-save `:32`). #3의 sink 후보로 이미 존재.

**갭 (증거):**

1. **single-writer 집행 없음.** kill 호출이 src/ 전역에 ~60+개 산재
   (grep `\.kill\(|process\.kill|signalTree`). 어떤 CI 게이트도 "새 파일이 raw
   `proc.kill()`을 추가했다"를 잡지 못함 — OmO의 audit-test가 정확히 이걸 막음.
2. **side-agent-fork 누수 (이 RFC가 고치는 구체적 버그).**
   `src/host/runtime/side-agent-fork-port.ts:75-82` `kill()`은
   `cp.kill("SIGTERM")` **단발** — tree-kill 없음, escalation 없음. `node:child_process
   fork`(`:87-98`, `serialization:"advanced"`, ipc)로 띄운 side-agent가 자식 트리를
   포크하면 SIGTERM 무시/trap 시 살아남고, 손자는 init로 reparent되어 leak. 우리
   `escalatingKill`이 있는데 이 포트만 우회.
3. **kill 감사흔적 없음.** OmO는 모든 teardown을 `appendEvent(taskId, {type:
   "reconcile_terminated", payload:{pid,signal}})`로 기록(`destroy.ts:56,60,69`).
   우리는 kill을 쏘지만 `{pid,signal,cause,ts}`를 recorder로 남기지 않음 → "왜 이 프로세스가
   죽었나"가 trajectory에서 불가시(agent-state observability 북극성에 직결).
4. **원격 박스 orphan reconcile이 shell-only.** `tools/campaign-generic.sh:63`
   `kill -0 "$p" || harvest` — supervisor 쉘 레벨에만 존재. TS box-session 레이어
   (`src/apps/bench/remote/box-session/shell.ts`, `lease-fs.ts:23` `process.kill(pid,0)`)엔
   구조화된 reconcile 포트가 없음.

---

## 제안 (IMPLEMENT, ROI 순)

### #1 (S) — single-writer 정적감사 테스트 이식 【최고 ROI】

OmO `single-writer-audit.test.ts`를 우리 레이아웃에 이식. src/ 재귀 grep, allowlist 밖
파일이 `.dispose(`/`.terminate(`/`process.kill(`/`\.kill\(`를 호출하면 red. **side-agent-fork:78을
즉시 잡고**(현재 allowlist 밖) + 미래 누락을 영구 차단. 코드 0줄 프로덕션 변경, 순수 게이트.

- 패턴: `FORBIDDEN = [".dispose(", ".terminate(", "process.kill(", ".kill("]`
  (OmO는 앞 3개; 우리는 `.kill(` 포함해 raw single-shot도 잡음 — 단 `signalTree` 경유는 허용).
- allowlist(= kill을 **소유**하는 파일, 각 파일이 tree-kill/escalation SSOT를 경유하거나
  그것을 정의):
  ```
  src/runtime/process-tree.ts          # 유일한 process.kill effect 어댑터
  src/runtime/guarded-spawn.ts         # escalatingKill SSOT
  src/runtime/bash-bg-registry.ts      # tree-killer 주입 소비
  src/runtime/shell.ts / sandbox.ts    # tree-killer 주입 소비
  src/host/runtime/pty-backend.ts      # PTY_TREE_KILLER 소유
  src/runner/batch/eval/exec.ts        # armTreeKillTimeout (bench tree)
  src/plugin-isolation/{bun-spawner,plugin-host}.ts  # 격리호스트 escalation 이미 보유
  src/lsp/adapters/base.ts             # LSP signalTree 포트
  src/agent/subagent-persistence-store/hydrating-scheduler.ts  # kill(pid,0) liveness probe만
  src/migration/persistence.ts / src/apps/bench/remote/lease-fs.ts  # kill(pid,0) probe만
  ```
  나머지(voice/browser/mcp/git-runner/debug/cli 등 `\.kill\(` 산재 사이트)는 **audit가
  드러낸 tech-debt** — #2에서 순차 route하거나, 명시적 이유와 함께 allowlist에 등재.
  초기 allowlist는 "현재 통과하는 집합 - side-agent-fork"로 잡아 side-agent-fork를 **red로
  남기고** #2가 green으로 만든다(감사→수정 순서 증명).
- red-on-injection: allowlist에서 임의 엔트리 하나 제거 ⇒ 그 파일이 violation으로 red.
  side-agent-fork를 allowlist에 넣으면 green(=이 파일이 진짜 kill을 하고 있다는 witness).

### #2 (M) — escalatingKill을 SSOT로 수렴; side-agent-fork를 경유시켜 누수 수정

`side-agent-fork-port.ts:75-82`의 `cp.kill("SIGTERM")` 단발을 `escalatingKill`
(SIGTERM→SIGKILL) + tree-kill로 교체. `node:child_process` cp는 `pid` 노출하므로
`escalatingKill(cpAsKillable, killer)` 주입 가능(`guarded-spawn.ts:112`, `KillableChild.pid`
optional `:67-71`).

- **red-on-injection (correctness proof, byte-identical control):** killer **미주입** 시
  경로는 legacy 단발 SIGTERM과 **byte-identical**(`guarded-spawn.ts:121-125` `useTree` false
  분기) — default-OFF 등가. killer 주입 시 `signalTree(pid,"SIGTERM")` 관찰 + 2s 후
  `SIGKILL` 관찰. fake cp가 TERM을 trap하면 SIGKILL이 fire해야 red-if-missing.
- 이후 #1 allowlist에서 side-agent-fork가 green(=SSOT 경유로 정당화).

### #3 (M) — event-sourced kill 감사흔적 → recorder sink

모든 kill을 `{pid, signal, cause, ts}` 이벤트로 emit해 ADR-0539 recorder
(`src/stream/adapters/jsonl-recorder.ts`)로 흘림. OmO `destroy.ts:56,60,69`의
`appendEvent(reconcile_terminated{pid,signal})` 패턴을 우리 correlation tuple
(`{runId,instanceId,attempt,turn}`)에 붙임.

- `escalatingKill`/`signalTree`가 optional `onKill(evt)` 콜백을 받아 recorder로 라우트
  (콜백 미주입 시 byte-identical). cause = "abort"|"timeout"|"evict"|"shutdown"|"reconcile_lost".
- ROI: 북극성(왜 멈췄나) 직접 서빙 — trajectory viewer가 "process X killed by timeout at
  turn N"을 표시. red-on-injection: onKill 미주입 ⇒ recorder에 kill 이벤트 0(제어).

### #4 (M/L) — 원격 박스 orphan reconcile을 TS box-session으로 이식

`campaign-generic.sh:63`의 `kill -0 || harvest` 쉘 supervisor를 TS reconcile 포트로 구조화
(OmO `reconcile.ts` = session_start시 lost pid 재조정). box-session 레이어
(`src/apps/bench/remote/box-session/`, `lease-fs.ts:23`)에 `reconcileOrphans(store):
lost[] → destroyPort(reconcile_lost)`. **L 규모**(원격 세션 lifecycle 재작업) — 마지막.

---

## NOT (하지 말 것 — 재구현 금지)

- **tree-kill 재구현 금지.** `process-tree.ts` ppid-walk가 이미 OmO group-kill보다 강함
  (그들은 detached+`-pid` 하나, 우리는 두-스냅샷 BFS). OmO의 `process.kill(-pid)`
  (`lsp-core/.../process.ts:99-106`) 흡수 불필요.
- **escalation 재발명 금지.** `escalatingKill`이 OmO 고정 5s(`destroy.ts:57`)보다 정교
  (recycled-pid latch/pid>0 guard/early-disarm). #2는 재사용이지 새 구현 아님.
- **uv fork-storm 가드 재발명 금지.** 이미 `QUANTA_PYENV_SHIM_ACTIVE` sentinel로 해결
  (`src/runner/batch/eval/project-env-python-shim.ts:67,75` 재진입 가드). single-writer
  포트와 무관 — 섞지 말 것.
- **cheap heuristic 금지.** kill 대상 pid를 이름/휴리스틱으로 추론하지 않음 — ppid 그래프
  ground-truth만.

---

## 테스트 계획 (red-on-injection 증명)

| 항목 | RED 셋업 | GREEN 조건 | injection 증명 |
|---|---|---|---|
| #1 audit | side-agent-fork를 allowlist 밖에 둠 | side-agent-fork가 #2 후 SSOT 경유해 green | allowlist 엔트리 제거→해당 파일 red; FORBIDDEN에 임의 `.kill(` 심으면 red |
| #2 escalation | fake cp가 SIGTERM trap+생존 | 2s 후 SIGKILL 관찰 + tree pid 전부 signal | killer=undefined ⇒ 단발 SIGTERM byte-identical(제어); trap 시 SIGKILL 누락=red |
| #3 audit-trail | killer 실행, onKill 미주입 | onKill 주입 시 recorder에 `{pid,signal,cause,ts}` 1건 | 미주입=recorder 0건(제어); cause 필드 누락=red |
| #4 reconcile | store에 lost pid 주입, 프로세스 살아있음 | destroyPort(reconcile_lost) 호출→SIGTERM→(5s)SIGKILL | isAlive=false면 no-op(제어); breadcrumb 이벤트 누락=red |

hellgate: 각 항목 RED-first → TDD green → 적대 어딧 ≥3R → self-audit. #1은 게이트라
mutation-기준선(FORBIDDEN 패턴 하나 지우면 side-agent-fork red 사라짐=테스트 vacuous 증명).

## Effort / Risk

| # | 규모 | 리스크 | 게이팅 |
|---|---|---|---|
| #1 audit-test | S | 낮음(순수 정적 게이트, 프로덕션 0줄) | leak-fix correctness — 즉시 랜딩 자격 |
| #2 side-agent-fork route | M | 중(byte-identical 제어 필수; cp가 tree leader인지 미확인→pid>0 guard 재사용) | red-on-injection green으로 |
| #3 audit-trail | M | 중(recorder 계약 오염 금지; metadata-only, request 해시 불변) | onKill 미주입=byte-identical |
| #4 remote reconcile | M/L | 높음(원격 lifecycle 재작업, SSH 의존) | 마지막; #1-3 랜딩 후 |

실행 순서: #1(게이트, side-agent-fork red 노출) → #2(green으로 만듦) → #3(감사흔적) → #4(원격).
#4는 measure-first 대기 가능(원격 orphan 실측 빈도 확인 후).
