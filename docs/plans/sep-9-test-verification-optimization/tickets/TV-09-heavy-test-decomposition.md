# TV-09 — 중량 테스트를 canary와 exhaustive로 분리

- 우선순위: P1
- 상태: IMPLEMENTING — exact tier wiring, hosted PR-tier binding, Biome/conflict-fuzz/bench nightly entrypoint 착륙; 나머지 capability split과 hosted receipt 미완료
- 소유자: C (영역별 파일 write set 분리)
- 선행: TV-02
- PR 기본 범위 축소 선행: TV-03, TV-13의 실제 연결

## 문제와 근거

Git fuzz, Biome 전체 reach, CLI 조합, PTY, 실제 언어 도구가 반복 loop에 함께 들어 있다. 단순 파일 이동은 coverage를 숨길 수 있으므로 기존 case/seed universe를 보존하며 실행 빈도를 나눈다.

2026-09-11 현재 conflict differential fuzz는 공통 deterministic fixture, PR 6-seed canary, nightly-only 54-seed remainder로 물리 분리되어 있다. canary/nightly ID는 서로 겹치지 않고 합집합이 원래 60-seed universe와 같다는 ratchet이 있다. Bench composition도 모든 7개 root의 invalid/absent pair와 Pro decision을 PR canary에 유지하고 전체 19-test cross-product를 nightly sibling으로 분리했다. Biome exhaustive oracle도 `lint-debt-reach-e2e.nightly.test.ts`로 분리됐다. Session은 32-way save와 save/archive race를 PR canary로 유지하고 기존 14개 scale/worktree/perf cases 전체를 `session-stress-and-concurrent.nightly.test.ts`로 이동했다. Session-envelope의 10,000-record/1,000-concurrent-write cases와 bench sandbox 50-run cleanup도 각각 별도 nightly entrypoint로 물리 분리됐다. 나머지는 독립 toolchain capability lane 분리다.

같은 날 focused 최적화로 conflict harness를 case당 임시 repository + Git 8회에서 `git merge-file -p` 1회로 교체했다. 분리 전 canary 6개 기준 9.44초에서 2.72초로 71% 감소했고, 당시 전체 60-seed 포함 215 tests가 4.05초에 통과했다. 물리 분리 후에는 PR 161 tests와 nightly remainder 55 tests가 각각 통과한다. seed/case 수와 Git xdiff marker authority는 유지된다. bench CLI는 handler와 run-time graph를 지연 로드하고 selector subprocess를 concurrency 4로 묶었다. `composition-root-dispatch`는 부하가 큰 동일 호스트에서 126.9초에서 90.9초로 감소했지만 CPU 포화 상태 측정이므로 authoritative ABBA가 아니다. 순수 instance-filter 테스트도 무거운 `batch/core` barrel 대신 `instance-selection` leaf를 직접 가져오도록 바꿔 동일 작업 트리에서 16.6초에서 3.43초로 줄었다.

## 구현 범위

| 영역 | PR 기본·affected 검증 | exhaustive lane |
|---|---|---|
| Git parser | 고정 4–6 seed + 알려진 실패 사례 | 60 seed differential fuzz |
| CLI/PTY | boot/input/goal/approval canary; 관련 변경 시 전체 affected PTY 파일 | 모든 PTY 사례 |
| MCP | fake 계약 + 실제 crash/restart canary | lifecycle/restart/load matrix |
| LSP/evidence/debug | 변경 언어의 provisioned contract | 전체 언어·도구 matrix |
| session/worktree | lost update/fork/recovery/cleanup | 대량 save/concurrency/stress |
| bench composition | 변경 subcommand valid/invalid pair | 전체 selector cross-product |
| daemon/browser | 실제 ephemeral server route와 teardown | 전체 browser/daemon 반복 |

1. 실제 측정 상위 파일부터 분할하고 synthetic unit과 real process의 목적을 각각 명시한다.
2. seed/case ID를 공통 fixture로 소유하고 default와 exhaustive가 서로 다른 버그 목록을 복사하지 않게 한다.
3. nightly 등록·실행 증거와 affected-path selector가 준비되기 전 기존 PR 실행을 제거하지 않는다.
4. `bench-full-remote-hellgate`의 기존 실패는 분할 완료와 별개다. 오류를 삼키는 fixture 때문에 진단이 숨는지도 owner-local 조사 항목으로 남긴다.
5. 알려진 결함 재현 사례는 작은 PR canary로 영구 유지한다.
6. nightly 조건부 case는 sibling `*.nightly.test.ts` entrypoint로 물리 분리한다. 같은 파일의 `skipIf`만으로 membership 분리를 완료 처리하지 않는다.
7. `run-test-shards --tier`가 `TestPolicy.tiers`의 exact manifest를 소비하게 하고 PR/full/nightly의 file set을 receipt로 비교한다.

## 대상 파일

- `tests/unit/git/conflict-parser-differential-fuzz.test.ts`
- `tests/integration/lint-debt-reach-e2e.nightly.test.ts` (scan 본체 변경은 TV-10)
- `src/apps/bench/composition-root-dispatch.test.ts`
- `tests/e2e-pty/`, `tests/unit/project-env-astropy-real-e2e.test.ts`
- `tests/integration/mcp-auto-restart-real-process-e2e.test.ts`
- `tests/integration/session-stress-and-concurrent.test.ts`
- NEW: 영역별 canary/exhaustive entrypoints; TV-02에 명시 등록

## 파일·심볼별 작업

| 파일 | 현재 중량 지점 | 변경 로직 | 보존 검증 |
|---|---|---|---|
| `tests/unit/git/conflict-parser-differential-fuzz.test.ts`, `conflict-parser-differential-fuzz.nightly.test.ts`, `conflict-parser-fuzz-runtime.ts` | `BASE_SEED`, `GIT_CASES = 60`, real-git loop, constructed adversarial cases | DONE: Git process를 case당 8→1로 축소하고 PR 6-seed/nightly 54-seed remainder를 sibling entrypoint로 물리 분리했다. constructed adversarial은 PR에 유지한다. | disjoint union=60 ratchet, PR 161 pass, nightly remainder 55 pass. |
| `src/apps/bench/cli.ts`, `run-main.ts`, `run-main-dataset.ts`, `src/runner/batch/instance-selection.ts` | run/no-subcommand가 모든 command/eval/report 모듈을 선로드 | DONE: command handler, eval/LLM/observe/artifact graph를 사용 시점까지 지연하고 dataset/instance selection을 경량 모듈로 분리한다. static anti-vacuum guard가 eager command import 재도입을 막는다. | help 1.01초, live family rejection 89.8ms in-process, custom dry-run 3.65초; 공개 re-export focused tests 보존. |
| `.github/workflows/ci.yml`, `tests/unit/dev/test-policy-enrollment.test.ts` | hosted `full-suite`가 tier 미지정으로 nightly까지 실행 | DONE: full-suite step에 `QUANTA_VERIFICATION_TIER=pr`을 결합했다. step 이름/env/실행 명령을 함께 검사하고 `pr→full`, command 교체 injection이 RED가 되는 guard를 둔다. | committed-HEAD PR/full 3,926, nightly 3,930 exact discovery; workflow parity와 policy tests 통과. |
| `src/apps/bench/composition-root-dispatch.test.ts`, `composition-root-dispatch.nightly.test.ts` | `runCliBatch`, `FAMILY_BEARING`, `BAD_SELECTORS`, 다수 cross-product describe | DONE: PR은 7-root invalid/absent pair와 Pro decision을 concurrency 4로 실행하고, 전체 selector/family/precedence cross-product는 nightly sibling으로 물리 분리했다. | PR 2 tests/40 assertions 17.5초, nightly 19/19 59.3초; nightly-only policy membership ratchet. |
| `tests/integration/lint-debt-reach-e2e.nightly.test.ts` | `biomeDiagnosticsOverRoots`, root-wide oracle test | nightly exact entrypoint로 분리한다. PR에서는 file load 자체를 제거하되 config/target/receipt 변경은 selector가 nightly-required/full-required 이유를 반환한다. | nightly manifest 포함, PR manifest 제외, invalid target injection RED. |
| `tests/e2e-pty/` | 각 파일의 `describe.skipIf(!PTY_AVAILABLE)` | `cli-input-layer`, `cli-goal-pursuit`, `cli-hunk-approval`을 기본 canary 후보로 등록한다. PTY 부재는 required capability lane에서 pass가 아니라 capability failure다. | 관련 CLI path 변경 시 전체 affected PTY 선택. |
| `tests/unit/project-env-astropy-real-e2e.test.ts` | `D`, `ASTROPY_13033`, `runRepro` | 실제 toolchain case는 nightly/cold 전용으로 정책 등록하고 작은 fake contract는 별도 unit에 둔다. 현재 real assertion을 mock으로 대체하지 않는다. | base/proof 두 경로와 environment/setup failure 분리. |
| `tests/integration/mcp-auto-restart-real-process-e2e.test.ts` | real crash/restart process와 broad `@/agent` barrel import | DONE: headline/control/sabotage 3 cases를 PR에 유지하고 exact `mcp-bridge` leaf를 import한다. | 3/3 pass, 5.65→4.26초; 실제 subprocess와 supervisor lifecycle 보존. |
| `src/apps/cli/serve-stdio-entry.ts`, `serve-stdio-e2e-hellgate.test.ts` | transport case마다 일반 CLI 전체 graph 냉시작 | DONE: public route canary 2개는 `index.ts`를 유지하고, command 선택 이후 transport/lifecycle 8개는 같은 production focused entry를 실행한다. | 10/10 pass, 53.72→5.37초; public CLI→entry→command 호출 체인 mutation guard. |
| `src/apps/eval/index.ts`, `src/apps/eval/cli-context.ts`, `tests/unit/eval-cli-lazy-import-hellgate.test.ts` | grounding argument/report 검증도 trajectory/compare/synthetic/runtime graph 선로드 | DONE: invocation context를 응집 모듈로 분리하고 heavy command root 13개를 실제 호출 지점에서 lazy import한다. | grounding CLI 5/5, 9.73→1.30초; static re-import와 dynamic-call 제거 paired RED. |
| `tests/integration/session-concurrency-canary.test.ts`, `session-stress-and-concurrent.nightly.test.ts` | PR에서 1,000 sessions, 5,000 messages, 10-cycle worktree까지 실행 | DONE: 32-way save 및 3-round archive race를 PR canary로 유지하고 기존 14-case universe를 nightly physical entrypoint로 이동한다. | PR 2/2 in 0.274초; nightly focused routing 2/2; policy membership guard. |
| `tests/integration/bench-auth-pool-cli-dry-run.test.ts`, `bench-index-dataset-dry-run.test.ts` | 독립 CLI child가 concurrency 2로 3–5 waves 실행 | DONE: immutable fixture/read-only children의 bounded cap을 4로 올린다. | auth 9/9 in 0.714초; dataset 5/5 in 2.87초 under external host load. |
| `tests/unit/session-ops/worktree-reconcile-resume.test.ts` | fixture repo당 bash 2 + git 4 processes | DONE: shell wrapper 없이 git 2회 직접 실행하고 dirty fixture는 file write로 만든다. | 8/8; setup process count 6→2 per repo. |
| `src/runner/batch/eval/snapshot.ts`, `tests/unit/bench/snapshot-argv-fastpath-hellgate.test.ts` | 모든 bench attempt의 고정 Git/관측 명령이 `bash -c` wrapper를 추가 생성 | DONE: fixed Git argv와 version probes를 `execArgv`로 실행한다. observed attempt당 shell wrapper 7개, non-observed attempt당 2개를 제거한다. | snapshot/capture focused tests 및 wrapper 재도입 paired mutation guard. |
| `src/apps/cli/session-main.ts`, `session-command-entry.ts`, `top-level-usage.ts`, `src/runner/session-ops/index.ts` | `session`/`--help` child가 REPL/agent/slash registry와 runtime/session barrels를 선로드 | DONE: session/usage production leaf와 dynamic route를 만들고 worktree authority만 해당 verb에서 lazy-load한다. session-ops는 concrete leaf imports를 사용한다. | public route canary 유지, focused entry wiring anti-vacuum, session subprocess 13/13. |
| `tests/integration/bench.test.ts`, `bench-sandbox-cleanup.nightly.test.ts` | PR에서 동일 instance cleanup을 50회 직렬 반복 | DONE: PR은 3-run immediate leak canary, nightly는 독립 2 lane × 25 sequential runs로 원래 50-run work를 보존한다. | exact nightly membership 및 PR exclusion guard. |
| `tests/integration/session-envelope-hell-e2e.test.ts`, `session-envelope-stress.nightly.test.ts` | `QUANTA_TEST_STRESS`가 같은 PR 파일 안의 10k stream/1k writes를 활성화 | DONE: PR 256-stream/128-write canary를 유지하고 10k/1k cases를 nightly 파일로 이동한다. | PR file 9/9 in 0.66초, nightly-only membership guard. |
| `tests/integration/canvas-artifact-preview-daemon-e2e.test.ts`, `canvas-tool-diff-usage-daemon-e2e.test.ts` | negative assertions가 500/600/200/200ms 고정 sleep 사용 | DONE: 실제 `turn.completed|failed|aborted` WS event barrier로 교체한다. | 12-case 두 파일 합계 1초 미만 focused; 잘못된 frame 부재 assertions 유지. |
| `tests/integration/pyright-cross-file-resolution.test.ts` | real server readiness polling granularity 500ms | DONE: 동일 25초 deadline에서 poll interval만 50ms로 줄이고 Pyright leaf import를 사용한다. | real pyright focused 1/1 in 1.24초. |
| `tests/unit/shell.test.ts`, `lsp-server-mem-budget.test.ts` | child 종료 확인 300ms 및 LSP exit-log 확인 250ms×2 고정 sleep | DONE: 실제 process-exit/logger event를 10ms/5ms bounded polling으로 확인하고 runtime/LSP/logger leaf imports를 사용한다. | focused 22/22 in 1.54초; timeout/real-child assertions 유지. |
| `tools/dev/test-policy.ts`, `tools/dev/test-policy-overrides.json` | `TestPolicy.tiers`, `resolveTestPopulation` | default-only full 정책을 실제 smoke/prepush/pr/full/nightly file membership으로 확장한다. generated defaults와 explicit exceptions의 owner를 하나로 둔다. | tier union/exact set, unknown tier, duplicate test ID, empty tier RED. |
| `tools/dev/test-shard-options.ts`, `tools/dev/run-test-shards.ts` | NEW `--tier`, discovery filter | suite discovery 후 exact tier policy로 파일을 필터링하고 tier/policy/population/membership digest를 receipt에 결합한다. | 같은 count/다른 file set, unknown tier, policy drift reject. |

## 작업 순서

1. TV-07 자료로 상위 wall-time 파일을 확정한다.
2. 각 파일의 case/seed ID inventory를 먼저 고정한다.
3. helper만 추출하고 canary/exhaustive entrypoint를 만든다.
4. TV-02 정책과 TV-03 affected mapping에 두 population을 등록한다.
5. TV-13 nightly의 실제 실행 receipt가 생긴 뒤에만 PR exhaustive 실행을 제거한다.
6. PR selector shadow에서 full failure false-skip 0을 확인한 뒤 tier 축소를 required 경로에 활성화한다.

## 2026-09-11 잔여 상위 비용 판정

| 대상 | 판정 | 다음 조치 |
|---|---|---|
| `bench-verify-select-telemetry.test.ts` | 9개가 candidate snapshot/selection/terminal-authority의 서로 다른 실제 경계를 검증한다. leaf import와 snapshot shell 제거 후 focused 9/9 통과. | PR 유지. 환경변수 authority가 process-global이라 파일 내 무선 병렬화 금지. |
| `bench-observability.test.ts` | usage, strict degradation, secret scrub, child env scrub, Best-of-N artifact는 합치면 실패 attribution이 사라지는 독립 계약이다. | PR 유지. shared/runtime 분리가 생길 때만 concurrency 재평가. |
| `docker-sandbox-e2e.test.ts` | 12개가 실제 spawn/stdout/stderr/timeout/kill/env/argv 경계를 검증한다. daemon은 stub이라 capability 지연이 아니다. | 12-case PR canary 유지; timeout을 fake timer로 바꾸지 않는다. |
| `session-cli-subprocess.test.ts` | help/resume/public session-route canary는 실제 `index.ts`가 필요하다. 나머지 session verbs는 focused production entry 사용. | hosted healthy-load에서 public/focused startup을 별도 측정; public canary 삭제 금지. |
| real Pyright/Docker/LSP/PTY/toolchain | 설치/daemon 유무가 검증 의미의 일부다. mock으로 바꾸면 false-green이다. | TV-13 capability job으로 물리 이동하고 missing capability를 pass가 아닌 명시 상태로 기록. |
| wall-time p95 | 현재 호스트의 unrelated Go/Rust/XProtect 부하로 절대 시간이 크게 흔들렸다. | TV-07/TV-90에서 고정 SHA, healthy-load, cache-off ABBA receipt를 생성. |

## 검증 계획

case/seed inventory를 비교해 기존 사례가 PR/nightly 합집합에서 빠지지 않게 한다. known bug를 주입하면 PR canary가 실패해야 한다. affected CLI/MCP/LSP path 변경 시 해당 실제 실행 lane이 선택되는지 TV-03과 통합 검증한다. 실제 process 테스트는 작은 선택 집합만 실행하고 stress 전체는 TV-90까지 보류한다.

## 완료 기준

- [x] 현재 JUnit 상위 중량 파일의 실행 빈도와 owner가 명확함. 새 healthy-load timing은 TV-07/TV-90 receipt 대상이다.
- [x] 이동한 fuzz/session/bench/envelope case universe 누락 0.
- [ ] 관련 변경 시 필요한 real runtime 검증이 PR에 남음.
- [ ] nightly 미연결 상태에서 PR 검증을 삭제하지 않음.
- [ ] 단순 timeout 증가·skip 증가로 속도를 만들지 않음.
- [ ] PR/full/nightly exact file manifests가 서로 구분되고 receipt에 고정됨.
- [ ] 같은 파일 안의 runtime skip을 file membership 분리로 계산하지 않음.

## 실패·복구

nightly 이동으로 발견 지연이 발생하면 해당 회귀를 작은 PR case로 추가한다. 테스트 전부를 반복해서 로컬 full에 되돌리는 대신 영향 정책과 canary를 수정한다.
