---
instance_id: scikit-learn__scikit-learn-14141
repo: scikit-learn/scikit-learn
base_commit: 3d997697fdd166eff428ea9fd35734b6a8ba113e
version: "0.22"
difficulty: "<15 min fix"
created_at: 2019-06-21T20:53:37Z
fail_to_pass: 1
pass_to_pass: 2
gold_files: [sklearn/utils/_show_versions.py]
primary_type: T-LocTrivial
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [overfit-risk]
---

## 문제 요약

`sklearn.show_versions()`가 출력하는 의존성 목록에 `joblib`이 빠져 있다. sklearn 0.20+ 부터 joblib이 독립 패키지로 분리되어 핵심 의존성이 되었으므로, 버전 진단 출력에 joblib 버전도 포함되어야 한다. 이슈 본문이 추가해야 할 정확한 대상(joblib)과 위치(show_versions의 의존성 목록)를 직접 명시한다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)**: 이슈 제목 "Add joblib in show_versions"가 함수(`show_versions` → 내부 `_get_deps_info`)와 추가 대상(joblib)을 직접 지목. `grep -rn "show_versions"` 한 방으로 `sklearn/utils/_show_versions.py`에 수렴. 탐색 사실상 불필요.
- **S (Repair Strategy) = S1 (Direct-Map)**: 이슈가 픽스를 사실상 명세한다. `_get_deps_info()` 내부의 `deps` 리스트에 `"joblib"` 문자열 한 줄을 append하는 순수 기계적 작업. 추론 합성 없음.
- **K (Knowledge) = K-Gen**: 일반 파이썬 리스트 편집으로 충분. "joblib이 0.20+에서 의존성이다"라는 사실은 이슈가 이미 제공하므로 도메인 내부지식 병목 없음.
- **Primary = T-LocTrivial**: L0 + S1. 찾으면 끝이고 픽스가 자명한 전형적 trivial 케이스. constraint 추론도, 스펙 재구성도 없다.

APR 관점: 이는 PAR/TBar류의 **템플릿 매칭**조차 필요 없는, 이슈 본문→리터럴 추가의 1:1 매핑(S1)이다. 후보 패치 공간이 단일하여 generate-&-validate 반복이 불필요하다.

## 난이도 티어

**T1 (존나쉬움)**. 구조적 피처:
- 파일수 1개, 변경 줄수 +1줄 (리스트 원소 하나).
- localize 직접성 최상(L0): 이슈가 심볼을 적어줌.
- 도메인 지식 0: 일반 리스트 편집.
- P2P trap 약함: PASS_TO_PASS 2건(`test_get_sys_info`, `test_show_versions_with_blas`)은 인접 함수라 joblib 추가가 영향 없음.

공식 라벨 "<15 min fix"와 완전히 일치한다(1파일·1줄 → ICLR 2024 컷에서 가장 쉬운 구간, ~48% 이상 solve 대역). 단, repro 코드/스택트레이스는 없어(`has-repro` 미부여) 자동 재현은 안 되지만, 이슈가 픽스를 명세하므로 난이도에 영향 없음.

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/utils/_show_versions.py`의 `_get_deps_info()`.
- **근본원인**: 함수 내부 `deps` 리스트가 진단 대상 모듈을 하드코딩하는데(`"pip"`, `"setuptools"`, `"sklearn"`, `"numpy"`, `"scipy"`, `"Cython"`, `"pandas"`, `"matplotlib"`), joblib이 0.20+에서 vendored 상태를 벗어나 독립 의존성이 되었음에도 이 목록이 갱신되지 않음 — 누락(missing entry) 결함.
- **수정요지**: `deps` 리스트의 `"matplotlib"` 다음에 `"joblib"` 한 줄 추가. 이후 동일 함수의 `get_version` 클로저가 자동으로 importlib로 버전을 조회하므로 추가 배선 불필요.

## 검증 (test_patch)

- **FAIL_TO_PASS**: `test_get_deps_info` — 기존에 `'numpy'`, `'scipy'`, `'pandas'`, `'matplotlib'` 등의 키 존재를 단언하던 테스트에 `assert 'joblib' in deps_info` 한 줄 추가. 패치 전에는 `deps_info`에 `'joblib'` 키가 없어 KeyError가 아니라 단언 실패로 RED, 패치 후 GREEN.
- **픽스 증명**: 단언이 `_get_deps_info()` 반환 dict의 키를 직접 검사 → 리스트에 `"joblib"`가 들어가야만 통과. 픽스와 테스트가 동일 경로를 관통.
- **overfit·regression 관점**: `overfit-risk` 플래그. 테스트는 "joblib 키가 존재하는가"만 확인하고 버전 문자열의 정확성/포맷은 검증하지 않는다. 그러나 이 도메인에선 키 추가가 곧 일반화(다른 의존성과 동일 경로)이므로 special-case 위험은 낮다. regression: `deps` 리스트에 원소를 추가만 하므로 기존 키들의 동작 불변 → PASS_TO_PASS 2건 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈 제목의 "show_versions"로 `grep` → `sklearn/utils/_show_versions.py`. 공개 `show_versions()`가 `_get_deps_info()`를 호출하고, 그 안의 `deps` 리스트가 진단 대상 모듈명을 보유함을 확인. 추가 지점이 이 리스트임이 자명.
2. **픽스와 일반화**: `deps` 리스트에 `"joblib"` 추가. 이는 overfit이 아니라 올바른 일반화 — 기존 모듈들과 **동일한** `get_version`/importlib 경로를 타므로 joblib 전용 분기를 만들지 않는다. 이슈가 명시한 "0.20+에서 joblib이 의존성"이라는 사실과 정확히 부합.
3. **regression 안전**: 리스트 append만 하므로 `test_get_sys_info`(시스템 정보 경로)와 `test_show_versions_with_blas`(BLAS 출력 경로)는 무영향. 기존 의존성 키들의 조회 로직도 그대로.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) joblib을 전용 try/except나 별도 함수로 과잉 처리(불필요한 분기, 일반화 깨짐); 정답은 리스트 한 줄. (b) 이슈의 "또는 issue template에 추가" 대안에 휩쓸려 `.github/ISSUE_TEMPLATE`를 건드리는 것 — 골드는 코드 경로만 택했고 테스트도 코드 경로만 검증하므로 template 수정은 무관/오답 노이즈. (c) 다른 `show_versions` 호출 사이트를 찾아 헤매기 — 단일 리스트가 SSOT이므로 불필요.
