---
instance_id: pytest-dev__pytest-8399
repo: pytest-dev/pytest
base_commit: 6e7dc8bac831cd8cf7a53b08efa366bd84f0c0fe
version: "6.3"
difficulty: "15 min - 1 hour"
created_at: 2021-03-04T17:52:17Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [src/_pytest/python.py, src/_pytest/unittest.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L3
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap, cross-file-dep]
---

## 문제 요약
v6.2.0부터 unittest의 `setUpClass`(및 xunit-style `setup_class`/`setup_module`/`setup_function`/`setup_method`)에 대해 pytest가 자동 생성하는 fixture가 더 이상 "private"이 아니게 되었다. 이전에는 fixture 이름이 `_`로 시작해서 `pytest --fixtures`에서 (docstring 없는 채로) 숨겨졌는데, 지금은 `unittest_setUpClass_fixture_Tests`처럼 언더스코어 없이 노출되어 "no docstring available"로 찍힌다. 이 회귀는 #7990/#7931/#7929 리팩터에서 유입되었고, 문서화되지 않은 fixture를 차단하는 사용자 CI를 깨뜨린다.

## 유형 (정형화)
- **L = L3 (Multi-site).** 이슈는 단일 증상이지만 동일 결함이 5개의 fixture 생성 지점에 복제돼 있다 — `python.py`의 module/function/class/method 4곳 + `unittest.py`의 통합 헬퍼 1곳. 한 곳만 고치면 나머지 케이스가 그대로 남으므로 ≥2 파일을 **함께** 조율해 바꿔야 한다.
- **S = S1 (Direct-Map).** 이슈 본문이 픽스를 사실상 명세한다: "add a `_` in each of the generated fixtures names." hints에 unittest.py 부분 diff까지 포함. 추론 합성 없이 기계적 문자열 변경.
- **K = K-Domain.** "private fixture = 이름이 `_`로 시작 → `--fixtures`에서 `-v` 없이는 숨김"이라는 pytest 내부 규약을 알아야 픽스의 정당성을 이해한다(일반 파이썬 지식만으로는 왜 언더스코어가 가시성을 바꾸는지 모름).
- **Primary = T-DirectMap.** 위치만 빠짐없이 찾으면 픽스는 자명한 상수(이름 prefix) 변경이다. localize 난도는 "직접성"이 아니라 "전수성"(5곳 누락 없이)에 있다.
- **Why S1:** 이슈가 결함클래스(명명 규약 위반)와 정확한 수정 형태(prefix 추가)를 둘 다 제공 → 템플릿 매칭으로 끝. APR 관점에서 SemFix류 식 합성도, G&V 후보 탐색도 불필요.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 파일 2개 / 실질 변경 5줄(각 f-string prefix 1글자) / 픽스는 자명 / `has-repro`(이슈에 `pytest --fixtures` 출력 + 최소 재현 클래스). 공식 라벨 "15 min - 1 hour"보다 약간 낮게 잡은 이유는 추론·탐색 비용이 거의 0이고 시간의 대부분이 "5곳 모두 찾기"라는 단순 grep 작업이기 때문(`fixture_{...}` 패턴 grep 한 방). 다만 T1로 내리지 않은 근거: L3 multi-site라 한 곳만 고치면 FAIL_TO_PASS(setUpClass)는 통과해도 xunit 케이스가 남는 **부분픽스 함정**이 있고, P2P 63개가 넓어 fixture 이름 변경이 lookup·autouse 동작을 깨지 않는지 확인 필요(`regression-trap`).

## 골드패치 분석
- **건드린 파일·함수:**
  - `src/_pytest/python.py` — `_inject_setup_module_fixture`, `_inject_setup_function_fixture`, `_inject_setup_class_fixture`, `_inject_setup_method_fixture` (4개 메서드, 각 `@fixture(... name=...)` 인자).
  - `src/_pytest/unittest.py` — `_make_xunit_fixture` 내부의 `name=...` (unittest setUp/tearDown 계열 통합 생성기).
- **근본원인:** #7990/#7931/#7929 리팩터가 생성 fixture 이름을 `xunit_setup_*_fixture_{...}` / `unittest_{setup_name}_fixture_{...}`로 바꾸면서 선행 `_`를 떨궜다. pytest는 `_`로 시작하는 fixture를 "private"으로 간주해 `--fixtures` 출력에서 `-v` 없이는 감춘다 — 이 규약이 깨져 내부 생성 fixture가 공개 fixture처럼 노출됐다.
- **수정요지:** 5개 생성 지점 모두에서 `name` f-string에 선행 `_`를 추가. 예: `name=f"xunit_setup_class_fixture_{self.obj.__qualname__}"` → `name=f"_xunit_setup_class_fixture_{self.obj.__qualname__}"`, `name=f"unittest_{setup_name}_fixture_{obj.__qualname__}"` → `name=f"_unittest_{setup_name}_fixture_{obj.__qualname__}"`. 기능(autouse/scope/실행순서)은 불변, 가시성 규약만 복원.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_unittest.py::test_fixtures_setup_setUpClass_issue8394` — `setUpClass`/`tearDownClass`를 가진 TestCase에 대해 `pytest --fixtures`에서 `*no docstring available*` 라인이 **나오지 않음**(`no_fnmatch_line`)을, 그리고 `-v`에서는 **나옴**(`fnmatch_lines`)을 단언. 즉 이름이 `_`로 시작해 private 게이트가 다시 동작함을 직접 관찰.
- **(test_patch에는 nose쪽 `test_fixtures_nose_setup_issue8394`도 추가됐으나 FAIL_TO_PASS 등재는 unittest 케이스 1개.)**
- **픽스 증명:** prefix `_`가 붙으면 `--fixtures`의 private-필터가 해당 fixture를 숨기므로 docstring 라인이 사라진다 → no_fnmatch 통과. `-v`는 private도 표시하므로 라인 등장 → fnmatch 통과. 인과가 패치와 정확히 일치.
- **overfit 관점:** FAIL_TO_PASS는 unittest setUpClass 한 경로만 검사하므로, 그 한 곳만 prefix를 붙이는 **special-case 통과**가 가능(`overfit-risk` 잠재). 골드는 5곳 전부 고쳐 일반화했고, nose 테스트가 xunit 경로(setup_module/function/method)도 커버. 단 FAIL_TO_PASS 자체는 xunit 누락을 못 잡으므로 얇음.
- **regression 관점:** P2P 63개(test_unittest 전반: setUpClass cleanup, teardown, skip, async 등)가 fixture **이름 변경**에 영향받지 않아야 함. 이름은 "speed up lookup" 용도의 내부 식별자라 외부 참조가 없어야 하고, autouse라 명시 의존이 없으므로 안전. 실제로 모든 P2P가 PASS 유지.

## 모범답안 (오라클 기반)
1. **Localize 경로:** 이슈의 출력 `unittest_setUpClass_fixture_Tests ... _pytest/unittest.py:145`가 파일·라인을 직접 지목 → `src/_pytest/unittest.py`의 `name=f"unittest_..._fixture_..."`. hints가 xunit도 영향(`xunit_setup_class_fixture_Tests ... python.py:803`)이라 명시 → `src/_pytest/python.py`. 결정적으로 `grep -rn "fixture_{.*__\(qual\)\?name__}"` 또는 `name=f"...fixture_"`로 **5곳 전수**를 뽑는다.
2. **픽스와 일반화 근거:** 각 생성 이름에 선행 `_` 추가. 이것이 올바른 일반화인 이유 — 회귀 전 동작이 "생성 fixture는 private(`_` 시작)"였고, pytest의 `--fixtures` private 필터가 prefix 규약에 의존하기 때문. prefix는 가시성만 바꾸고 fixture의 scope/autouse/실행을 건드리지 않아 부작용이 없다. setUpClass 한 곳만 고치는 건 동일 결함클래스의 부분픽스라 오답.
3. **Regression 안전:** P2P 63개가 fixture **동작**(setup/teardown 순서, cleanup, skip, async, do_class_cleanups)을 검증한다. 이름은 internal lookup key일 뿐 어떤 테스트도 그 리터럴 이름을 참조하지 않으므로 prefix 변경이 이들을 깨지 않음을 확인해야 한다(특히 fixture가 다른 fixture를 이름으로 의존하지 않는지). autouse fixture라 사용자 코드의 명시 참조도 없음.
4. **함정 회피:** (a) FAIL_TO_PASS가 unittest 한 케이스만이라 거기만 고치고 끝내면 슬라이스-그린에 속아 xunit 4경로를 놓침 → `python.py`까지 전수 수정해야 함. (b) "private = `_` 시작" 규약을 모르면 docstring을 추가하는 식의 엉뚱한 픽스로 샐 수 있음 → 회귀 원인(#7990 등에서 `_` 누락)을 git blame/PR 추적으로 확인하면 정답 방향이 고정된다. (c) 이름 prefix가 fixture 중복·충돌을 일으키지 않는지(autouse라 lookup만 빨라지는 유니크 네임) 확인.
