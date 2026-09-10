# TV-09 — 중량 테스트를 canary와 exhaustive로 분리

- 우선순위: P1
- 상태: IMPLEMENTING — exact tier wiring과 Biome nightly entrypoint 착륙; 나머지 fuzz/toolchain split과 hosted activation 미완료
- 소유자: C (영역별 파일 write set 분리)
- 선행: TV-02
- PR 기본 범위 축소 선행: TV-03, TV-13의 실제 연결

## 문제와 근거

Git fuzz, Biome 전체 reach, CLI 조합, PTY, 실제 언어 도구가 반복 loop에 함께 들어 있다. 단순 파일 이동은 coverage를 숨길 수 있으므로 기존 case/seed universe를 보존하며 실행 빈도를 나눈다.

2026-09-11 현재 conflict differential fuzz의 고비용 부분은 `QUANTA_TEST_STRESS=1`로 nightly gating돼 있다. Biome exhaustive oracle은 `lint-debt-reach-e2e.nightly.test.ts`로 물리 분리되어 working-tree discovery 기준 PR/full 3,924 files, nightly 3,925 files다(신규 certification unit 포함). 나머지 fuzz/toolchain은 아직 같은 파일 내부 stress branch이므로 추가 분리가 필요하다.

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
| `tests/unit/git/conflict-parser-differential-fuzz.test.ts` | `BASE_SEED`, `GIT_CASES = 60`, real-git loop, constructed adversarial cases | generator/seed/case descriptor를 sibling fixture로 추출한다. PR canary는 고정 6 case와 known regressions, exhaustive는 기존 60 seed와 모든 constructed case를 실행한다. | PR∪nightly case IDs가 기존 universe와 같고 seed 재현 가능. |
| `src/apps/bench/composition-root-dispatch.test.ts` | `runCliBatch`, `FAMILY_BEARING`, `BAD_SELECTORS`, 다수 cross-product describe | invocation/grade helpers는 공유하고 PR에는 subcommand별 valid/invalid 최소 pair, exhaustive에는 전체 cross-product를 둔다. | selector/command pair inventory set equality. |
| `tests/integration/lint-debt-reach-e2e.nightly.test.ts` | `biomeDiagnosticsOverRoots`, root-wide oracle test | nightly exact entrypoint로 분리한다. PR에서는 file load 자체를 제거하되 config/target/receipt 변경은 selector가 nightly-required/full-required 이유를 반환한다. | nightly manifest 포함, PR manifest 제외, invalid target injection RED. |
| `tests/e2e-pty/` | 각 파일의 `describe.skipIf(!PTY_AVAILABLE)` | `cli-input-layer`, `cli-goal-pursuit`, `cli-hunk-approval`을 기본 canary 후보로 등록한다. PTY 부재는 required capability lane에서 pass가 아니라 capability failure다. | 관련 CLI path 변경 시 전체 affected PTY 선택. |
| `tests/unit/project-env-astropy-real-e2e.test.ts` | `D`, `ASTROPY_13033`, `runRepro` | 실제 toolchain case는 nightly/cold 전용으로 정책 등록하고 작은 fake contract는 별도 unit에 둔다. 현재 real assertion을 mock으로 대체하지 않는다. | base/proof 두 경로와 environment/setup failure 분리. |
| `tests/integration/mcp-auto-restart-real-process-e2e.test.ts`, `tests/integration/session-stress-and-concurrent.test.ts` | real process/stress cases | crash/restart 및 lost-update known regression은 PR canary로 남기고 반복 횟수/대량 matrix만 exhaustive로 이동한다. | case ID 합집합과 teardown 검증. |
| `tools/dev/test-policy.ts`, `tools/dev/test-policy-overrides.json` | `TestPolicy.tiers`, `resolveTestPopulation` | default-only full 정책을 실제 smoke/prepush/pr/full/nightly file membership으로 확장한다. generated defaults와 explicit exceptions의 owner를 하나로 둔다. | tier union/exact set, unknown tier, duplicate test ID, empty tier RED. |
| `tools/dev/test-shard-options.ts`, `tools/dev/run-test-shards.ts` | NEW `--tier`, discovery filter | suite discovery 후 exact tier policy로 파일을 필터링하고 tier/policy/population/membership digest를 receipt에 결합한다. | 같은 count/다른 file set, unknown tier, policy drift reject. |

## 작업 순서

1. TV-07 자료로 상위 wall-time 파일을 확정한다.
2. 각 파일의 case/seed ID inventory를 먼저 고정한다.
3. helper만 추출하고 canary/exhaustive entrypoint를 만든다.
4. TV-02 정책과 TV-03 affected mapping에 두 population을 등록한다.
5. TV-13 nightly의 실제 실행 receipt가 생긴 뒤에만 PR exhaustive 실행을 제거한다.
6. PR selector shadow에서 full failure false-skip 0을 확인한 뒤 tier 축소를 required 경로에 활성화한다.

## 검증 계획

case/seed inventory를 비교해 기존 사례가 PR/nightly 합집합에서 빠지지 않게 한다. known bug를 주입하면 PR canary가 실패해야 한다. affected CLI/MCP/LSP path 변경 시 해당 실제 실행 lane이 선택되는지 TV-03과 통합 검증한다. 실제 process 테스트는 작은 선택 집합만 실행하고 stress 전체는 TV-90까지 보류한다.

## 완료 기준

- [ ] 상위 중량 파일의 실행 빈도와 owner가 명확함.
- [ ] 기존 case universe 누락 0.
- [ ] 관련 변경 시 필요한 real runtime 검증이 PR에 남음.
- [ ] nightly 미연결 상태에서 PR 검증을 삭제하지 않음.
- [ ] 단순 timeout 증가·skip 증가로 속도를 만들지 않음.
- [ ] PR/full/nightly exact file manifests가 서로 구분되고 receipt에 고정됨.
- [ ] 같은 파일 안의 runtime skip을 file membership 분리로 계산하지 않음.

## 실패·복구

nightly 이동으로 발견 지연이 발생하면 해당 회귀를 작은 PR case로 추가한다. 테스트 전부를 반복해서 로컬 full에 되돌리는 대신 영향 정책과 canary를 수정한다.
