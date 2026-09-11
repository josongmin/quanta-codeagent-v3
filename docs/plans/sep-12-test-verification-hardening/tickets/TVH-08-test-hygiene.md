# TVH-08 — heavy test·skip·fixed wait·temp hygiene

- 상태: LANDED — temp 32개/run·16초 대기·3중 실행 제거, ignored scratch 삭제 사고 차단. 전제 5건은 측정으로 반증됨(티켓 본문 참조)
- 우선순위: P1/P2
- 상태: OPEN
- 소유 lane: test authors / fixture hygiene
- 선행: TVH-02, TVH-03, TVH-07
- 후속: TVH-10

## 대상

1. `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts`의 고정 16초 quiet-window wait.
2. `tests/integration/plan-mode-stress-100k-ops.test.ts`의 300k transition/lookup와 100k 반복 assertion.
3. `tests/unit/ipynb-render-property-fuzz-r2-hellgate.test.ts`의 500 seed, 1MB 반복 blob, 약 24MB fixture.
4. `tests/integration/lint-debt-reach-e2e.nightly.test.ts`가 파일 membership 외에 `QUANTA_TEST_STRESS`로 다시 skip되는 이중 authority.
5. self-skip ratchet이 multiline callback을 놓쳐 `tests/unit/worktree.test.ts`의 early return 네 곳을 PASS로 기록하는 문제.
6. `cli-live-debug-mode-hellgate`와 `evidence-node-failure-static-real-e2e`의 확정 temp-dir 누수.
7. 17개 real-toolchain 파일 중 14개 `mkdtemp*` 사용 경로의 cleanup 여부 전수 확인.
8. `web-usage-accounting-live-e2e`처럼 실제 TCP/WS daemon을 반복 boot하는 기존 hot file.
9. package cleanup과 runner source cleanup의 중복 full-tree traversal.
10. `browser-real-chrome-e2e`의 module-load probe + `beforeAll` 이중 Chrome spawn과 `browser-agent-loop-e2e`의 실제 env gate 없는 module-load server/browser 기동.
11. `web-daemon/server.test.ts`가 14개 live-server case에서 매번 daemon/WebSocket을 다시 boot한다.
12. `bench-results-fence-hellgate`가 `bench-write-artifacts` 전체 child suite를 두 번 실행하고 원래 full membership까지 합쳐 cold full에서 같은 suite가 세 번 실행된다.
13. auth/login/scheduler/compaction/JSONL readiness 경로와 synchronous dedup spin에 total deadline이 없어 회귀 시 runner 12분 inactivity watchdog까지 간다.
14. PTY goal 파일은 awaited fixed sleep 16개, 합계 22,875ms다. 단일 16초 wait만 제거해도 aggregate 비용은 남는다.
15. ordinary unit에 50M-character token fixture, 200k-cell notebook, 50k×2k output fixture, 10MB MCP URI, 10MB conflict parser 입력이 있고 대부분 `pure`로 겹쳐 실행된다.
16. web-daemon authenticated flow는 한 파일 안에서 다수의 20~80ms fixed wait로 상태 도착을 추측한다.
17. 최소 8개 ordinary files의 20개 `mkdtemp*` callsite에 `rm`/`rmSync`가 전혀 없다: CLI version/profile, repo-map, mention-folder, xlsx/docx roundtrip/deflate-bomb, office-authoring 두 파일. helper 반복까지 포함하면 cold full 실제 생성 수는 더 크다.
18. 기존 temp guard는 process exit-hook 금지만 검사하고 mkdtemp↔`finally` cleanup pairing을 보지 않는다. repository 주석 자체가 누적 `/tmp` 때문에 `ls /tmp`와 다른 test timeout이 느려진 incident를 기록한다.
19. `tool-cluster-hardening-r1` 40×4MiB inflate corpus, xlsx/docx 33MiB buffer+deflate, resource-limit 5MiB boundary fixture도 ordinary `pure` membership에 남아 있다.
20. `glob-gitignore-mtime-hellgate`는 module load에서 temp tree 작성과 `git init`을 수행한다. classifier는 integration-path지만 discovery/import 자체가 filesystem·Git effect를 가진다.

## 작업

- PR에는 작고 deterministic한 canary를 남기고 exhaustive case는 `*.nightly.test.ts` sibling으로 물리 분리한다.
- quiet-window 기능은 observable timer state 또는 injected monotonic clock으로 대부분 검증하고, 실제 시간 canary는 nightly 한 건만 유지한다.
- nightly file 내부의 `QUANTA_TEST_STRESS` skip을 제거해 file membership을 단일 authority로 만든다.
- self-skip detector를 multiline/async callback 구조로 수정하고 anti-vacuum floor와 multiline red-injection을 추가한다.
- capability 부재는 bare `return`이나 `expect(true)`가 아니라 공통 typed reporter를 사용한다.
- 모든 temp root는 `afterEach/afterAll/finally`에서 제거하고 cleanup failure를 숨기지 않는다.
- daemon tests는 suite-level shared fixture 또는 isolated reusable harness를 사용하되 state reset을 증명한다.
- JS cleanup은 package wrapper 또는 managed runner 중 한 owner만 수행하고 postflight는 검증 전용으로 남긴다.
- module scope에서는 filesystem-only 선언 외 browser/network/install/compile/daemon 실행을 금지한다. capability와 fixture는 runner가 주입한다.
- web daemon/browser는 suite-level shared harness + case별 state reset을 사용하고 reset isolation을 red-on-injection으로 증명한다.
- nested suite 전체 재실행은 작은 전용 subprocess probe로 교체한다.
- 모든 readiness loop는 shared bounded wait helper와 AbortSignal을 사용한다. sync no-cap loop는 static guard로 금지한다.
- fixed sleep budget은 단일 site가 아니라 파일별 aggregate awaited real-time 총량을 gate한다.
- 메모리/CPU stress는 최소 경계 canary만 PR에 두고 exhaustive magnitude는 nightly/measurement sibling으로 분리한다. 단, allocation/copy regression을 잡는 실제 크기 canary의 최소값은 명시한다.
- 공통 `withTempDir`/fixture owner가 allocation과 `finally` cleanup을 함께 소유한다. module-scope temp creation을 금지하고 campaign prefix의 start/end census를 receipt에 남긴다.
- 40-entry cumulative inflate와 대형 office payload는 nightly sibling으로 옮기고 ordinary에는 one-entry/max+1 경계 canary를 남긴다.

## 검증

- `PR canary IDs ∪ nightly IDs == 기존 exhaustive universe`, 교집합 0.
- ordinary tier source에 `QUANTA_TEST_STRESS` conditional body가 0.
- multiline self-skip injection이 정확한 file/line으로 RED.
- suite 전후 task-owned temp prefix 개수가 동일하다.
- real-time sleep 총량과 module-load external spawn을 static inventory로 gate한다.
- nested `bun test` target이 normal membership과 겹치면 명시적 allowlist/reason 없이는 RED다.
- shared daemon fixture에서 임의 case가 state reset을 누락하면 다음 case가 RED다.
- stress ID universe의 PR canary/nightly 합집합은 기존 coverage와 같고, 두 lane의 동시 peak RSS 합계가 host budget 아래다.
- cleanup 없는 mkdtemp와 assertion-before-cleanup injection이 file/line으로 RED고 suite 전후 owned temp prefix가 0이다.
- test module import만으로 temp path 수와 Git process count가 증가하지 않는다.

## 완료 기준

- [ ] ordinary PR/prepush에 고정 15초 이상 sleep이 없다.
- [ ] heavy fuzz/stress가 canary와 nightly로 물리 분리된다.
- [ ] capability self-pass와 untracked temp leak이 0이다.
- [ ] setup/cleanup 비용이 timing receipt에서 보인다.
- [ ] unbounded readiness loop와 ordinary module-load external effect가 0이다.
- [ ] ordinary mkdtemp는 모두 owner-scoped `finally` cleanup을 가지며 temp leak census가 0이다.

## 진행 (2026-09-12)

- **LANDED `a3a6219ae`**.

| 항목 | 측정 |
|---|---|
| temp 누수 | 9개 파일이 disposal 없음. 소유 `/private/tmp` prefix: **68 → 100 (실행당 +32)** → 수정 후 **100 → 100 (+0)**. 통합 시 1개 파일로 독립 재현: HEAD 버전 +9/run, 수정본 0 |
| PTY 고정 대기 | 파일 awaited sleep **22,650ms → 6,600ms**, ordinary 코퍼스 **34,530 → 18,530ms**. 실행 16 pass / **153.74s → 140.09s** |
| ipynb | peak RSS **620 MiB → 115 MiB** canary, 크기는 nightly sibling |
| nested suite | `bench-results-fence`가 `bench-write-artifacts` 전체를 2회 실행 + 정상 membership = cold full에서 3회. 2.51s → 2.15s, 중복 case 실행 10개 제거 |

- **self-skip 탐지기가 포매터에 의해 무력화돼 있었다.** `test(` 헤더가 한 줄이어야 매치했는데
  biome가 per-test timeout을 3번째 인자로 줄바꿈하면서 `worktree.test.ts`의 early return 4개가 숨었다.
  **포매터가 규칙 적용 여부를 결정하고 있었다.** AST 질문으로 교체.
- **분석기가 census 도중 자기 버그를 찾았다**: assignment에서 `parent.left`를 검사해
  올바른 148개 site(`let dir` + `beforeEach`)를 누수로 오분류. `parent.right`로 수정.

### 티켓 전제 5건이 current HEAD에서 성립하지 않아 **반증**했다 (우회가 아니라)

`plan-mode-stress-100k-ops` 183ms/115 MiB · `resource-limit-boundary` 186ms/93 MiB ·
`mcp-inbound-adversarial` 368ms/87 MiB · `conflict-parser` 310ms/69 MiB ·
`xlsx-docx-read` 483ms/68 MiB (baseline 51–56 MiB).
그리고 **item 11**: `web-daemon/server.test.ts`는 29 테스트에 1.40s — boot당 ~50ms다.
case마다 새 daemon이 **가장 강한 격리**이고, 0.5초와 바꾸는 것은 속도를 위해 커버리지를 지우는 것이다.
reset red-on-injection을 설계했다가 측정 후 폐기했다.

### 부수 발견 (소유자 판단 필요)

`posture-phase-modules-hellgate`의 "equivalence to shipped presets" 블록이 **완전히 vacuous**였다.
preset 이름 4개가 전부 `KNOB_PRESETS`에서 사라져 4개 case가 아무것도 단언하지 않고 green을 보고했다.
self-skip을 변환하니 4개 visible skip이 됐다.

### 남은 항목

- 여전히 무거운 파일(handoff에 ROI와 함께): `tool-cluster-hardening-r1` 366 MiB,
  `delta-token-identity` 261 MiB, `ipynb-render-property-fuzz-r2` 238 MiB
  (500/800 seed는 0.4초로 무관하고 50MB chunked case만 중요하다).
- 새 가드 2개는 기존에 등록된 walk에 얹혀 있다. 별도 `_arch` 파일로 분리하려면 3단계 등록 절차가 필요하다.
