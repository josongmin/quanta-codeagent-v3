# jun-24 wave2 aggregated backlog — 실제 다음 작업만 남긴 버전

## 목적

- `docs/handoff/jun-24-wave2-*` 5개를 합쳐서, 이미 landed 한 작업과 stale 서술을 걷어내고 **실제로 다음 세션이 해야 할 일**만 남긴다.
- 기준은 현재 `main` HEAD의 코드 상태다. 문서 안의 "working tree only" / "아직 미적용" 진술은 현재 코드와 다르면 따르지 않는다.

## 이번 집계에서 제외한 것

### 이미 landed 한 것

- clean selector authority split 자체는 이미 landed 상태다.
  - `src/runner/batch/eval/public-contract-bundle.ts`
  - `mergePublicContractBundles(...)`
  - `tests/unit/runner/verify-select-driver-parity.test.ts`
- repro oracle hardening P0-P4, project-env materialization, `withCandidatePatch(...)` proof seam, CHA analyzer도 이미 코드에 있다.
  - `src/runner/batch/corpus/project-env.ts`
  - `src/runner/batch/eval/repro-oracle-calibration.ts`
  - `src/runner/batch/eval/cha-multisite.ts`
- django-11138 계열의 bare-`python` repro 실행 RCA는 구조적으로는 닫힌 상태다.
  - 실제 repro 실행 SSOT는 `reproRunArgv(...)` / `buildProjectEnvUvRunArgv(...)`다.
  - closure/verification 쪽 shell string도 `reproValidationCmd(...)`가 같은 argv를 렌더한다.
  - 남은 일은 새 설계를 만드는 게 아니라 fresh-box에서 receipt를 다시 확인하는 것이다.
- static-engine handoff 문서에서 "working tree only"로 적힌 2개도 현재 HEAD에는 이미 있다.
  - `tests/unit/no-benchmark-overfit-steer-ratchet.test.ts`
  - `src/runner/knobs/presets.ts`의 `agentless-v3-thin-strict-execfull`

### backlog로 잡지 않을 것

- 새 LSP-이상 정적엔진(call-graph/data-flow/MRO/KG) 구축
  - wave2 문서들의 공통 결론은 이게 핵심 레버가 아니라는 쪽이다.
- `validation_fail_tail` head/tail SSOT 정리
  - northstar handoff에서 명시적으로 user-owned로 분리되어 있다.
- repro oracle P0-P4를 처음부터 다시 만드는 작업
  - 이미 닫힌 축이다. reopen 조건은 새 regression receipt가 있을 때뿐이다.

## 실제 backlog

### P0. `proof-required`를 env로 끌 수 있게 고치기

- 이건 measurement unblocker다. 먼저 해야 한다.
- 현재 `agentless-v4-proof-clean`은 preset에서 `verify-select-proof-required: "1"`을 강제로 켠다.
  - `src/runner/knobs/presets.ts`
- 그런데 `src/runner/knobs/knobs/verify-select-proof-required.ts`는 `0/off/false`를 `undefined`로 파싱한다.
- 그래서 `QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED=0`을 줘도 preset 값으로 다시 fallback 된다.
- 현재 HEAD에서 실제로 확인된 상태:
  - preset=`agentless-v4-proof-clean`
  - env=`QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED=0`
  - resolved result=`{ source: "preset", value: true, posture: true }`

해야 할 일:

- explicit false를 표현할 수 있게 knob parse/typing을 바꾸거나, 적어도 preset suppression이 가능하게 layer semantics를 고친다.
- `proof-clean + env off => verifySelectProofRequired=false`를 박는 hellgate/unit test를 추가한다.
- 그 다음에만 proof-off A/B를 다시 믿을 수 있다.

### P1. patch provenance를 fail-closed로 만들기

- wave2 측정 사고의 재발방지 축이다.
- 현재 runner는 predictions에는 `model_patch`를 쓰지만 report에는 `patchBytes`만 남긴다.
  - `src/runner/batch/core.ts`
  - `src/runner/batch/report.ts`
- 그래서 사후 분석에서 report만 보면 patch body를 복원할 수 없고, 별도 jsonl을 잘못 읽으면 dataset의 `patch`를 model patch로 오인하기 쉽다.

해야 할 일:

- 분석 유틸은 `model_patch`/`modelPatch`만 신뢰하고, dataset row shape인 `base_commit`/`FAIL_TO_PASS`/`PASS_TO_PASS`가 있으면 즉시 reject 하게 만든다.
- 분석 전에 report provenance를 fail-closed로 거는 helper/check를 둔다.
  - 최소 기준: `timestamp`, `knobs.preset`, answer-key 제거 경계 이후 receipt인지 확인
- campaign artifact에 최소한 아래 중 하나는 남긴다.
  - `--predictions`를 모든 campaign에서 필수화
  - report에 `modelPatchDigest` + `touchedFiles`를 저장
- "dataset row를 prediction으로 읽으면 throw" 테스트를 하나 박아 둔다.

### P2. 깨끗한 재측정 레일을 다시 세우기

- P0/P1 전에는 어떤 A/B도 결론으로 쓰면 안 된다.
- authoritative source는 full run + clean predictions여야 한다.
- n=1 수동 snapshot, `manual-jun23`, old profile report를 다시 결론 근거로 쓰면 안 된다.

해야 할 일:

- 회귀 클래스 측정:
  - `agentless-v3-thin-strict`
  - `agentless-v3-thin-strict-execfull`
- 멀티파일 completeness 측정:
  - `model_patch` 기준
  - multi-file gold picks `n>=5`
  - repro oracle healthy instance만 포함
- 판정 기준:
  - `empty_patch` 단독 해석 금지
  - `submitted patch coverage + resolved 여부`를 같이 본다

### P3. multi-site/completeness gap을 기존 구조 위에서 닫기

- 새 정적엔진을 만들 문제가 아니라, 이미 있는 구조가 "찾았지만 강제하지 않는" 상태인 게 문제다.
- 이미 있는 표면:
  - `src/runner/batch/eval/candidate-families.ts`
  - `src/runner/batch/eval/cha-multisite.ts`
  - owner/family coverage 관련 selection telemetry

해야 할 일:

- owner-family가 잡힌 케이스에서 "family member 전체를 만졌는가"를 submit/admission 쪽에서 더 강하게 다룬다.
- CHA는 "모든 override"가 아니라 "이번 bug 증상을 공유하는 sibling"으로 좁혀야 한다.
  - structural override 집합 그대로 steer에 넣으면 over-inclusion으로 turn만 터진다.
- symptom-coupled filtering 뒤에도 execution이 퍼지면, N개 site에 같은 변환을 bounded하게 적용하는 co-edit primitive를 검토한다.

### P4. env/oracle 잔존 이슈는 fresh-box confirmation으로 닫기

- astropy env는 새 설계보다 "현 코드가 실제 box에서 닫혔는지" 확인하는 단계다.
- django-11138 `python: command not found`류도 같은 분류다.
  - 현재는 코드 구조 문제가 아니라 fresh-box receipt 재확인 문제로 본다.
- 현재 코드에는 이미 다음이 들어 있다.
  - `extension-helpers` build dep materialization
  - `setuptools.dep_util -> distutils.dep_util` source shim
  - `withCandidatePatch(...)` 경로 재-materialization
  - real/hellgate tests

해야 할 일:

- `astropy__astropy-13033`는 fresh box rerun으로 env/build collapse가 진짜 사라졌는지 확인한다.
- `django__django-11138`는 fresh box rerun으로 bare-`python` receipt가 재발하는지 확인한다.
  - 재발하면 새 RCA를 열기 전에 prompt/hint drift인지 실제 exec path regression인지 먼저 분리한다.
- full-remote에서 아직도 `reproOracleCalibration.available=false`가 나오면, 그건 새 oracle 설계 문제가 아니라 box path wiring 문제로 분리해서 잡는다.

### P5. clean-selector 쪽은 구조 정리만 남음

- clean selector authority fix 자체는 이미 landed다.
- 남은 건 correctness blocker라기보다 drift 재발 방지용 구조 정리다.

해야 할 일:

- runner/app verify-select assembly를 shared helper로 추출
- parity test를 source-string pin 위주에서 behavior-level contract test로 내리기
- `PublicContract*` 계열 alias 정리
- post-fix smoke bench evidence 1회 확보

### P6. global unresolved 다수는 생성 정확도 / oracle-first 축으로 따로 밀기

- wave2 문서들의 공통 결론상, 새 정적엔진보다 이 축이 더 큰 본류다.
- 특히 static-engine audit의 `gradeBreakdown` 해석에서는 unresolved 다수의 지배모드가
  "자리 못 찾음"보다 "자리 맞고 답 틀림" 쪽이었다.

해야 할 일:

- P0/P1/P2로 measurement hygiene를 복구한 뒤, global corpus 개선은 생성 정확도 / repro-oracle 품질 축으로 분리해서 다룬다.
- multi-site completeness와는 별도 트랙으로 운영한다.
- 새 정적엔진 신규 구축은 여기서도 비-목표로 유지한다.

## 권장 실행 순서

1. P0 `proof-required` env override 수정
2. P1 patch provenance guard
3. P2 재측정 레일 재가동
4. P3 multi-site/completeness contract 작업
5. P4 fresh-box confirmation
6. P5 clean-selector refactor cleanup
7. P6 generation/oracle-first 개선

## 한 줄 판단

- wave2의 실제 핵심은 "새 정적엔진 필요"가 아니라, **measurement unblock + provenance hygiene + completeness contract**다.
- 다음 세션이 바로 손대야 하는 건 P0/P1이고, 그 다음이 P2/P3다.

## Ticket Breakdown

아래는 바로 issue/ticket로 쪼갤 수 있는 dependency-ordered 작업 단위다.

### W2-01 - proof-required explicit false override

## Goal

`QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED=0`이 preset 값을 실제로 끄게 만든다.

## Files

- `src/runner/knobs/knobs/verify-select-proof-required.ts`
- `src/runner/batch/eval/knobs-bench.ts`
- `tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `tests/unit/proof-closure-knobs-wiring.test.ts`

## Deps

- 없음

## Acceptance

- `agentless-v4-proof-clean + QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED=0`에서 최종 posture가 `false`다.
- explicit false가 preset fallback으로 다시 켜지지 않는다.
- proof-off A/B를 막던 현재 재현 케이스가 unit/hellgate로 고정된다.

### W2-02 - measurement provenance gate

## Goal

오염된 report를 analysis 입력으로 쓰기 전에 fail-closed로 걸러낸다.

## Files

- `src/apps/bench/analyze/*`
- `src/runner/batch/core.ts`
- `tests/unit/*report*`
- `tests/integration/bench*.test.ts`

## Deps

- 없음

## Acceptance

- report `timestamp` / `knobs.preset` / 필요한 provenance 필드가 없으면 analysis가 경고가 아니라 reject 한다.
- answer-key 제거 경계 이전 receipt를 "clean evidence"로 오인하지 않는다.

### W2-03 - dataset-vs-prediction patch-source guard

## Goal

dataset row의 `patch`를 model patch로 읽는 풋건을 코드로 차단한다.

## Files

- 분석 유틸이 있는 실제 모듈
- `src/runner/batch/corpus/dataset.ts`
- `tests/integration/swebench-dataset.test.ts`
- 관련 analysis test

## Deps

- 없음

## Acceptance

- prediction 입력은 `model_patch`/`modelPatch`만 허용한다.
- `base_commit`/`FAIL_TO_PASS`/`PASS_TO_PASS`가 있으면 dataset row로 간주하고 reject 한다.
- "dataset row를 prediction으로 읽으면 throw" 테스트가 있다.

### W2-04 - patch evidence persistence in report/campaign artifacts

## Goal

사후 분석에 필요한 patch evidence를 report 또는 campaign artifact에 남긴다.

## Files

- `src/runner/batch/core.ts`
- `src/runner/batch/report.ts`
- `src/apps/bench/cli.ts`
- report/integration tests

## Deps

- W2-03

## Acceptance

- 둘 중 하나는 반드시 만족한다.
- 모든 campaign이 `--predictions`를 강제한다.
- 또는 report에 `modelPatchDigest` + `touchedFiles`가 들어간다.
- patch body 부재 때문에 post-hoc coverage 분석이 막히지 않는다.

### W2-05 - thin-strict vs execfull A/B rail

## Goal

`bench-in-loop-exec: off`가 회귀 클래스에 주는 영향만 분리 측정한다.

## Files

- `src/runner/knobs/presets.ts`
- `src/apps/bench/cli.ts`
- `src/apps/bench/analyze/*`
- 관련 preset/report tests

## Deps

- W2-01
- W2-02
- W2-04

## Acceptance

- `agentless-v3-thin-strict` vs `agentless-v3-thin-strict-execfull` 비교 레일이 문서화된다.
- 회귀 감소와 empty-patch/flail 비용을 같은 측정 테이블에서 본다.
- 별도 해석 없이 rerun 가능한 recipe가 남는다.

### W2-06 - multi-file coverage census

## Goal

현재 병목이 실제로 multi-file under-coverage인지 clean receipt로 확정한다.

## Files

- analysis code/path
- report/predictions ingest code
- 필요 시 `src/apps/bench/analyze/*`

## Deps

- W2-02
- W2-03
- W2-04

## Acceptance

- multi-file gold picks `n>=5`에서 `our touched files vs gold files` 분포가 나온다.
- `model_patch` 기준만 사용한다.
- n=1 snapshot이나 contaminated artifact가 섞이지 않는다.

### W2-07 - symptom-coupled CHA sibling filter

## Goal

CHA steer가 "all overrides"가 아니라 "buggy siblings only"를 가리키게 만든다.

## Files

- `src/runner/batch/eval/cha-multisite.ts`
- `src/agent/localize-phase-guard.ts`
- `src/runner/batch/eval/driver.ts`
- `tests/unit/*cha*`

## Deps

- W2-01
- W2-06

## Acceptance

- non-buggy override가 steer에 자동 포함되지 않는다.
- django-11138/14315 류에서 over-inclusion 근거가 줄어든다.
- transitive override correctness는 유지된다.

### W2-08 - bounded co-edit primitive for multi-site fixes

## Goal

이미 찾은 N개 site에 같은 변환을 turn explosion 없이 적용하는 bounded primitive를 만든다.

## Files

- multi-site repair/apply seam
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/selection-repair-seed.ts`
- `tests/unit/*selection*`

## Deps

- W2-07

## Acceptance

- multi-site execution이 per-site 재유도 루프 없이 bounded하게 끝난다.
- "site는 맞는데 300+ turns spiral" 클래스가 재현 가능하게 줄어든다.

### W2-09 - fresh-box env/oracle confirmation receipts

## Goal

현재 코드가 실제 remote box에서도 닫혔는지 fresh receipt로 확인한다.

## Files

- runtime code 변경이 없을 수도 있음
- runbook / handoff / report artifacts

## Deps

- W2-01

## Acceptance

- `django__django-11138`에서 bare-`python` 재현이 다시 나오지 않는다.
- `astropy__astropy-13033`에서 env/build collapse 재현 여부가 fresh box receipt로 분류된다.
- `reproOracleCalibration.available=false`가 남으면 box wiring issue로 별도 분리된다.

### W2-10 - verify-select shared assembly extraction

## Goal

runner/app verify-select assembly 중복을 shared helper로 모은다.

## Files

- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- 새 shared helper module
- `tests/unit/runner/verify-select-driver-parity.test.ts`

## Deps

- 없음

## Acceptance

- app/runner가 같은 helper를 호출한다.
- authority/advisory merge, evidence context, prompt seed assembly drift surface가 한 곳으로 줄어든다.

### W2-11 - parity contract rewrite

## Goal

verify-select parity test를 source-string pin에서 behavior contract test로 내린다.

## Files

- `tests/unit/runner/verify-select-driver-parity.test.ts`
- extracted helper tests

## Deps

- W2-10

## Acceptance

- helper extraction/rename만으로 parity suite가 깨지지 않는다.
- 의미론 차이만 red가 난다.

### W2-12 - authority naming cleanup

## Goal

`PublicContract*` alias를 제거하고 authority/advisory naming으로 통일한다.

## Files

- `src/runner/batch/eval/public-contract-bundle.ts`
- `src/runner/batch/eval/public-contract-types.ts`
- `src/runner/batch/eval/driver.ts`
- 관련 tests

## Deps

- W2-10
- W2-11

## Acceptance

- `buildCleanSelectionPublicContracts`
- `withCandidateFamilyPublicContracts`
- `PublicContract`
- `PublicContractBundle`
- 위 잔존 alias가 제거되거나 compatibility shim으로만 남고 내부 검색 결과는 authority naming 중심이다.

### W2-13 - post-fix clean-selector smoke receipt

## Goal

clean selector fixes가 실제 bench path에서 유지되는지 최소 smoke receipt를 남긴다.

## Files

- runtime code 변경이 없을 수도 있음
- smoke recipe / report artifacts

## Deps

- W2-10
- W2-11
- W2-12

## Acceptance

- representative clean selector case에서 app path authority/advisory split이 유지된 receipt가 있다.
- "test/typecheck green only" 상태를 넘어서 실제 bench-path evidence가 남는다.

### W2-14 - generation/oracle-first improvement track kickoff

## Goal

global unresolved majority를 multi-site completeness와 분리해서 generation/oracle-first 트랙으로 연다.

## Files

- plan/handoff/analysis docs
- 필요한 경우 repro/oracle/generation modules

## Deps

- W2-02
- W2-04
- W2-06

## Acceptance

- corpus-level 개선 트랙이 "multi-site completeness"와 분리된 backlog/measurement를 가진다.
- 새 정적엔진 구축 없이도 다음 개선축이 generation accuracy / oracle quality라는 점이 plan에 고정된다.
