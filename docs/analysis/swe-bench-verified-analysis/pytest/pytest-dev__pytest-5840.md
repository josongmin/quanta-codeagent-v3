---
instance_id: pytest-dev__pytest-5840
repo: pytest-dev/pytest
base_commit: 73c5b7f4b11a81e971f7d1bb18072e06a87060f4
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: 2019-09-12T01:09:28Z
fail_to_pass: 2
pass_to_pass: 51
gold_files: [src/_pytest/config/__init__.py, src/_pytest/pathlib.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
pytest 5.1.1→5.1.2 업그레이드 후 Windows에서 `ImportError while loading conftest`가 발생한다. conftest 경로가 강제로 소문자화되어 `imageProcessing` 같은 대문자 포함 패키지가 `imageprocessing`으로 깨지고 `ModuleNotFoundError`로 이어진다. 원인은 PR #5792가 도입한 `unique_path()`가 `os.path.normcase`로 경로를 정규화하면서 case-insensitive 파일시스템에서 케이스를 보존하지 못한 것이다. 올바른 케이스를 가진 경로를 얻으려면 `normcase` 대신 `pathlib.Path.resolve()`를 써야 한다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 수정이 `src/_pytest/config/__init__.py`와 `src/_pytest/pathlib.py` 두 파일에 걸쳐 **조율되어** 일어난다. `pathlib.py`에서 `unique_path` 헬퍼를 제거하면서, 그 호출처 3곳(`_set_initial_conftests` line 370, `_getconftestmodules` line 409, `_importconftest` line 438)을 각각 다른 방식으로 갈아끼워야 한다(`_importconftest`는 `unique_path`를 1회만 호출하고, 뒤따르는 `_conftestpath2mod` get/set은 재할당된 동일 변수를 재사용하는 dict 접근일 뿐 `unique_path` 호출이 아니다). 단순 1-site가 아니다.
- **S = S2 (Constraint-Reasoning) (+S5)**: 고칠 지점은 스택트레이스로 명확하지만, "케이스를 보존하면서도 같은 conftest 중복 로딩은 막는" 불변식을 충족하는 식을 추론해야 한다. `normcase(realpath(...))` → `Path(str(...)).resolve()` 라는 대체식은 hints의 스펙 단서(`Path.resolve`?)에서 재구성된다(+S5).
- **K = K-Domain**: py.path.local vs pathlib.Path의 케이스 처리 차이, conftest 중복 로딩 방지 메커니즘(`_conftestpath2mod` dict key), case-insensitive FS 동작 등 pytest/플랫폼 내부 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 명확(스택트레이스가 `_importconftest`를 직접 지목)하나 난점은 "어디"가 아니라 케이스-보존 ⊥ 중복-방지 불변식을 동시에 만족하는 올바른 식을 합성하는 데 있다. 그래서 S2 dominant.

이 strategy인 이유(APR 관점): 후보 패치를 다수 생성해 테스트로 거르는 G&V가 아니라, "normcase가 케이스를 죽인다"는 인과를 짚고 `resolve()`라는 의미적으로 동치이되 케이스-보존하는 연산으로 치환하는 단일 추론이 핵심이다. SemFix/Angelix식 semantic repair.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- **파일수 2 / 헌크 5**: ICLR-2024 컷에서 ≥3파일이 아니라 2파일이지만, multi-site 조율(L3)이라 단순 T2/T3보다 위.
- **localize 직접성 높음**: 네이티브 스택트레이스(`_conftestpath2mod[conftestpath]` KeyError → `_importconftest`)와 hints가 원흉 PR #5792를 지목 → `has-repro`. 이건 난이도를 낮추는 강한 신호.
- **regression trap 넓음**: PASS_TO_PASS 51개. conftest 로딩/심볼릭링크/confcutdir/badcase 경로가 전부 인접. `test_conftest_symlink`, `test_conftest_badcase`를 깨면 안 됨 → `regression-trap`.
- **추론 부담**: 케이스-보존하면서 심볼릭링크 중복도 막아야 하는 이중 불변식 → S2 추론이 실질적.

공식 라벨 "15 min - 1 hour"와 일치(개발자에겐 인과가 hints로 거의 다 주어져 빠름). 다만 에이전트 관점에선 L3 멀티사이트 조율 + 넓은 P2P trap이 시간라벨에 안 잡히는 위험이라 T3가 아닌 T4로 둔다.

## 골드패치 분석
**건드린 파일·함수**
- `src/_pytest/pathlib.py`: `unique_path(path)` 헬퍼 **제거** + `from os.path import normcase` import 제거.
- `src/_pytest/config/__init__.py`:
  - `_set_initial_conftests`: `unique_path(current.join(...))` → `current.join(..., abs=True)` (래핑 제거).
  - `_getconftestmodules`: `directory = unique_path(directory)` 줄 제거 + 루프를 `directory.parts()` → `directory.realpath().parts()`로 변경.
  - `_importconftest`: 중복방지 dict 키를 `unique_path(conftestpath)`(py.path) → `key = Path(str(conftestpath)).resolve()`(pathlib)로 교체. `_conftestpath2mod` get/set 둘 다 `key` 사용.

**근본원인**: `unique_path`가 `type(path)(normcase(str(path.realpath())))`로 정의되어 Windows(case-insensitive)에서 경로를 소문자로 정규화 → 이 값이 `conftestpath.pyimport()`의 모듈명 유도에 흘러들어가 대문자 패키지명을 깨뜨림.

**수정요지**: 케이스를 죽이는 `normcase`를 버리고, 중복 로딩 방지(원래 목적)는 `pathlib.Path.resolve()`로 달성. `resolve()`는 case-insensitive FS에서 올바른 케이스/드라이브로 해석하므로 #5792가 풀려던 심볼릭링크 중복 문제와 #5819 케이스 깨짐을 동시에 해결한다.

## 검증 (test_patch)
**FAIL_TO_PASS (2개)**: `test_setinitial_conftest_subdirs[test]`, `[tests]`. 테스트가 `unique_path(subconftest) in conftest._conftestpath2mod` 단언을 `key = Path(str(subconftest)).resolve()` 기준으로 바꾼다. 즉 dict 키 표현이 `unique_path`에서 `Path().resolve()`로 바뀐 것을 직접 검증 → 픽스의 핵심 변경(키 교체)을 못 박는다.

**픽스 증명**: 신규 `test_conftest_uppercase`(#5819 재현, `Foo/conftest.py` 대문자 패키지)는 PASS_TO_PASS에 들어가 있고 `ExitCode.NO_TESTS_COLLECTED`(ImportError 없이 수집 성공)를 요구 → 원래 버그가 사라졌음을 양성 증명. `test_conftest_badcase`(#5792 케이스, case-insensitive 전용 skip)도 P2P로 남아 회귀 방지.

**overfit/regression 관점**: F2P가 2개로 얇지만, dict-key 표현 단언이라 special-case 우회가 어렵고, `test_conftest_uppercase` + `test_conftest_symlink(_files)` + `test_conftestcutdir*`가 P2P로 같이 묶여 케이스-보존과 심볼릭링크 중복방지를 동시에 강제 → overfit 위험 낮음. 다만 케이스-insensitive 동작은 실제 Windows에서만 의미 있어 Linux CI에선 일부가 vacuous할 수 있는 게 잠재 약점.

## 모범답안 (오라클 기반)
1. **localize**: 이슈/hints가 원흉 PR #5792를 직접 지목, 스택트레이스가 `_importconftest`의 `self._conftestpath2mod[conftestpath]` KeyError와 `pyimport()` 실패를 보여줌. → `git log/blame`로 #5792가 추가한 `unique_path`를 `pathlib.py`에서 찾고, 그 호출처를 `_pytest/config/__init__.py`에서 grep(3곳: line 370/409/438). L3 multi-site임을 여기서 인지.
2. **픽스(올바른 일반화)**: 버그 원인은 `normcase`의 소문자화. 단순히 `_importconftest`만 고치면 안 되고, `unique_path`의 두 책임(케이스정규화=버그, realpath 중복방지=필요)을 분리해야 한다. 중복방지는 `Path(str(conftestpath)).resolve()`로 이전(케이스 보존 + 심볼릭링크 해소), 케이스정규화는 폐기. `_getconftestmodules`는 dict 키와 별개로 부모순회용 정규화가 필요하므로 `directory.realpath().parts()`로 realpath만 적용. 이건 hints가 명시한 `Path.resolve` 스펙과 #5792의 원래 의도를 동시에 만족하는 일반화라 overfit이 아님.
3. **regression 안전**: `test_conftest_symlink(_files)`(심볼릭링크 중복 로딩 1회만)와 `test_conftestcutdir*`(confcutdir 경계)를 깨면 안 됨 — `resolve()`가 realpath 기능을 보존하기에 통과. `test_conftest_badcase`(#5792)도 살아있어야 하므로 케이스-insensitive 매칭을 죽이면 안 됨.
4. **함정 회피**: (a) `_importconftest`만 고치고 `unique_path`를 남겨두면 `_getconftestmodules`/`_set_initial_conftests`의 소문자화가 잔존해 부분픽스가 됨 → 호출처 전수 교체 필수. (b) `normcase`를 단순 제거만 하면 #5792의 심볼릭링크 중복 로딩 회귀(`test_conftest_symlink` 깨짐) → 반드시 `resolve()`/`realpath()`로 대체. (c) dict 키 타입을 py.path.local로 유지하면 `Path().resolve()`와 비교 불일치 → 키를 `Path`로 통일.
