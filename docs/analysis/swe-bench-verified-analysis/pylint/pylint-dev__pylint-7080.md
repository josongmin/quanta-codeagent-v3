---
instance_id: pylint-dev__pylint-7080
repo: pylint-dev/pylint
base_commit: 3c5eca2ded3dd2b59ebaf23eb289453b5d2930f0
version: "2.15"
difficulty: "15 min - 1 hour"
created_at: "2022-06-28T17:24:43Z"
fail_to_pass: 1
pass_to_pass: 120
gold_files: [pylint/lint/expand_modules.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`pylint --recursive=y`로 디렉토리(특히 `.`)를 검사할 때 `ignore-paths` 설정이 무시되어, 무시되어야 할 경로(`src/gen/*`)가 검사된다. 핵심 재현은 인자를 `.`로 줄 때 발생한다 — 수집된 경로가 `./src/gen/...`처럼 `./` 접두가 붙어 정규화되지 않은 채 `ignore-paths` 정규식(`^src/gen/.*$`)과 매칭에 실패한다. 이슈 코멘트가 근본원인(경로 정규화 누락)과 픽스(`os.path.normpath()`)까지 명시한 강한 repro 케이스다.

## 유형 (정형화)

- **L (Localization) = L1.** 이슈 코멘트가 `pylinter.py:600-607`의 스킵 결정 지점과 `root`/`ignore_paths` 변수까지 pdb로 짚어준다. 다만 실제 골드 픽스 지점은 그 호출 경로 하류의 `expand_modules._is_ignored_file`이라 키워드(`ignore-paths`, `normpath`)로 단일 파일 후보 수렴에 약간의 추적이 필요. 직접 심볼 지목은 아니므로 L0이 아닌 L1.
- **S (Repair Strategy) = S2 (+S1).** 픽스 자체는 `element = os.path.normpath(element)` 한 줄로 기계적(S1)이지만, "어디서 정규화해야 basename·정규식 양쪽 매칭이 동시에 맞는가"를 추론해야 한다. `os.path.normpath`는 `./src/gen` → `src/gen`으로 접두를 제거하므로 정규식 `^src/gen/.*$`가 매칭되고, 동시에 `os.path.basename`도 정규화 후 값으로 계산되어야 `ignore_list` 비교가 일관된다. 이 불변식(매칭 입력 정규화 위치)을 따져야 하므로 dominant는 S2.
- **K (Knowledge) = K-Domain.** pylint 내부의 모듈 확장/무시 파이프라인(`expand_modules`, `_is_ignored_file`, `ignore_list_paths_re`)과 cross-platform 경로 표현(`./`, Windows `\`) 지식이 병목. 순수 일반 파이썬 추론만으로는 정확한 삽입 지점을 못 찾는다.
- **primary_type = T-ConstraintReason.** 위치는 좁게 잡히나(L1) 픽스의 본질은 "정규화 입력을 매칭 직전 어디에 넣어야 basename·path-regex 불변식을 동시에 만족하나"라는 조건 합성. T-DirectMap(순수 기계적)보다 한 단계 추론이 더 있다.

## 난이도 티어

**T3 (중간).** 구조적 피처:
- 파일 1개, 헌크 1개, 추가 1줄 — scope는 T1~T2급으로 매우 작음.
- has-repro 강함: 이슈에 `--recursive` 명령·실제 출력·근본원인 pdb 덤프·픽스 함수명까지 제시 → localize 거의 거저.
- 그러나 골드 픽스가 이슈가 지목한 `pylinter.py`가 **아니라** 하류 `expand_modules.py`라는 약한 미스디렉션이 있고, P2P 120개(recursive/ignore 계열 인접 테스트 다수 포함)가 regression-trap을 형성한다.

공식 라벨 "15 min - 1 hour"와 대체로 일치하나, 1줄짜리·repro 강함을 감안하면 T2에 가깝다. T3로 올린 이유는 (1) 이슈가 지목한 지점과 실제 픽스 지점의 불일치, (2) 정규화를 잘못된 곳(예: 정규식 빌드 측 또는 `root` 측)에 넣으면 다른 recursive/ignore 테스트를 깰 수 있는 regression-trap 때문이다.

## 골드패치 분석

- **파일/함수:** `pylint/lint/expand_modules.py`의 `_is_ignored_file(...)`.
- **근본원인:** 재귀 수집 시 `.` 인자가 경로에 `./` 접두를 남겨 `element`이 `./src/gen/about.py` 형태가 된다. `_is_ignored_file`는 이 `element`로 `basename`을 뽑고 `ignore_list_paths_re`(`^src/gen/.*$`)에 `re.search`하는데, `./` 접두 때문에 정규식 앵커(`^src`)가 매칭 실패 → 무시되어야 할 파일이 검사됨. 윈도우/POSIX 경로 표기 차이도 같은 비정규화 문제의 일부.
- **수정요지:** 함수 본문 첫 줄에 `element = os.path.normpath(element)`를 삽입. 이후 `basename = os.path.basename(element)`과 `ignore_list_re`/`ignore_list_paths_re` 매칭이 모두 정규화된 경로(`src/gen/about.py`) 기준으로 수행되어 `^src/gen/.*$`가 정상 매칭. 단일 지점에서 입력을 정규화하므로 basename 비교와 path-regex 비교가 일관되게 정렬된다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개):** `tests/test_self.py::TestRunTC::test_ignore_path_recursive_current_dir`. `regrtest_data/directory`로 chdir 후 `pylint . --recursive=y --ignore-paths=^ignored_subdirectory/.*`를 실행하고 종료코드 `0`을 기대한다. `.` 인자로 수집된 `./ignored_subdirectory/...` 경로가 정규화되어 `^ignored_subdirectory/.*`에 매칭, 무시되어 lint 0건 → exit 0. 픽스 전에는 `./` 접두로 매칭 실패 → 검사·메시지 발생 → 비-0 종료로 실패.
- **픽스 증명:** 테스트가 정확히 "current dir(`.`) + recursive + ignore-paths" 조합을 친다. 골드의 `normpath`가 `./` 접두 제거의 직접 원인이므로 인과가 정확히 일치.
- **overfit 관점:** F2P가 1개로 얇지만, 픽스가 special-case 분기가 아니라 모든 입력에 적용되는 보편 정규화라 overfit-risk는 낮다(특정 문자열 하드코딩 없음). 그래서 overfit-risk 플래그는 미부여.
- **regression 관점:** P2P 120개 중 `test_recursive`, `test_ignore_recursive`, `test_ignore_pattern_recursive`, `test_ignore_path_recursive`, `test_recursive_current_dir`, `test_regression_recursive_current_dir` 등 인접 동작이 다수 포함 → regression-trap. `normpath`는 이미 정규형인 경로를 멱등적으로 통과시키므로 이들 기존 통과 케이스를 깨지 않는다.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈 본문의 마지막 코멘트가 결정적 신호다 — root가 `./src/gen`일 때 `^src/gen` 정규식이 매칭 실패하고 "`os.path.normpath()`로 고치면 된다"고 명시. 이슈가 지목한 `pylinter.py`의 스킵 로직을 따라가되, 실제 경로별 무시 판정이 위임되는 `pylint/lint/expand_modules.py::_is_ignored_file`까지 데이터플로우를 한 단계 더 추적하는 것이 정답. `ignore-paths`·`normpath` 키워드 grep으로 이 함수에 수렴한다.
2. **픽스와 일반화 근거:** `_is_ignored_file` 진입 직후 `element`을 `os.path.normpath`로 정규화. 이는 매칭에 들어가는 단일 입력을 정렬하는 것이라 basename 비교와 path-regex 비교가 동시에 일관돼지는 올바른 일반화다. `.`/`./`/`..`/중복 슬래시/플랫폼 구분자 전반을 한 곳에서 흡수하므로 special-case가 아님.
3. **regression 안전:** `normpath`는 이미 정규형인 인자(`src/gen/...`처럼 접두 없는 경로)에 멱등 → `test_recursive`/`test_ignore_*_recursive`/`test_*_current_dir` 계열 P2P 120개가 그대로 통과. 매칭 의미를 바꾸지 않고 입력만 표준화하기 때문이다.
4. **함정 회피:** (a) 이슈가 `pylinter.py:600-607`을 지목한다고 거기서 `root`만 정규화하면 `_is_ignored_file` 내부 basename 경로와 어긋나 부분 픽스가 되거나 다른 호출자를 깰 수 있다 — 매칭 직전 단일 지점(`_is_ignored_file`)에 넣는 것이 핵심. (b) 정규식 빌드 측에서 `\\`/`/` 양쪽을 덧붙이는 식으로 우회하면(실제 config가 `^src\\gen\\.*$|^src/gen/.*$`처럼 OR로 확장돼 있다) `./` 접두 케이스를 못 잡아 F2P가 여전히 실패. (c) `os.path.abspath`로 절대경로화하면 `^src/...` 같은 상대 앵커 정규식이 깨져 regression을 유발 — 반드시 `normpath`(상대성 보존)여야 한다.
