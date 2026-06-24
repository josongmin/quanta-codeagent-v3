# jun-24 wave2 handoff — clean selector authority parity

## 범위

- 이번 세션의 초점은 `clean` selector authority 경계가 runner 경로와 app/bench 경로에서 동일하게 유지되는지 확인하고, stale merge / stale parity test를 정리하는 것이었다.
- 현재 세션에서 실제로 더티인 파일:
  - `src/apps/bench/eval/driver.ts`
  - `src/runner/batch/eval/driver.ts`
  - `tests/unit/runner/verify-select-driver-parity.test.ts`
- full bench 재실행은 아직 안 했다. 이번 세션 증거는 코드/테스트 레벨까지만 있다.

## 이번 세션에서 확인된 문제

### 1. app driver가 clean authority 규약에서 stale drift를 일으킬 수 있었음

- runner 쪽은 `selectionAuthorityContracts`와 `advisoryPromptContracts`를 분리해 쓰고 있었는데, app driver 쪽에는 동일 규약이 일부 stale 상태로 남아 있었다.
- 특히 `static-witness` 기반 계약을 prompt/advisory로만 써야 하는데, app driver가 자체 merge path를 들고 있어서 다시 authority 쪽으로 새어들 위험이 있었다.
- 이번 세션에서 이 부분은 `mergePublicContractBundles(...)` 기반으로 runner/app 모두 맞췄다.

### 2. 동일 로직이 runner/app driver에 중복되어 drift 재발 위험이 큼

- runner:
  - `src/runner/batch/eval/driver.ts:2952`
  - `src/runner/batch/eval/driver.ts:3008`
  - `src/runner/batch/eval/driver.ts:3440`
- app:
  - `src/apps/bench/eval/driver.ts:1208`
  - `src/apps/bench/eval/driver.ts:1295`
  - `src/apps/bench/eval/driver.ts:1107`
- 지금도 verify-select assembly, evidence context build, prompt/advisory wiring이 두 군데에 나뉘어 있다.
- 이번 bug도 그 중복 때문에 app path만 stale하게 남은 케이스였다.

### 3. parity test가 동작 보장보다 source-string shape pin에 너무 의존함

- `tests/unit/runner/verify-select-driver-parity.test.ts`는 실제 의미론 대신 source string을 많이 핀한다.
- helper extraction이나 naming 정리만 해도 테스트가 연쇄적으로 깨졌다.
- 이번 세션에서도 깨진 대부분은 runtime regression이 아니라 stale assertion이었다.

### 4. nomenclature transition이 아직 끝나지 않음

- authority naming으로 옮겼지만 back-compat alias가 남아 있다.
- 현재 잔존 alias:
  - `src/runner/batch/eval/public-contract-bundle.ts:187`
    - `buildCleanSelectionPublicContracts`
  - `src/runner/batch/eval/driver.ts:3861`
    - `withCandidateFamilyPublicContracts`
  - `src/runner/batch/eval/public-contract-types.ts:94-95`
    - `PublicContract`
    - `PublicContractBundle`
- 기능상 문제는 아니지만, clean authority vs advisory 경계를 코드 읽기에서 흐리게 만든다.

## 이번 세션에서 닫은 것

- runner/app driver 모두 `selectionAuthorityContracts` vs `advisoryPromptContracts` split을 유지하도록 수정.
- runner 쪽 `SelectionExecutorPortsArgs` 내부 이름을 `promptContracts`로 바꿔 authority/advisory 혼동을 줄임.
- app driver의 stale merge 호출을 공용 `mergePublicContractBundles(...)`로 교체.
- `exactOptionalPropertyTypes` 위반이던 `reproOracleCalibration` optional attach를 고침.
- parity test를 현재 helper-based shape에 맞게 갱신.

## 앞으로 해야 할 일

### P0. verify-select shared assembly를 공용 모듈로 추출

- 목적:
  - runner/app driver가 clean authority 규약을 각자 다시 구현하지 않게 만들기.
- 이유:
  - 현재 구조에서는 한쪽만 stale해져도 clean selector authority가 다시 오염될 수 있다.
- 최소 범위:
  - selection evidence context build
  - advisory/authority contract merge
  - selection ports assembly
  - generation prompt seed assembly
- 완료 기준:
  - app/runner 둘 다 동일 shared helper를 호출하고, parity test가 "문자열 일치"가 아니라 "동일 helper 사용/동일 결과"를 검증한다.

### P1. parity test를 behavior-level contract test로 낮추기

- 목적:
  - source formatting이나 helper extraction 때문에 깨지는 취약한 문자열 테스트를 줄이기.
- 이유:
  - 이번 세션에서 테스트 failure 다수가 runtime regression이 아니라 stale source-shape assertion이었다.
- 제안:
  - pure helper export 후 입력 fixture -> 출력 bundle/ports/assertion으로 전환
  - 또는 runner/app 양쪽이 `runSelection(...)`에 넘기는 핵심 args를 snapshot/contract test로 비교
- 완료 기준:
  - source-string pin은 최소한의 wiring sentinel만 남기고, authority/advisory semantics는 값 기반 테스트로 옮긴다.

### P2. authority naming migration 완료 후 alias 제거

- 목적:
  - `PublicContract*` 구 nomenclature를 걷어내고 authority/advisory 경계가 이름에서도 드러나게 만들기.
- 이유:
  - 지금 alias는 migration 완충재이지만, 오래 두면 다시 old mental model이 돌아온다.
- 제안:
  - internal caller를 `SelectionContract*`, `buildCleanSelectionAuthorityContracts`, `withCandidateFamilyAuthorityContracts`로 통일
  - 마지막에 alias 제거
- 완료 기준:
  - 위 4개 alias가 전부 사라지고 type/search 결과가 clean authority naming만 남는다.

### P3. post-fix bench evidence 확보

- 목적:
  - 이번 수정이 실제 bench path에서도 동일하게 작동하는지 확인.
- 이유:
  - 이번 세션의 검증은 테스트/타입체크까지만 됐고, full bench receipt는 아직 없다.
- 제안:
  - representative clean cases로 최소 smoke rerun
  - app/bench 경로를 실제로 태우는 verify-select / clean selector 케이스 우선
- 완료 기준:
  - post-fix run에서 app path가 authority/advisory split을 유지했다는 evidence를 report/telemetry로 확인

## 검증 상태

- `bun test tests/unit/runner/verify-select-driver-parity.test.ts`
- `bun test tests/unit/runner/verify-select-driver-parity.test.ts tests/unit/public-contract-bundle.test.ts tests/unit/selection-executor.test.ts tests/unit/selection-clean-mode.test.ts`
- `bun run typecheck`
- `git diff --check`

전부 통과.

## 주의

- 이 handoff는 clean selector authority / verify-select parity seam만 다룬다.
- `src/apps/bench/eval/driver.ts`는 현재도 큰 파일이고, 이 주변에는 다른 리팩터링 문맥이 섞여 있다. sweep commit보다 seam 단위 커밋이 안전하다.
