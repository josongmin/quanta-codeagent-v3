---
instance_id: pylint-dev__pylint-6528
repo: pylint-dev/pylint
base_commit: 273a8b25620467c1e5686aa8d2a1dbb8c02c78d0
version: "2.14"
difficulty: "15 min - 1 hour"
created_at: "2022-05-06T21:03:37Z"
fail_to_pass: 4
pass_to_pass: 171
gold_files: [pylint/lint/expand_modules.py, pylint/lint/pylinter.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`pylint --recursive=y` 모드에서 `--ignore`, `--ignore-paths`, `--ignore-patterns` 설정이 무시된다. 재귀 디렉터리 워킹(`_discover_files`)이 ignore 필터를 전혀 거치지 않아, 무시되어야 할 디렉터리(기본값 `^\.` 패턴에 걸리는 dot-디렉터리 포함) 안의 파일까지 린트된다. 문서/`--help` 명세와 동작이 모순되어 recursive 모드의 유용성을 심각하게 훼손한다. 이슈는 재현 명령어 4개와 함께 수정 위치 후보(`pylinter.py` 라인 링크)까지 제시한다.

## 유형 (정형화)
- **L = L1 (Traceable).** 이슈 본문이 "recursive 모드", "ignore 미적용"이라는 키워드를 주고 hints가 `pylinter.py`의 `_discover_files` 부근 라인을 직접 지목한다. 다만 ignore 검사 로직 자체는 `expand_modules.py`에 흩어져 있어 한 번의 grep으로 끝나진 않는다(약한 탐색 필요).
- **S = S1 (+S6).** 픽스는 "이미 비재귀 경로에 존재하는 ignore 검사를 재귀 경로에도 적용"하는 기계적 매핑이다. 다만 단순 복붙이 아니라 중복 조건식을 `_is_ignored_file` 헬퍼로 추출(collect-then-reuse)하는 작은 구조 변경(S6)을 동반한다. 새 알고리즘 합성(S2)이 아니라 기존 정책의 누락 적용이라 dominant는 S1.
- **K = K-Domain.** pylint의 모듈 발견 파이프라인(`_discover_files` → `expand_modules` → `_iterate_file_descrs`)과 ignore 3종(`ignore`/`ignore_patterns`/`ignore_paths`)의 의미 구분(basename vs path 매칭)을 알아야 올바른 인자를 전달한다.
- **primary = T-DirectMap.** 위치가 명확하고 픽스가 "누락된 가드 적용"이라는 정형 결함 클래스에 매칭된다. 올바른 식을 추론으로 합성하는 게 아니라 기존 검사 함수를 올바른 지점에 끼워 넣는 매핑이라 DirectMap.

## 난이도 티어
**T3 (중간).** 구조적 피처: 파일 2개(`expand_modules.py`, `pylinter.py`), 추가 ~34줄, has-repro(재현 명령 4개)는 강한 easiness 신호. 그러나 (1) 픽스가 cross-file로 조율되어야 하고(헬퍼를 `expand_modules`에 만들고 `pylinter`로 import), (2) `_discover_files`를 `@staticmethod`에서 인스턴스 메서드로 바꿔 `self.config`에 접근하게 하는 시그니처/디스패치 변경이 있으며, (3) `ignore_paths`는 path 매칭, 나머지는 basename 매칭이라는 도메인 구분을 정확히 다뤄야 한다. PASS_TO_PASS가 156개로 넓어 인접 recursive/discover 동작을 깨면 즉시 regression. 공식 라벨 "15분-1시간"과 일치하나, localize는 쉬워도 cross-file 조율 + staticmethod 해제가 T2를 넘겨 T3.

## 골드패치 분석
- **`pylint/lint/expand_modules.py`**: 기존 `expand_modules` 안에 인라인으로 있던 3중 ignore 조건(`basename in ignore_list` / `_is_in_ignore_list_re(basename, ignore_list_re)` / `_is_in_ignore_list_re(element, ignore_list_paths_re)`)을 새 모듈 레벨 함수 **`_is_ignored_file(element, ignore_list, ignore_list_re, ignore_list_paths_re)`**로 추출. `expand_modules`는 이 헬퍼를 호출하도록 교체.
- **`pylint/lint/pylinter.py`**: `_is_ignored_file`를 import하고, **`_discover_files`를 `@staticmethod` → 인스턴스 메서드(`self`)**로 변경. 재귀 워킹 루프에서 각 `root`에 대해 `_is_ignored_file(root, self.config.ignore, self.config.ignore_patterns, self.config.ignore_paths)`가 참이면 `skip_subtrees.append(root)` 후 `continue`로 **하위 트리 전체를 가지치기**.
- **근본원인**: ignore 정책이 `expand_modules`(명시적 파일/모듈 경로)에만 적용되고, recursive 발견 경로(`_discover_files`)는 별도 코드라 동일 정책을 한 번도 통과하지 않았다. 수정요지 = 그 정책을 재사용 가능한 단일 함수로 만들어 두 경로 모두에서 호출(SSOT화).

## 검증 (test_patch)
FAIL_TO_PASS 4개:
- `unittest_lint.py::test_recursive_ignore[--ignore-ignored_subdirectory]`, `[--ignore-patterns-ignored_*]` — `_discover_files`+`_iterate_file_descrs`로 발견된 파일 목록에 `ignored_subdirectory/failing.py`가 **없어야** 하고, 정상 모듈 4개는 **있어야** 한다.
- `test_self.py::TestRunTC::test_ignore_recursive`, `test_ignore_pattern_recursive` — 무시 디렉터리에 린트 에러 유발 파일(`failing.py`=`import re`)을 두고, `--ignore`/`--ignore-pattern`으로 무시 시 종료코드 0이어야 함(무시 실패 시 에러로 비-0).
- 새 픽스처 `tests/regrtest_data/directory/ignored_subdirectory/failing.py`가 함정 파일 역할.
- **픽스 증명**: 픽스 전엔 `_discover_files`가 ignore를 안 거쳐 `failing.py`가 발견되어 에러 → exit≠0; 픽스 후 `skip_subtrees`에 root가 들어가 하위 트리 가지치기 → 정상.
- **overfit 관점**: FAIL_TO_PASS는 4개로 얇지만, test_patch가 `--ignore`/`--ignore-patterns`/`--ignore-paths` 3종을 모두 parametrize하고 일부는 PASS_TO_PASS로도 배치되어, 한 종류만 통과시키는 special-case 픽스를 배제한다. `_is_ignored_file`가 3종을 한꺼번에 처리하므로 자연히 일반화됨.
- **regression 관점**: PASS_TO_PASS 156개에 `test_recursive`, `test_regression_recursive`, `test_recursive_current_dir`(테스트 patch에서 cwd를 `subdirectory`로 변경) 등 기존 recursive 동작이 다수. `^\.` 기본 패턴이 정상 디렉터리를 잘못 자르면 즉시 깨진다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "recursive 모드에서 ignore 미적용" + hints의 `pylinter.py` 라인 → `_discover_files`가 ignore 검사를 안 함을 확인. 동시에 비재귀 경로(`expand_modules`)에는 정확히 같은 3중 검사가 이미 존재함을 발견 → "정책 재사용" 방향 확정.
2. **픽스**: 인라인 3중 조건을 `_is_ignored_file` 헬퍼로 추출하고 `_discover_files`의 디렉터리 워킹에서 `root`마다 호출, 매칭 시 `skip_subtrees`에 넣어 하위 트리 통째로 가지치기. `self.config.ignore/ignore_patterns/ignore_paths`에 접근해야 하므로 `_discover_files`의 `@staticmethod`를 해제. **올바른 일반화인 이유**: ignore 정책의 SSOT를 만들어 두 발견 경로가 동일 의미(basename 2종 + path 1종)를 공유 → 한 종류만 고치는 overfit을 구조적으로 차단.
3. **regression 안전**: 가지치기는 ignore 매칭된 root에만 적용되고 기본 패턴 `^\.`는 dot-디렉터리에만 걸리므로 `test_recursive`/`test_recursive_current_dir`의 정상 트리는 영향 없음. `skip_subtrees`/`__init__.py` yield 로직은 보존해 패키지 발견 동작 불변.
4. **함정 회피**: (a) `_discover_files`만 고치고 `expand_modules` 검사를 복제해 SSOT를 깨면 두 경로 표류 위험 → 헬퍼 추출이 정답. (b) `@staticmethod`를 안 풀고 `self.config`를 못 써 ignore 인자 전달에 막힘. (c) `ignore_paths`는 full path, `ignore`/`ignore_patterns`는 basename에 매칭하는 인자 순서를 헷갈리면 `--ignore-paths`만 통과/실패하는 부분 픽스가 됨 — `_is_ignored_file`의 인자 시그니처를 정확히 맞춰야 함. (d) 파일 단위로만 거르고 디렉터리(root) 가지치기를 안 하면 하위 파일이 그대로 발견됨.
