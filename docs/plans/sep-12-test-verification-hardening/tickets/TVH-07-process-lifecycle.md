# TVH-07 — process lifecycle·timeout·cleanup 표준화

- 우선순위: P0/P1
- 상태: OPEN
- 소유 lane: child process lifecycle / watchdog
- 선행: TVH-01
- 후속: TVH-08, TVH-09

## 현재 결함

- shard에는 12분 inactivity watchdog만 있고 total chunk wall deadline이 없다. 계속 출력하는 pathological chunk는 한 시간 이상 실행 가능하다.
- `unit-speed-budget`의 standalone confirmation은 timeout 없는 `Bun.spawnSync`이고 같은 파일을 최대 두 번 확인할 수 있다.
- contract `limactl list` probe는 module load에서 timeout/kill 없이 실행된다.
- CLI subprocess helper는 test timeout이 있어도 child process group kill/drain을 직접 보장하지 않는다.
- matrix worker는 local runner의 watchdog, process-tree cleanup, source-JS postflight를 갖지 않는다.
- quiet-box override는 상한이 없어 stale env가 의도한 180초를 시간 단위로 늘릴 수 있다.
- Lance/TypeScript/Pyright capability probe의 `Promise.race` timer가 성공 후 clear되지 않고, Lance는 후보 최대 4개를 직렬로 기다린다.
- `debugpy-real-e2e`의 `xcrun`/LLDB probe와 real lane의 clang/cargo build가 timeout 없는 sync child다.
- fresh checkout web gate가 test 전에 command-level timeout 없는 `bun install --frozen-lockfile`을 수행한다.
- SWE-bench smoke audit은 HuggingFace API 최대 5페이지를 request/total timeout과 bounded retry 없이 순차 fetch한다.
- `tools/dev/gate.ts:293-310`은 모든 top-level gate를 timeout 없는 `Bun.spawnSync`로 실행한다. 내부 hang 시 gate별 취소·진단·deadline이 없다.
- `worktree-pollution-guard.ts:159-163`도 child command를 timeout 없는 sync wrapper로 실행한다.
- `file-transaction.test.ts:311-317`은 5초 while 조건 안에서 blocking `reader.read()`를 await하므로 child가 READY를 쓰지 않으면 조건을 다시 평가하지 못한다.
- `tools/test-resilience/cli.ts:43-54`의 `runBunTest`는 total/inactivity deadline과 process-group drain 없이 stdout/stderr 전체를 메모리에 모은다. initial broad run과 모든 diagnostic retry가 같은 unbounded primitive를 사용한다.
- RSS sampling과 process-group drain은 timeout 없는 sync `ps`를 호출한다. `ps`가 hang하면 JS event loop, inactivity watchdog, TERM→KILL deadline이 함께 멈춘다. 60초 TERM+10초 KILL/50ms poll은 정상적으로 늦은 그룹에도 최대 약 1,400회 `ps` process를 생성한다.
- initial `leaderIdentity(pid)`가 `ps` 실패로 `undefined`여도 “leader가 이미 종료됨”과 구분하지 않는다. 이후 PID/PGID 재사용 race에서 unrelated process group signal을 안전하게 차단할 identity 증거가 없다.
- campaign 3분 admission 뒤 deadline을 지우고 shard가 새 10분 budget, quiet gate가 새 3분 budget을 만든다. 지속 부하에서 실행 외 idle wait가 계층별로 최대 16분 합산된다.
- real CLI test helper 9개가 stdout을 EOF까지 읽은 뒤 stderr를 읽는다. child가 stderr pipe를 먼저 채우면 child와 parent가 서로 기다리는 deadlock이 가능하며 concurrency wrapper에는 timeout/kill이 없다.

## 공통 실행 primitive

`tools/dev`에 bounded child lifecycle primitive 하나를 둔다.

- argv array 실행, shell 필요 시 별도 explicit mode
- monotonic total deadline + inactivity deadline
- detached process group
- SIGTERM grace 후 SIGKILL
- stdout/stderr bounded spool과 progress timestamp
- abort signal 전파
- descendant drain 확인
- timer/reader cleanup과 readiness deadline
- HTTP request timeout, total operation deadline, capped retry/backoff
- typed `passed/failed/timed-out/cancelled/spawn-error`
- 종료 후 temp root cleanup 결과

## 적용 대상

| 파일 | 대상 |
|---|---|
| `tools/dev/run-test-shards.ts` | per-chunk predicted/p95 wall SLA, ETA, slow-file progress |
| `tools/dev/unit-speed-budget.ts` | sync confirm 제거, 파일별 confirmation 1회, worker env 재현 |
| `tests/contract/remote-cli-docker.test.ts` | `limactl list`와 모든 live probe |
| `tests/integration/cli-live-debug-mode-hellgate.test.ts` | `runCli` |
| `tests/integration/session-cli-subprocess.test.ts` | `runCli`, `runFocusedSessionCli` |
| `tools/dev/verification-matrix-cli.ts` | worker watchdog, drain, source-JS postflight |
| `tools/dev/box-load.ts` | env override max clamp와 source/value log |
| `tests/contract/lance-real-wire.test.ts`, `lsp-typescript.test.ts`, `lsp-pyright.test.ts` | probe timer cancel, bounded shared capability result |
| `tests/unit/tool/debug/debugpy-real-e2e.test.ts` | xcrun/clang/cargo child lifecycle |
| `package.json` web setup | install을 bounded explicit setup phase로 분리 |
| `tests/smoke/swebench/select.ts`, `select-10.ts` | offline snapshot default + explicit bounded live refresh |
| `tools/dev/gate.ts`, `worktree-pollution-guard.ts` | TVH-14 DAG runner의 bounded async lifecycle로 교체 |
| `tests/unit/sep8-remediation/r02/file-transaction.test.ts` | abortable READY read + `finally` process-tree cleanup |
| `tools/test-resilience/cli.ts` | bounded lifecycle primitive, streamed/bounded output, retry budget과 cancellation |
| `tools/dev/shard-rss.ts`, `test-shard-lifecycle.ts` | bounded process observer, single snapshot reuse, exponential/backed-off poll, typed unavailable/unknown identity |
| `verification-campaign.ts`, `run-test-shards.ts`, `gate.ts` | 하나의 monotonic admission deadline 전달; nested layer는 remaining budget만 소비 |
| `tests/integration/bench-auth-pool-cli-dry-run.test.ts`, `bench-index-dataset-dry-run.test.ts`, `bench-cli-e2e.test.ts`, `bench-auth-status-cli-e2e.test.ts`, `bench-box-ls-status.test.ts`, `bench-pool-cli-dry-run.test.ts`, `bench-pool-auth-pool-cli-dry-run.test.ts`, `agent-bootstrap-scripts.test.ts`; `tests/unit/apps/bench/promax/promax-probe-fails-closed.test.ts` | stdout+stderr+exit 동시 drain, per-stream cap, total deadline, finally process-tree kill |

## 검증

- module-load hang, continuous-output hang, silent hang을 각각 synthetic child로 주입한다.
- timeout/cancel 후 descendant process와 lease가 0이다.
- same slow file의 confirmation spawn은 1회다.
- quiet budget에 과대 env 값을 넣어도 configured maximum을 넘지 않는다.
- matrix/local runner의 lifecycle outcome schema가 동일하다.
- early success probe 뒤 pending timer/reader가 0이고, 후보 수가 늘어도 total capability deadline을 넘지 않는다.
- network blackhole에서 smoke audit과 dependency setup이 선언된 total deadline 안에 종료된다.
- hung isolation retry와 infinite-output retry가 diagnosis budget 안에서 typed incomplete로 끝나고 child survivor가 0이다.
- `ps` adapter never-return/timeout과 identity-unknown을 주입해도 cleanup은 bounded typed failure이며 unrelated PGID signal은 0이다.
- 70초 survivor fixture의 process snapshot 호출 수가 고정 상한 아래이고 global admission wait는 nested runner를 포함해 하나의 cap을 넘지 않는다.
- child가 stderr pipe capacity 이상을 먼저 출력해도 helper는 bounded 종료하고 stdout/stderr tail 및 survivor 0을 남긴다.

## 완료 기준

- [ ] 무제한 `spawnSync`/`proc.exited` 대기가 gate 경로에 없다.
- [ ] total wall과 inactivity timeout이 별도 동작한다.
- [ ] timeout 후 child survivor와 temp root가 없다.
- [ ] 한 chunk가 계속 출력하며 job timeout까지 점유할 수 없다.
