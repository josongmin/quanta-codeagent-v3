# Handoff — jun-24 scaffold SOTA absorption: 구현 + 측정 인프라 + 11138 RCA

작성 2026-06-24. 이 문서는 jun-24 scaffold 흡수 플랜(T0~T7) 구현 + 3R 어딧 +
로컬 측정까지 진행한 세션의 이어받기 문서다. 목적은 두 가지다:

1. 무엇이 이미 landed 되었는지와, 무엇이 아직 "측정/수리 미완"인지 구분한다.
2. `django__django-11138`에 대해 현재 verified receipt와 세션 authored claim을
   분리해, 다음 작업자가 가짜 확정 RCA로 출발하지 않게 한다.

## TL;DR

- 이 세션은 T0~T7 구현 웨이브, 3라운드 적대 어딧, 로컬 측정까지 진행했다.
- T2b/T4/T5/T2/T1-offswitch/T3는 전부 default-OFF로 landed 했다.
  no-heuristics 규칙상 A/B 없이 promote 금지.
- 세션 closeout 기준 주장은 "222 unit green, 미커밋"이었다. 다만 현재 live
  worktree에서 실제 dirty diff는 follow-up 일부만 남아 있고, 핵심 substrate의
  상당수는 이미 tree 안에 있다. 이 문서는 둘을 분리해서 적는다.
- 로컬 측정 중 인프라 3중 병목을 확인했다:
  - per-instance full clone
  - blobless clone로 인한 LSP grounding hang
  - verify-select concurrency의 fork capture desync
- 세션 authored 결론은 `11138`의 진짜 RCA가 forkSandbox capture desync라는
  것이다. 다만 현재 repo에 핀된 receipt 중
  `.bench-pull/run-1782190012887/...`만으로는 그 결론이 아직 직접 검증되지
  않는다. 이 문서는 verified receipt와 authored-but-unpinned claim을 분리한다.
- 다음 1순위는 `concurrency>1` arm을 다시 찍어 capture-desync claim을 current
  receipt로 재검증하는 것이다.
- 새 local `concurrency=1` control은 read-mode Python blocker를 넘겼고,
  현재는 capture loss가 아니라 `proof_required_missing`/selector no-winner로
  빈 제출이 난다.
- 다음 2순위는 `concurrency>1`에서 실제 `lost-edits`/`capture_lost_edits`가
  재현될 때만 fork capture desync fix다. 아니면 RCA를 selector/proof-required
  miss로 되돌린다.
- 다음 3순위는 full-remote에서 lever A/B를 다시 재는 것이다.

## 0. 출발점

- 플랜:
  `docs/plans/jun-24-scaffold-sota-absorption-latest-code.md`
- 3-fail 분석/근거:
  `docs/analysis/jun24-scaffold-absorb/REPORT-jun24-three-fails-with-citations.md`
- 3R 흡수 어딧:
  `docs/analysis/jun24-scaffold-absorb/REPORT-jun24-scaffold-absorb-audit-3round.md`
- dual-driver 주의:
  - LIVE orchestration shell은 `src/apps/bench/eval/driver.ts`
  - `src/runner/batch/eval/driver.ts`의 top-level `runInstance` shell은 dead twin
  - 단 `prepareAttemptContext`, `runSelection`, `selection-executor`,
    `withGitSnapshot` 등 shared helpers는 LIVE다
- 이전 handoff가 가리키던 `.claude/.../jun-24-local-swebench-measure-infra.md`
  경로는 현재 repo에 없다. 그래서 load-bearing 사실은 이 문서에 재기록한다.

## 1. 구현 상태

세션의 구현 결론은 아래와 같다. 여기서 "landed"는 tree 안에 코드가 존재한다는
뜻이고, "promoted"와 다르다. 기본값은 전부 OFF로 유지한다.

| 티켓 | 무엇 | 핵심 파일 |
|---|---|---|
| **T2b** | public-issue-text declared-expected가 clean-mode veto(`hard:declaredExpectedMatch=false`)를 합법적으로 발화. answer-key 가드(provenance). default-OFF `QUANTA_BENCH_SPEC_FIDELITY_INVARIANT` | `declared-expected-matcher.ts`, `extract-issue-declared-expected.ts`, `selection-gates.ts`, `selection-executor.ts`, `knobs/spec-fidelity-invariant.ts`, apps driver `runSelectionExecutor` 배선 |
| **T4** | 차등 undefined-name(F821) 하드게이트(3번째 staticSanity probe), before/after 빼기로 net-new만 veto, fail-open | `patch-static-sanity.ts` |
| **T5** | done-time capture 분류(`source-captured`/`stripped-only`/`empty-no-work`/`lost-edits`), heuristic 없이 rawDirty 사실로. `lost-edits`(fork desync)를 capture failure로 라우팅(model-miss 세탁 방지) | `capture-correctness.ts`, `snapshot.ts`(`gitWorktreeHasStagedChanges`), apps driver `runAgentPhase`, `generateSelectionCandidate` |
| **T2** | command-derived test 경로 비면 owner module namespace 관례로 source-search fallback | `verification-owner-test-expectations.ts`, shared `prepareAttemptContext` 경로 |
| **T1** | family-coverage veto 측정 off-switch `QUANTA_BENCH_FAMILY_COVERAGE`(default ON, `=0`이면 OFF). advisory witness는 veto 안 하도록 provenance guard 보강 | `selection-executor.ts`, `selection-gates.ts`, `extra.ts` |
| **T3** | 빈 `DEEPER_LOCALIZE_MODULES` 점유 = forward-localize occupant. 직전 candidate edited symbol→consumer 역추적→다음 pass owner evidence | `forward-localize-trace.ts`, `knobs/forward-localize.ts`, `capability-profiles.ts`, `knobs-bench.ts`, shared prepare path + apps adaptive path 배선 |

적대 어딧(3R)로 잡은 결함 수정 4개:

1. declared-expected quoted regex 불일치 수정
2. capture-correctness 분류 시점을 tentative patch가 아니라 `rawPatch` 기준으로 통일
3. T2 gate asymmetry 제거
4. T2 convention test path를 owner-relative만 허용하도록 수정

현재 live worktree에서 눈에 보이는 dirty diff는 이 세션 구현 전체가 아니라
follow-up 일부다. 감사 시점 dirty 파일은 대략 아래 축이었다:

- `src/runner/batch/corpus/dataset.ts`: repo mirror cache
- `src/runner/batch/eval/verification-owner-test-expectations.ts`: T2 extraction hardening
- `src/{apps/bench/eval,runner/batch/eval}/driver.ts`, `report.ts`, `types.ts`:
  owner-widening telemetry/report wiring
- 관련 unit tests
- 이 handoff 문서

즉, "T2b/T4/T5/T2/T1/T3 전부 아직 dirty"라고 읽으면 안 된다. 핵심 substrate는
이미 tree 안에 있고, 현재 dirty diff는 follow-up/hardening 일부다.

## 2. 로컬 측정 중 드러난 인프라 병목

local official-dataset patch-gen이 13~18분 조용히 멈추는 현상을 추측이 아니라
`sample <pid>` stack + `lsof -i`로 분리했다.

1. `prepareTaskRepo` full clone 병목
   - 기존에는 큰 repo를 instance마다 새로 clone했다.
   - 현재는 `src/runner/batch/corpus/dataset.ts`에서
     `~/.quanta/bench/repo-cache/<org>__<repo>.git` bare mirror를 먼저 만들고,
     이후 sandbox는 local clone으로 복제한다.
   - override: `QUANTA_SWEBENCH_REPO_CACHE`
2. blobless clone이 LSP를 깨뜨림
   - blobless(`--filter=blob:none`)는 pyright가 lazy fetch를 유발해
     indexing/localize가 끝나지 않았다.
   - 그래서 "network는 아끼지만 LSP는 정상"이라는 production 요구를 위해
     full-blob cache로 되돌렸다.
3. verify-select fork concurrency capture desync
   - 아래 `11138` RCA.

측정 실행 커맨드:

```sh
bun run src/apps/bench/index.ts \
  --swebench /tmp/frozen3.jsonl \
  --instance <id> \
  --predictions <predictions.jsonl> \
  --report <report.json>
```

frozen 3-case는 `/tmp/frozen3.jsonl` (`14315`, `11138`, `13033`)였다.

## 3. `11138` — 현재 검증된 receipt와 authored claim을 분리할 것

### 3.1 현재 repo에 핀된 receipt가 직접 말해주는 것

현재 repo에 핀된 주 receipt인
`.bench-pull/run-1782190012887/{report.json,observe/django__django-11138.0.jsonl}`는
다음까지만 직접 입증한다:

1. verify-select candidate들은 실제로 생성되었다.
2. candidate generation 전체 실패가 아니었다.
3. 최종 제출 패치는 0바이트였다.
4. 그 직접 사유는 현재 핀된 report 기준으로는 `proof_required_missing`이다.

즉, 이 receipt만으로는 "`11138`은 확정적으로 fork capture desync였다"까지는
못 간다.

### 3.2 receipt 근거

주요 receipt는 다음 파일이다:

- observe:
  `.bench-pull/run-1782190012887/observe/django__django-11138.0.jsonl`
- report:
  `.bench-pull/run-1782190012887/report.json`
- 기존 분석 문서(현재는 receipt와 충돌):
  `docs/analysis/jun24-scaffold-absorb/REPORT-jun24-three-fails-with-citations.md`

이 receipt에서 확인되는 사실:

1. `11138` 실행 중 다수의 read/edit/grep이
   `/home/ubuntu/.quanta/bench/work/bench-django__django-11138-fork-.../repo-...`
   경로에서 일어난다.
2. 실제 fork tree 편집은 `mysql/operations.py`, `oracle/operations.py`,
   `sqlite3/operations.py`, `sqlite3/base.py` 쪽으로 수렴한다.
3. 그런데 최종 capture는
   [django__django-11138.0.jsonl](/Users/songmin/quanta-codeagent-v3/.bench-pull/run-1782190012887/observe/django__django-11138.0.jsonl:5740)
   에서 `patch_generated filesChanged:0`으로 끝난다.
4. 하지만 같은 run의 report는
   [report.json](/Users/songmin/quanta-codeagent-v3/.bench-pull/run-1782190012887/report.json:13233)
   에서 에러를
   `verify-select proof-required mode produced no submittable candidate`로 기록한다.
5. 같은 report의 `selectionTelemetry`는
   [report.json](/Users/songmin/quanta-codeagent-v3/.bench-pull/run-1782190012887/report.json:13274)
   에서 `successfulGenerations: 6`,
   [report.json](/Users/songmin/quanta-codeagent-v3/.bench-pull/run-1782190012887/report.json:13278)
   에서 `winnerId: null`,
   [report.json](/Users/songmin/quanta-codeagent-v3/.bench-pull/run-1782190012887/report.json:13280)
   에서 `noWinnerReason: "proof_required_missing"`를 기록한다.

결론: 현재 핀된 `run-1782190012887`은 "forked candidate에서 편집은 일어났다"와
"최종 제출 패치는 비었다"는 것은 보여주지만, 그 비어 있음의 직접 원인을
"capture desync"로 확정하진 않는다.

오히려 이 run만 놓고 보면 "candidate는 있었지만 proof-required selector가 아무
candidate도 제출하지 않았다"는 해석이 더 강하다.

### 3.3 코드 chokepoint

fork/concurrency/capture의 실제 chokepoint는 여기다:

- fork copy:
  [sandbox.ts](/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/sandbox.ts:44)
- candidate generation에서 concurrency>1이면 fork 사용:
  [driver.ts](/Users/songmin/quanta-codeagent-v3/src/apps/bench/eval/driver.ts:733)
- done-time capture:
  [snapshot.ts](/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/snapshot.ts:184)
- T5 분류 + infra-fail 라우팅:
  [driver.ts](/Users/songmin/quanta-codeagent-v3/src/apps/bench/eval/driver.ts:483)
  와 [driver.ts](/Users/songmin/quanta-codeagent-v3/src/apps/bench/eval/driver.ts:751)

즉, 다음 작업의 owning surface는 `forkSandbox` / `runAgentPhase` /
`withGitSnapshot` / verify-select candidate path다.

### 3.4 authored claim과 verified receipt를 섞지 말 것

세션 authored 결론은 아래다:

- `QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY=1`로 fork를 피하면 `lost-edits=0`
- `concurrency>1`에서 `11138`은 fork capture desync로 터졌고, T5가 live로 잡음

하지만 이 결론의 exact receipt path는 현재 repo에 핀되어 있지 않다. 따라서
이 문서에서는 이를 **authored-but-unverified-locally**로 취급한다.

후속 작업자는 반드시 둘 다 다시 고정해야 한다:

1. `concurrency>1` arm: `capture_lost_edits` 또는 `lost-edits` 분류가 실제로
   뜨는 observe/report 경로
2. `concurrency=1` arm: 같은 frozen input에서 그 신호가 사라지는 control 경로

그 전까지 "`11138` RCA 확정"이라고 말하면 안 된다. 정확한 표현은
"세션 authored 결론은 capture desync였지만, 현재 repo에 핀된 주 receipt는 그
결론을 아직 직접 증명하지 않는다"이다.

### 3.5 기존 분석 문서와 현재 report가 충돌한다

[REPORT-jun24-three-fails-with-citations.md](/Users/songmin/quanta-codeagent-v3/docs/analysis/jun24-scaffold-absorb/REPORT-jun24-three-fails-with-citations.md:58)
는 현재 `11138`을 방법론 갭이 아니라 fork-worktree patch extraction bug로
단정한다. 그러나 이 문서가 근거로 든
`run-1782190012887`은 위에서 본 것처럼 `proof_required_missing` receipt와
같이 존재한다.

따라서 후속 작업자는 이 분석 문서를 SSOT로 쓰면 안 된다. 현재 SSOT는
`report.json` + `observe/*.jsonl`의 live receipt다.

### 3.6 2026-06-24 후속 local control arm(`concurrency=1`) 시도 결과

이 handoff 작성 후 같은 frozen input으로 local control arm을 다시 시도했다.
이번에는 `chatgpt-oauth`를 임시 prefs home으로 우회해 실제 agent run까지
진입했고, GitHub clone/Django worktree materialize까지는 성공했다.

실행 커맨드:

```sh
QUANTA_PREFS_HOME=/tmp/quanta-auth \
QUANTA_BENCH_HOME=/tmp/quanta-bench \
QUANTA_SWEBENCH_REPO_CACHE=/tmp/quanta-swebench-repo-cache \
QUANTA_BENCH_PRESET=agentless-v4-proof-clean \
QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY=1 \
QUANTA_SWEBENCH_PYTHON=1 \
  bun run src/apps/bench/index.ts \
  --swebench /tmp/frozen3.jsonl \
  --instance django__django-11138 \
  --predictions /tmp/11138-conc1-predictions.jsonl \
  --report /tmp/11138-conc1-report.json
```

하지만 이 arm은 **capture-control receipt를 만들지 못했다**. authoritative
receipt는 report가 아니라 observe다:

- observe:
  `/tmp/quanta-bench/runs/run-1782307202886/observe/run-1782307202886/django__django-11138.0.jsonl`
- stale clone-fail report:
  `/tmp/11138-conc1-report.json`

observe가 직접 입증하는 사실:

1. agent는 실제 patch edit까지 갔다.
   - [django__django-11138.0.jsonl](/tmp/quanta-bench/runs/run-1782307202886/observe/run-1782307202886/django__django-11138.0.jsonl:84)
     에서 `django/db/backends/mysql/operations.py` edit 성공이 보인다.
2. 하지만 첫 repro command가 local Python runtime에서 바로 죽는다.
   - [django__django-11138.0.jsonl](/tmp/quanta-bench/runs/run-1782307202886/observe/run-1782307202886/django__django-11138.0.jsonl:91)
     의 `uv run ... python -s reproduce_issue.py`는
     `failed to allocate a guard page: Invalid argument (os error 22)`로 abort.
3. agent가 fallback으로 때린 repo-local narrower test도 환경에서 막힌다.
   - [django__django-11138.0.jsonl](/tmp/quanta-bench/runs/run-1782307202886/observe/run-1782307202886/django__django-11138.0.jsonl:559)
     의 `python tests/runtests.py --settings=test_sqlite ...`는
     `PermissionError: [Errno 1] Operation not permitted` (`ctypes` → `os.uname()`)
     로 실패.
4. 따라서 이 control arm은 "`lost-edits=0`가 확인된 clean control"이 아니라
   "`local Python execution/runtime blocker 때문에 proof path 자체가 붕괴된 run`"
   이다.

즉, `concurrency=1` control receipt는 아직 없다. 이번 follow-up으로 새로
확정된 것은 두 가지다:

- clone/auth/Django materialize는 통과했다. 이전 sandbox DNS blocker는 넘겼다.
- 다음 blocker는 fork capture가 아니라 **local Python runtime/system-call
  execution seam**이다.

이 결과 때문에 다음 작업자는 `concurrency=1` arm이 조용히 성공할 것이라고
가정하면 안 된다. `11138` capture RCA 검증 전에 local Python execution blocker를
분리하거나, full-remote에서 control arm을 찍는 편이 더 빠를 수 있다.

### 3.7 2026-06-24 read-mode verifier fix 후 local control 재측정

위 blocker를 구조적으로 막은 뒤 같은 control arm을 다시 실행했다. receipt:

- receipt note:
  `docs/analysis/jun24-scaffold-absorb/measure-receipts/11138-readmodefix-conc1-control.md`
- observe:
  `/tmp/quanta-bench/runs/run-1782308528653/observe/run-1782308528653/django__django-11138.0.jsonl`
- report:
  `/tmp/11138-readmodefix-conc1-report.json`
- predictions:
  `/tmp/11138-readmodefix-conc1-predictions.jsonl`

확인된 사실:

1. bash verifier 호출은 `write=12`, `read=0`.
2. `guard page` / `Operation not permitted` / `failed to allocate` / read-mode
   rejection term은 0건.
3. `selectionTelemetry`는 `attempted: 5`, `successfulGenerations: 5`,
   `generationFailures: 0`, `winnerId: null`,
   `noWinnerReason: "proof_required_missing"`를 기록했다.
4. real candidates의 `captureClass`는 `source-captured`였고, 최종 prediction은
   `model_patch: ""`였다.
5. 최종 report는 `grader_invalid` + `empty_patch`로 degraded. gold-patch
   official harness 검증도 `ConnectionError`/`FileNotFound` tail로 실패했다.

해석:

- local Python read-sandbox blocker는 해결됐다.
- 이 `concurrency=1` control은 fork capture desync가 아니라 selector/proof-required
  no-winner를 다시 보여준다.
- 따라서 다음 RCA 분기점은 `concurrency>1`에서 `lost-edits`/`capture_lost_edits`
  가 실제로 뜨는지다.

## 4. 다음 우선순위

1. **`concurrency>1` capture-desync claim receipt부터 다시 핀**
   - 목표: authored claim을 current receipt truth로 끌어올리기
   - 해야 할 일:
     - 같은 frozen input으로 `concurrency=3` arm을 다시 찍고, 위 `=1` control과
       비교한다.
     - `capture_lost_edits` 또는 `lost-edits` 분류가 실제로 뜨는 run 경로를 남긴다.
     - 없다면 `11138` RCA를 capture bug가 아니라 selector/proof-required miss로
       되돌린다.
   - 현재 `concurrency=1` control은 read-mode blocker 없이 완료됐고,
     `source-captured` + `proof_required_missing` no-winner로 고정됐다.
2. **fork capture desync 실제 fix**
   - 위 receipt가 핀된 다음에만 진행
   - 먼저 해야 할 일:
     - `forkSandbox`/`runAgentPhase`/`withGitSnapshot`에 path/git-status 계측을
       박아 "어느 tree에서 edit했고 어느 tree에서 diff를 읽는지"를 고정
   - 추측성 fix 금지. `(a) cwd/LSP pool`, `(b) reset/clean`, `(c) .git linkage`
     가설 중 무엇이 진짜인지 receipt로 먼저 좁힐 것
3. **full-remote로 효과 A/B**
   - local gpt-5.4는 instance당 시간이 너무 길다
   - T1/T2b/T3 promotion A/B는 full-remote가 정본
4. **각 default-OFF lever promotion protocol**
   - `QUANTA_BENCH_SPEC_FIDELITY_INVARIANT` (`13033`)
   - `QUANTA_BENCH_FORWARD_LOCALIZE` (`14315`)
   - `QUANTA_BENCH_FAMILY_COVERAGE=0` baseline (`T1`)
5. **별도 버그**
   - `QUANTA_BENCH_LSP=0`가 preset `lsp:"1"`을 override 못 하는 문제
   - 측정 보조 이슈이지 이번 `11138` owner는 아니다
6. **resolved local infra bug**
   - bash `mode:"read"` / OS sandbox가 local Python verification path를 막던
     문제는 `src/tool/bash/index.ts` preflight + bench prompt steer로 막았다.
   - 검증/재현 command는 `mode:"write"`로 실행되고, read mode는 passive inspection
     전용으로 남는다.

## 5. 검증 / 상태 메모

- 세션 closeout claim:
  - `222 unit green`
  - 미커밋
- 이번 감사에서 재확인한 focused rails:
  - `verification-owner-test-expectations`
  - `adaptive-repair-escalation-owners`
  - `report-telemetry-wiring`
  - `runner/verify-select-driver-parity`
  - `declared-expected-matcher`
  - `capture-correctness`
  - `owner-test-source-search-fallback`
  - `family-coverage-off-switch`
  - `forward-localize-trace`
  - `patch-static-sanity`
  - `scaffold-absorb-jun24-baseline`
- 위 focused bundles는 감사 시점 재실행에서 green이었다.
- full project `tsc`/repo-wide proof는 이 handoff의 목적이 아니다. 이 문서의
  목적은 다음 작업자가 `11138` owning surface와 measurement truth를 헷갈리지
  않게 만드는 것이다.

## 6. 작업자용 한 줄 지시

`11138`의 새 `concurrency=1` control은 `source-captured` + `proof_required_missing`
no-winner다. fork capture bug를 유지하려면 이제 `concurrency>1`에서
`lost-edits`/`capture_lost_edits`를 새 receipt로 직접 보여라. 안 뜨면 RCA를
selector/proof-required miss로 되돌려라.
