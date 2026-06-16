---
instance_id: pytest-dev__pytest-10356
repo: pytest-dev/pytest
base_commit: 3c1534944cbd34e8a41bc9e76818018fadefc9a1
version: "7.2"
difficulty: "1-4 hours"
created_at: 2022-10-08T06:20:42Z
fail_to_pass: 1
pass_to_pass: 79
gold_files: [src/_pytest/mark/structures.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
두 베이스클래스 `Foo`, `Bar`에 각각 pytest 마커를 붙이고 둘 다 상속하면, 한쪽 마커가 사라진다. 원인은 마커가 클래스마다 `pytestmark` 단일 리스트 속성에 저장되는데, Python의 일반 속성 lookup이 MRO에서 **첫 번째로 발견된 `pytestmark` 하나만** 반환하기 때문이다(다중상속 시 형제 베이스의 마커는 가려짐). 이슈는 "마커 획득 시 MRO를 순회해 모든 베이스의 마커를 합쳐야 한다"고 요구한다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈 본문과 hints가 `pytestmark`/`get_unpacked_marks`/MRO를 직접 지목한다. grep 한 방으로 `src/_pytest/mark/structures.py::get_unpacked_marks`에 도달. 직접성 최상.
- **S2 (Constraint-Reasoning)**: 고칠 함수는 자명하나, 올바른 식 합성이 핵심이다. `getattr(obj, "pytestmark")`(MRO-가려짐)을 `obj.__mro__`를 명시적으로 순회해 `__dict__.get("pytestmark")`로 클래스별 직접 속성을 모아야 한다. 단순 가드 추가(S1)가 아니라 "MRO 순회 + 클래스별 dict 직접 조회"라는 불변식을 추론으로 세워야 함. 게다가 `store_mark`의 재귀-중복 함정을 피하려고 `consider_mro=False` 분기를 도입하는 설계 판단이 필요.
- **K-Domain**: Python descriptor/MRO/`__dict__` vs `getattr` 차이라는 언어 메커니즘 + pytest의 mark 저장 규약(`store_mark`가 `[*get_unpacked_marks(obj), mark]`로 재기록) 양쪽 지식 필요.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스의 본질이 올바른 수집식 합성(S2)이다. APR 관점에서 템플릿 매칭이 아니라 의미적 제약(MRO 순서·중복 방지)을 만족하는 식 합성이므로 SemFix/Angelix류 constraint-reasoning에 해당.

## 난이도 티어
- **T3 (중간)**. 구조적 피처: 단일 파일(`structures.py`), 골드 패치 ~25줄 1헌크(+`store_mark` 1줄), repro 코드 존재(이슈에 metaclass 우회 + diamond 예시), P2P 80개로 **regression-trap 중간**(`test_mark_decorator_baseclasses_merged`, `test_mark_should_not_pass_to_siebling_class` 등 마크 전파 동작을 깨면 안 됨).
- L0라 localize는 쉽지만, S2 추론(왜 `getattr`로는 안 되고 `__mro__`+`__dict__`여야 하는지)과 `store_mark`의 재귀-중복 함정 회피가 무게를 준다. has-repro라 T2로 내릴 만하지만, "단순 가드/상수 변경"이 아니라 동작 의미를 바꾸는 잠재적 breaking change(hints에서 "7.0/8.0으로만"이라고 명시)이고 P2P가 넓어 T3가 맞다.
- 공식 라벨 "1-4 hours"와 일치(T3-T4 경계). 더 올리지 않는 이유: 멀티파일·멀티사이트 조율 없음, 도메인 깊이도 Python 언어 메커니즘 수준이라 T4의 "넓은 P2P+S2" 하한에 걸친다.

## 골드패치 분석
- **파일/함수**: `src/_pytest/mark/structures.py`의 `get_unpacked_marks`, 그리고 호출부 `store_mark`.
- **근본원인**: `get_unpacked_marks`가 `getattr(obj, "pytestmark", [])`로 마커를 읽었다. 클래스에 대해 `getattr`은 MRO 첫 매치만 반환하므로, 다중상속 형제 베이스(`B`)의 `pytestmark`가 가려져 마커가 유실됐다.
- **수정요지**:
  - `obj`가 `type`(클래스)이면 `consider_mro=True` 기본에서 `[x.__dict__.get("pytestmark", []) for x in obj.__mro__]`로 **MRO 전체를 순회**하고 각 클래스의 **직접 속성**(`__dict__.get`, 상속분 미포함)만 모아 평탄화한다. 이로써 모든 베이스의 마커가 MRO 순서대로 합쳐진다.
  - 클래스가 아니면 기존 `getattr` 경로 유지(하위호환).
  - 시그니처에 `*, consider_mro: bool = True` 추가, 반환형을 `Iterable[Mark]` → `List[Mark]`로 구체화.
  - `store_mark`는 `get_unpacked_marks(obj, consider_mro=False)`로 호출하도록 변경 — 마크 저장 시 부모 마커까지 다시 끌어와 자기 `pytestmark`에 중복 기록(누적 폭증)되는 것을 막는다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `testing/test_mark.py::test_mark_mro` 1개. `@xfail("a") class A`, `@xfail("b") class B`, `@xfail("c") class C(A, B)`를 만들고 `get_unpacked_marks(C) == [xfail("c").mark, xfail("a").mark, xfail("b").mark]`를 단언 — MRO 순서(C, A, B)대로 셋 다 수집되는지 검증. 또 `get_unpacked_marks(C, consider_mro=False) == [xfail("c").mark]`로 직접 속성만 반환하는 새 파라미터도 검증.
- **픽스 증명**: 기존 코드는 `getattr(C, "pytestmark")`가 C와 A의 마크 일부만 주고 B를 누락 → 단언 실패. 패치 후 `__mro__` 순회로 정확히 세 마크가 순서대로 수집됨.
- **overfit/regression**: FAIL_TO_PASS가 1개라 얇지만, diamond/형제 양쪽을 포괄하는 3-클래스 케이스 + `consider_mro=False` 경로를 함께 단언해 special-case 통과를 어느 정도 차단(overfit-risk 낮음). P2P 80개 중 `test_mark_decorator_baseclasses_merged`, `test_merging_markers_deep`, `test_mark_should_not_pass_to_siebling_class` 등이 마크 전파 의미를 지키는지 회귀 검증한다 — `store_mark`의 `consider_mro=False` 누락 시 이들이 중복 누적으로 깨지므로 regression-trap이 실제로 작동.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `pytestmark` + MRO를 직접 명시 → `rg "pytestmark" src/_pytest/mark/` → `get_unpacked_marks`가 마커 수집 단일 진입점임을 확인. hints의 "walk the mro of a class to get all marks"가 정답 방향을 못박음.
2. **픽스와 일반화**: 핵심 통찰은 "`getattr`은 MRO에서 첫 `pytestmark`만 본다"는 것. 올바른 일반화는 `obj.__mro__`를 순회하며 **각 클래스의 `__dict__.get("pytestmark")`(직접 정의분만)**를 모으는 것 — 이래야 형제 베이스가 안 가려지고, 동시에 클래스마다 자기 마크만 갖게 해 중복을 원천 차단. non-class 입력은 기존 `getattr` 분기 유지로 하위호환. 단일 테스트가 아니라 MRO 의미 전반을 만족하므로 올바른 일반화.
3. **regression 안전**: `store_mark`가 `[*get_unpacked_marks(obj), mark]`로 self.pytestmark를 재기록하는데, 여기서 `consider_mro=True`로 부모 마크까지 끌어오면 매 마크 추가마다 부모 마크가 자기 `__dict__`에 복제·누적된다. `consider_mro=False`를 줘 "직접 속성만" 읽게 해야 `test_mark_decorator_baseclasses_merged`/`test_merging_markers_deep` 등 P2P가 안 깨진다.
4. **함정 회피**: (a) `getattr` 대신 `__dict__.get`을 써야 함 — `getattr`로 MRO 순회하면 각 항목이 상속분까지 끌어와 중복 폭증. (b) `store_mark`의 `consider_mro=False`를 빠뜨리면 FAIL_TO_PASS는 통과해도 P2P가 무너지는 전형적 부분-그린 함정. (c) hints의 "`pytestmark_foo` 별도 속성 저장" 대안에 휩쓸리지 말 것 — diamond 동명 마크 문제를 못 풀고 메인테이너가 기각함.
