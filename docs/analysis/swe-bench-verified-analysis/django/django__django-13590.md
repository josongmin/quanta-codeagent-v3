---
instance_id: django__django-13590
repo: django/django
base_commit: 755dbf39fcdc491fe9b588358303e259c7750be4
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-10-23T09:34:55Z
fail_to_pass: 1
pass_to_pass: 145
gold_files: [django/db/models/sql/query.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [regression-trap, has-repro]
---

# django__django-13590

## 문제 요약
Django 2.2 → 3.0 업그레이드 후, `__range` 같은 필터 인자로 named tuple을 넘기면 `TypeError: __new__() missing 1 required positional argument` 가 발생한다. 2.2에서는 정상 동작하던 코드다. 사용자는 `Company.objects.filter(num_employees__range=EmployeeRange(minimum=51, maximum=100))` 처럼 named 2-tuple을 그대로 넘겨도 예전처럼 동작하기를 기대한다. problem_statement가 원인 메커니즘(`resolve_lookup_value`가 tuple 원소를 resolve한 뒤 같은 type으로 재구성하면서 iterator를 생성자에 넘김)과 수정 방향(`*` 언팩)까지 직접 적어준 회귀 버그다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement가 `django.db.models.sql.query.Query.resolve_lookup_value`를 함수 이름까지 명시하고, 문제 라인("preserves the type ... passes a iterator to it's constructor")까지 자연어로 짚는다. grep 한 방으로 끝. 좌표를 찍어준 케이스.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조)** — 이슈가 사실상 픽스를 명세한다("The fix is to `*` expand the contents of the iterator into the constructor"). 정형 결함클래스(생성자 시그니처 mismatch에 대한 분기 가드 추가)에 템플릿 매칭되는 기계적 픽스. 다만 "그냥 항상 `*`로 언팩"은 일반 list/tuple을 깨므로, namedtuple만 골라내는 식별 조건(`hasattr(type_, '_make')`)을 추론해 합성해야 하는 작은 S2 요소가 들어간다 — 그래서 +S2.
- **K (Knowledge) = K-Gen** — namedtuple 식별(`_make`/`_fields`)과 iterable-vs-positional 생성자 차이는 표준 파이썬 지식이다. Django ORM 내부 도메인지식이 아니라 일반 파이썬 추론으로 충분.
- **Primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 가드 추가(S1)이며, 도메인지식 의존이 없다. T-LocTrivial이 아닌 이유는 픽스가 완전 자명(상수/기본값 한 줄)이 아니라 "namedtuple만 분기"라는 작은 조건 합성을 요구하기 때문(S2 보조). T-ConstraintReason까지는 아니다 — 올바른 식을 깊이 추론하는 게 아니라 이슈가 거의 적어준 픽스에 표준 식별 관용구만 끼우면 되기 때문.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- **파일/줄 수**: 단일 파일(`query.py`), 단일 함수(`resolve_lookup_value`), 핵심 변경 ~5줄. ICLR 2024 구조컷의 "1파일·소규모" 구간(≈48% solve)에 해당.
- **localize 직접성**: L0. problem_statement가 함수+라인+원인+해법을 다 줘서 탐색 노력이 사실상 0.
- **has-repro**: 네이티브 TypeError 메시지와 재현 시나리오(named 2-tuple을 `__range`에)가 본문에 있음 — 가장 강한 easiness 신호.
- **약한 엣지추론**: namedtuple 분기 조건을 합성해야 해서 T1(픽스 완전 자명)보다는 한 단계 위.
- **P2P trap**: PASS_TO_PASS 145개로 넓고, 그중 `test_range_lookup_allows_F_expressions_and_expressions_for_integers`, `test_in_lookup_allows_...` 등 일반 tuple/list 경로가 같은 라인을 지나간다. 분기를 잘못 짜면(`*` 항상 언팩) 회귀. 이 regression-trap이 T1로 못 내려가게 막는 두 번째 요인.

공식 라벨 "15 min - 1 hour"와의 차이: 공식 라벨은 개발자 구현시간 기준으로 약간 더 높게 본다. 에이전트 관점에서는 localize가 공짜(L0)고 픽스도 이슈가 적어줘서 실제 난이도는 T2가 더 정확하다. 다만 P2P 회귀 함정 때문에 T1로 내리지는 않는다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/sql/query.py` : `Query.resolve_lookup_value`
- **근본 원인**: `value`가 list/tuple일 때 각 원소를 재귀 resolve한 뒤 `type(value)(generator)`로 원래 타입을 보존하며 재구성한다. 일반 `tuple`/`list`는 단일 iterable 인자 생성자(`tuple(iter)`)를 받지만, namedtuple의 `__new__`는 위치 인자를 필드 개수만큼 받기 때문에 generator 객체 하나만 넘기면 "인자 부족" TypeError가 난다. 2.2→3.0에서 이 재구성 경로가 들어오면서 회귀가 발생.
- **수정 요지**: generator를 `values` 변수로 분리하고, `type_ = type(value)`를 구한 뒤 `hasattr(type_, '_make')`로 namedtuple인지 판별한다. namedtuple이면 `type_(*values)`로 원소를 언팩해 위치 인자로 넘기고, 아니면 기존대로 `type_(values)`로 iterable을 단일 인자로 넘긴다. `_make`는 namedtuple만 가지는 클래스 속성이라 안전한 분기 키. generator는 1회용이므로 분기 양쪽 중 한 경로에서만 소비된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_range_lookup_namedtuple (expressions.tests.IterableLookupInnerExpressionsTests)` — `namedtuple('EmployeeRange', ['minimum','maximum'])`로 `num_employees__range=EmployeeRange(minimum=51, maximum=100)` 필터를 건다.
- **픽스 증명**: test_patch가 `setUpTestData`에서 `num_employees=99`인 회사를 `cls.c5`로 캡처하고, range(51~100) 필터 결과가 정확히 `[self.c5]`와 같은지 `assertSequenceEqual`로 확인한다. 픽스 전에는 필터 빌드 시점에 TypeError로 크래시, 픽스 후에는 namedtuple이 정상 언팩되어 쿼리가 실행되고 올바른 행만 돌려준다.
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이지만, 픽스가 `_make` 속성 기반 구조적 분기라 special-case 하드코딩 여지가 없다. namedtuple 일반(필드 개수·이름 무관)에 대해 올바른 일반화. CEGIS류 함정(이 테스트만 통과시키는 패치)은 거의 불가능.
- **regression 관점**: PASS_TO_PASS 145개가 같은 `resolve_lookup_value` 경로를 광범위하게 커버한다. 특히 일반 tuple/list가 들어오는 F-expression range/in 룩업 테스트(`test_range_lookup_allows_F_expressions_...`, `test_in_lookup_allows_...`, `test_expressions_in_lookups_join_choice`)가 `else` 분기(`type_(values)`)를 그대로 타야 한다. `_make` 분기가 이들을 안전하게 보존한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 `django.db.models.sql.query.Query.resolve_lookup_value`를 명시 → 해당 파일·함수로 직행. 함수 안에서 `isinstance(value, (list, tuple))` 분기의 `return type(value)(...)` 한 라인이 유일한 후보. 에러 메시지(`__new__() missing 1 required positional argument`)가 "생성자에 인자 부족"을 가리켜 이 라인을 즉시 확정.
2. **픽스와 올바른 일반화 이유**: generator를 변수로 빼고 `hasattr(type_, '_make')`로 namedtuple만 골라 `type_(*values)`로 언팩, 나머지는 `type_(values)` 유지. 이게 올바른 일반화인 이유 — namedtuple은 위치 인자 생성자(`__new__(cls, f1, f2, ...)`)를 갖고 일반 tuple/list는 단일 iterable 생성자를 가지므로, 두 생성자 계약을 각각 만족시키는 최소 분기다. 특정 필드 개수/이름에 의존하지 않아 모든 namedtuple에 일반적이다. `_make`(또는 `_fields`)는 namedtuple 식별의 표준 관용구.
3. **regression 안전**: 일반 tuple/list가 들어오는 모든 경로(F-expression range/in 룩업, join-choice 등 P2P 145개)는 `_make`가 없으니 반드시 `else` 분기(`type_(values)`)로 가야 한다. 분기 키를 `isinstance(value, tuple)`로 잡으면 일반 tuple까지 언팩 경로로 빨려가 회귀하므로 금지 — namedtuple-전용 속성(`_make`)으로만 분기해야 안전.
4. **함정 회피**: 오라클 없는 에이전트의 실수 지점 — (a) `try: type_(values) except TypeError: type_(*values)`로 우회하면 generator가 첫 시도에서 소비되어 두 번째 시도가 빈 인자가 됨(generator 1회용 함정). (b) 항상 `*values` 언팩하면 일반 list/tuple의 가변길이/단일-iterable 계약을 깨 P2P 회귀. (c) namedtuple 판별을 `isinstance(value, tuple)`로 하면 일반 tuple과 구분 못 함. 정답은 generator를 변수로 한 번만 만들고, namedtuple-고유 속성(`_make`)으로 분기해 각 생성자 계약에 맞게 넘기는 것.
