---
instance_id: sympy__sympy-20590
repo: sympy/sympy
base_commit: cffd4e0f86fefd4802349a9f9b19ed70934ea354
version: "1.7"
difficulty: "15 min - 1 hour"
created_at: 2020-12-12T18:18:38Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [sympy/core/_print_helpers.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
sympy 1.6.2에서는 `Symbol('s').__dict__`가 `AttributeError`였는데(=`__slots__`로 인스턴스 dict가 봉인됨), 1.7부터는 빈 `__dict__`가 생겨버렸다. 즉 `Symbol` 인스턴스가 더 이상 immutable이 아니게 되었고 `s.x = 1` 같은 임의 속성 할당이 가능해졌다. 이슈 제보자는 어떤 부모 클래스가 실수로 `__slots__` 정의를 빠뜨려 생긴 회귀로 추정했다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문이 직접 파일을 지목하진 않지만, hints가 PR #19425/커밋 5644df199를 bisect로 짚어주고 "Basic이 이제 `DefaultPrinting`을 상속하는데 거기 slots가 없다"까지 진단해준다. `__slots__`/`DefaultPrinting` grep으로 좁은 단일 파일(`_print_helpers.py`)에 수렴. 한 번의 탐색.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 좁혀지지만 "빈 `__slots__ = ()`를 넣어야지 `('name',)` 같은 비어있지 않은 slots를 넣으면 안 된다"는 점, 그리고 그게 모든 서브클래스에 `__dict__`를 강제로 없애지 않는다(서브클래스가 자기 slots를 선언 안 하면 여전히 dict 생김)는 Python 데이터모델 불변식을 추론해야 한다. 후보를 마구 던지는 G&V가 아니라 "왜 빈 튜플인가"를 따져 푸는 문제.
- **K-Domain (Domain-bound)**: 일반 파이썬 추론만으로는 부족하고 mixin + `__slots__` 다중상속 상호작용(비어있지 않은 slots는 MI를 깨고, 빈 slots만 mixin에 안전)이라는 CPython 데이터모델 지식이 병목. hints의 "EvalfMixin has `__slots__ = ()`" 관례가 결정적 단서.
- **primary type = T-DomainBound**: 위치도 비교적 명확하고 픽스도 1줄이지만, 진짜 병목은 "mixin에는 빈 slots를 줘야 slots 체인이 보존된다"는 도메인/언어모델 지식이다. S2로 분류 가능하나 dominant axis는 K-Domain.

## 난이도 티어
**T3 (중간).** 구조적 피처: 1파일·실질 1줄(`__slots__ = ()` 추가), `has-repro`(이슈에 네이티브 `AttributeError` 트레이스 + bisect 커밋). 이 신호들만 보면 T2에 가깝다. 그러나 (1) 픽스 1줄을 도출하려면 빈 slots vs 비어있지 않은 slots의 미묘한 차이를 알아야 하는 K-Domain 추론이 끼고, (2) `Printable`은 mixin이라 `regression-trap`이 실재한다 — 만약 `__slots__ = ('something',)`처럼 잘못 넣으면 이 클래스를 상속하는 광범위한 `Basic` 트리 전체의 다중상속이 깨질 수 있다. 공식 라벨 "15분-1시간"과 일치(localize는 hints가 거의 해주지만 올바른 형태를 골라야 함). overfit 위험은 낮음(픽스가 유일해)이라 T4까지 가진 않는다.

## 골드패치 분석
- **파일·심볼**: `sympy/core/_print_helpers.py`의 `class Printable`(= `printing.defaults`에 `DefaultPrinting`으로 노출되는 mixin). `Basic`이 1.7에서 이 클래스를 상속하게 됨.
- **근본원인**: PR #19425에서 `Basic`이 `Printable`/`DefaultPrinting` mixin을 상속하게 바뀌었는데, `Printable`이 `__slots__`를 선언하지 않았다. Python에서 상속 체인 중 한 클래스라도 `__slots__`를 정의하지 않으면 그 클래스가 `__dict__`를 도입하고, 그러면 자식(`Symbol` 등)이 `__slots__ = ('name',)`로 slots를 선언해도 부모가 들고 온 `__dict__`가 인스턴스에 남는다. 결과적으로 `Symbol` 인스턴스의 immutability(slots 봉인)가 깨짐.
- **수정요지**: `Printable`에 `__slots__ = ()`(빈 튜플) 한 줄 추가. mixin이 인스턴스 저장공간을 0개 추가하므로 `__dict__`를 도입하지 않고, slots 체인이 보존되어 `Symbol` 인스턴스가 다시 dict-less·immutable이 된다. 주석으로 "mixin이므로 빈 slots를 두면 slots를 쓰는 서브클래스가 `__dict__`를 안 갖게 된다"는 의도까지 명시.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_immutable`** (`sympy/core/tests/test_basic.py`): `assert not hasattr(b1, '__dict__')`로 인스턴스에 dict가 없음을 확인하고, `with raises(AttributeError): b1.x = 1`로 임의 속성 할당이 거부됨을 확인한다. 여기서 `b1`은 모듈 상단에서 만든 `Basic` 인스턴스. 픽스 전엔 `Printable`이 끌어온 `__dict__` 때문에 둘 다 실패(`hasattr`가 True, 할당 성공), 픽스 후엔 slots 봉인으로 둘 다 통과.
- **픽스 증명**: 테스트가 `__dict__` 부재 + 속성할당 거부 두 가지를 모두 단언하므로 "dict가 없다"와 "immutable이다"를 분리해 증명 — 빈 slots 추가가 정확히 이 두 효과를 낸다.
- **overfit/regression**: overfit 위험 낮음 — 빈 `__slots__`는 사실상 유일한 올바른 픽스이고, special-case 트릭으로 통과시킬 여지가 없다. 단 `regression-trap`은 21개 PASS_TO_PASS(`test_structure`/`test_equality`/`test_subs`/`test_atoms` 등 `Basic` 핵심 동작 전반)가 지켜준다. 잘못된 형태(비어있지 않은 slots)를 넣었다면 이 P2P들이 MI 충돌로 무너졌을 것.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `__slots__`/`__dict__` 키워드 + hints의 "Basic이 `DefaultPrinting`을 상속하는데 slots가 없다" → `grep DefaultPrinting`/`grep Printable`로 `sympy/core/_print_helpers.py:class Printable`에 도달. bisect 커밋(5644df199)이 회귀 도입 지점을 못박아 줘 탐색이 거의 무료.
2. **픽스와 일반화**: `Printable`에 `__slots__ = ()`만 추가. 빈 튜플이어야 하는 이유 — (a) mixin이 인스턴스 슬롯을 0개만 추가해 `__dict__` 도입을 막고, (b) 빈 slots는 다중상속을 깨지 않는다(비어있지 않은 slots를 두 부모에 두면 layout conflict). 이건 이 한 인스턴스가 아니라 `Printable`을 상속하는 모든 SymPy 클래스의 slots 체인을 일반적으로 복원하는 올바른 일반화다. hints의 `EvalfMixin.__slots__ = ()` 선례가 이 형태를 확증.
3. **regression 안전**: 21개 P2P(`Basic`의 구조/동등/치환/atoms/free_symbols 등)가 다 통과해야 함 — 빈 slots는 저장 레이아웃을 바꾸지 않으므로 이 동작들에 영향 없음. 만약 `__slots__`에 실제 이름을 넣었다면 `Basic` 서브트리의 MI가 깨져 이들이 대거 실패했을 것이므로, "빈 튜플" 선택이 곧 regression 안전의 핵심.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실수 — (a) immutability를 코드 레벨로 다시 구현하려 `__setattr__` 오버라이드를 추가(불필요·과잉, P2P 동작 깰 위험), (b) `Symbol`/`Basic` 쪽 `__slots__`를 만지려 함(원인은 부모 mixin이지 자식이 아님), (c) hints의 "그냥 `__slots__` 없애자"는 토론 갈래를 채택(반대 방향 — 그러면 immutability가 영구히 사라짐). 정답은 원인 mixin에 빈 slots를 추가하는 단 한 줄이고, "비어있지 않은 slots는 절대 넣지 않는다"가 함정 회피의 골자.
