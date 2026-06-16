---
instance_id: pytest-dev__pytest-6197
repo: pytest-dev/pytest
base_commit: e856638ba086fcf5bebf1bebea32d5cf78de87b4
version: "5.2"
difficulty: 1-4 hours
fail_to_pass: 2
pass_to_pass: 145
gold_files: [src/_pytest/python.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

## 문제 요약
pytest 5.2.3에서 회귀가 발생해, 현재 디렉터리 하위의 임의 `__init__.py`(패키지)를 collection 단계에서 무조건 import 하기 시작했다. 그 결과 import 불가능한(예: windows 전용) 패키지가 있으면 `foobar/__init__.py:1: AssertionError`처럼 collection 에러로 전체 실행이 중단된다. 이슈 본문이 직접 PR #5831을 culprit으로 지목하며, 'src layout' 패키지가 sys.path에 잘못 올라가는 부작용도 동반한다. 즉 패키지를 **eager하게 mount(=import)** 하던 변경을 lazy로 되돌려야 한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 PR #5831을 culprit으로 명시하고 스택트레이스가 `collecting __init__.py` → collection 경로를 가리킨다. `src/_pytest/python.py`의 collection 코드로 좁히는 데 약간의 탐색이 필요하나 단일 파일로 수렴. L0까지는 아님(정확한 메서드 `_mount_obj_if_needed` 호출지점은 코드를 읽어야 보임).
- **S2 (+S6)**: 픽스는 단순 가드 추가가 아니라 "언제 `_obj`를 mount(import)할지"라는 **불변식을 재설계**하는 추론이다. `obj` property를 lazy 평가로 되돌리고(S2), `Package.collect`에서의 eager 호출과 `Module.__init__`의 `_ALLOW_MARKERS` 우회를 제거하는 **구조적 되돌림**(S6)이 함께 필요. 실제로 골드패치는 PR #5831의 완전한 revert이며, eager mount와 그 동반 마커 스캐폴딩이 한 묶음으로 함께 제거되어 pre-#5831 상태로 복귀한다.
- **K-Domain**: pytest collection 생명주기(Package/Module/PyobjMixin, `_getobj`, `own_markers`, `_ALLOW_MARKERS`)에 대한 프레임워크 내부 지식이 병목. 일반 파이썬 추론만으로는 "왜 collect에서 obj를 만지면 import가 일어나는가"를 알 수 없음.
- **primary = T-DomainBound**: 위치는 좁혀지지만 진짜 난점은 collection lazy-mount 의미론이라는 도메인 계약 이해에 있다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개(`src/_pytest/python.py`), 순삭감 위주의 ~3 헌크 — 범위는 작다.
- localize 직접성은 중간: 이슈가 PR을 지목해 has-repro지만, 실제 수정점(`_mount_obj_if_needed`/`Package.collect`/`Module.__init__`)은 코드 독해를 요구.
- **P2P 145개**라는 광범위한 regression-trap: collection·skipping 동작 대부분을 안 깨야 한다. 특히 marker 전파(`own_markers`)와 패키지 `__init__.py` 수집 동작이 미세하게 얽혀 있어, 무지성 revert 시 marker 중복 또는 패키지 마커 회귀가 터질 수 있음.
- underspecified 측면: 이슈는 "되돌려라"만 말하고 올바른 lazy 시점은 명세하지 않음.
공식 라벨 `1-4 hours`와 일치. 줄수는 적지만 도메인 계약 + 넓은 P2P가 T4로 민다(T2/T3로 내리기엔 lazy-mount 추론과 regression 표면이 부담).

## 골드패치 분석
건드린 파일: `src/_pytest/python.py` (단일).
- **`PyobjMixin.obj` / `_mount_obj_if_needed`**: 별도 메서드 `_mount_obj_if_needed()`를 제거하고, lazy-import 로직을 `obj` getter 안으로 다시 인라인. getter는 `_obj`가 None일 때만 `self._getobj()`를 호출해 import한다. marker 추출도 `get_unpacked_marks(obj)` → `get_unpacked_marks(self.obj)`로 돌아가는데, 이는 새로 '일원화'한 설계가 아니라 #5831 이전(`5f9db8a01`)부터 getter 본문이 갖고 있던 원형 인라인 로직을 그대로 복원하는 것이다.
- **`Module.__init__` 제거**: `fspath.basename == "__init__.py"`일 때 `self._ALLOW_MARKERS = False`로 세팅하던 생성자를 통째로 삭제. 이 생성자는 eager mount의 부산물이 아니라 #5831이 `InitModule` 클래스를 대체하며 새로 도입한 코드(커밋 `5cefcb205` "refactor disabling markers")이고, PR 전체를 revert하면서 함께 깨끗이 제거되는 것이다.
- **`Package.collect`**: 첫 줄의 `self._mount_obj_if_needed()` 호출 삭제 — **이것이 근본 원인**. collect 진입 즉시 패키지 obj를 mount(=`__init__.py` import)하던 것이 회귀의 직접 트리거였다.
- 근본원인: PR #5831이 marker 중복 회피를 위해 collect 시점에 obj를 eager-mount하게 만들면서, 수집 대상이 아닌 패키지의 `__init__.py`까지 import되어 부작용(AssertionError, sys.path 오염)이 발생. 수정요지 = import를 실제로 obj가 필요한 순간까지 지연시키는 lazy 의미론 복원.

## 검증 (test_patch)
FAIL_TO_PASS 2개:
- `test_does_not_eagerly_collect_packages`: `foopkg/__init__.py`에 `assert False`를 넣고도 `result.ret == ExitCode.OK`. 즉 패키지를 import하지 않아야 통과 → eager mount 제거를 직접 증명.
- `test_does_not_put_src_on_path`: `src/nope/__init__.py`를 만든 뒤 `import nope`가 `ImportError`여야 함 → src layout이 sys.path에 안 올라가는 부작용 부재를 증명.
또한 test_patch는 `testing/test_skipping.py::test_skip_package`를 **삭제**한다: 이는 패키지 `__init__.py`의 `pytestmark`가 하위 테스트로 전파됨을 기대하던 테스트로, eager mount에 의존하던 동작이라 명세상 함께 제거됨(스펙 변경).
- overfit 관점: F2P가 2개로 얇아 보이지만 두 테스트가 서로 다른 부작용(import 실행 / sys.path)을 각각 가리켜 special-case 통과가 어렵다. 다만 `test_skip_package` 삭제는 동작 명세를 좁히는 결정이므로, 오라클 없이는 "왜 그 테스트를 지워도 되는가"를 underspecified로 둘 위험.
- regression 관점: P2P 145개(특히 `test_collect_init_tests`, `test_collect_pkg_init_only`, `test_collect_pkg_init_and_file_in_args`)가 패키지 `__init__.py`의 *정당한* 수집 경로를 보호한다 — lazy로 바꿔도 "초기 인자로 지정된 `__init__.py`"는 여전히 수집되어야 함.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 본문의 "#5831이 culprit" + 스택트레이스 `collecting foobar/__init__.py`를 신호로 잡는다. `git log`/blame으로 `src/_pytest/python.py`의 collection 변경을 추적 → `Package.collect` 첫 줄 `self._mount_obj_if_needed()`와 그 메서드, 그리고 `Module.__init__`의 `_ALLOW_MARKERS=False` 우회가 한 묶음임을 식별.
2. **픽스와 일반화**: import를 obj가 실제로 필요한 시점까지 지연(lazy)시킨다. `_mount_obj_if_needed`를 `obj` getter로 인라인하고, `Package.collect`의 eager 호출을 제거. 이는 단일 입력 하드코딩이 아니라 "collection 단계에서 패키지 본체를 import하지 않는다"는 일반 불변식 복원이므로 overfit이 아니다. `Module.__init__`의 `_ALLOW_MARKERS=False` 코드는 eager mount의 부산물이 아니라 #5831이 함께 도입한 스캐폴딩이므로, PR 전체를 revert하면 eager 호출과 이 동반 마커 코드가 한꺼번에 제거된다 — 부분 수정만 하면 잔존 eager 경로가 남는다.
3. **regression 안전**: P2P의 `test_collect_init_tests`/`test_collect_pkg_init_only` 등 "사용자가 명시적으로 지정한 `__init__.py`는 수집"하는 경로를 깨면 안 된다. lazy화는 `isinitpath`/초기 인자 수집 경로를 건드리지 않으므로 안전. marker 전파(`own_markers`, `get_unpacked_marks`)는 #5831 이전 getter 본문의 원형 인라인 로직으로 복원되며, 별도의 신규 중복-방지 설계가 아니다.
4. **함정 회피**: (a) 골드패치는 사실 PR #5831의 완전한 git revert 그 자체이며(업스트림 실제 수정 커밋 `176c7771f` 제목이 `Revert "fix bug with nonskipped first test in package (#5831)"`이고 그 `python.py` diff가 골드패치와 바이트 동일), '풀 revert 시 marker 중복 부활'이라는 함정은 존재하지 않는다 — 마커-중복 회피용 `Module.__init__`/`_ALLOW_MARKERS=False` 코드 자체가 #5831 내부 스캐폴딩이라 PR 전체를 되돌리면 그 코드도 함께 사라지고 pre-#5831(parent `5f9db8a01`)의 정상 상태로 복귀하며, 그 상태엔 `__init__.py` 모듈발 마커 중복 문제가 애초에 없었다. (b) `Package.collect`의 호출만 지우고 `_mount_obj_if_needed`/`_ALLOW_MARKERS` 잔재를 남기면 다른 eager 경로로 회귀 재발. (c) `test_skip_package`를 안 지우면 "패키지 pytestmark 전파" 기대가 신규 lazy 동작과 충돌해 실패 — 이 동작이 의도적으로 폐기됨을 이해해야 한다.
