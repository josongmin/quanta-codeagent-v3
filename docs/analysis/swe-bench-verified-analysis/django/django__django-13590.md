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
---

# django__django-13590

## 문제 요약
2.2에서 3.0으로 업그레이드하면 `__range` 같은 필터 인자로 named tuple을 넘길 때 `TypeError: __new__() missing 1 required positional argument` 가 발생한다. 2.2에서는 정상 동작하던 코드다. 사용자는 `Company.objects.filter(num_employees__range=SomeNamedTuple(min, max))` 처럼 named 2-tuple을 그대로 넘겨도 예전처럼 동작하기를 기대한다.

## 유형 분류
- 버그 카테고리: regression (2.2→3.0), edge-case (namedtuple 생성자 시그니처)
- 서브시스템: django ORM query resolution (`django.db.models.sql.query.Query`)
- 증상 타입: 예외 (TypeError, 쿼리 빌드 단계에서 크래시)
- 로컬라이제이션 신호: problem_statement가 `django.db.models.sql.query.Query.resolve_lookup_value`를 함수 이름까지 명시하고, "tuple 원소를 resolve한 뒤 같은 type으로 재구성하면서 iterator를 생성자에 넘긴다"고 근본 메커니즘까지 짚어준다. 거의 좌표를 찍어준 케이스.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` : `Query.resolve_lookup_value`
- 근본 원인: `value`가 list/tuple일 때 각 원소를 재귀 resolve한 뒤 `type(value)(generator)` 로 원래 타입을 보존하며 재구성한다. 일반 `tuple`/`list`는 단일 iterable 인자 생성자(`tuple(iter)`)를 받지만, namedtuple의 `__new__`는 위치 인자를 필드 개수만큼 받기 때문에 generator 하나만 넘기면 "인자 부족" TypeError가 난다.
- 수정 요지: generator를 `values` 변수로 분리하고, `type_ = type(value)` 를 구한 뒤 `hasattr(type_, '_make')`로 namedtuple인지 판별한다. namedtuple이면 `type_(*values)`로 언팩해 넘기고, 아니면 기존대로 `type_(values)`로 iterable을 넘긴다. `_make`는 namedtuple만 가지는 식별 속성이라 안전한 분기 키.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_range_lookup_namedtuple` — `namedtuple('EmployeeRange', ['minimum','maximum'])`로 `num_employees__range=EmployeeRange(51, 100)` 필터를 건다.
- 테스트가 픽스를 증명하는 방법: `setUpTestData`에서 `num_employees=99` 회사를 `cls.c5`로 캡처해두고, range(51~100) 필터 결과가 정확히 `[self.c5]`와 같은지 `assertSequenceEqual`로 확인한다. 픽스 전에는 필터 빌드 시점에 TypeError로 죽고, 픽스 후에는 namedtuple이 정상 언팩되어 쿼리가 실행되고 올바른 행을 돌려준다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 함수를 직접 지목하므로 `resolve_lookup_value`로 바로 진입. `type(value)(generator)` 재구성 라인이 유일한 수정 지점.
- 함정/난이도: (1) namedtuple 식별을 `isinstance(value, tuple)` 만으로 하면 일반 tuple과 구분 못 함 — `_make`/`_fields` 속성 체크가 정석. (2) `*values`로 항상 언팩하면 일반 list/tuple의 가변 길이 케이스가 깨지므로 분기가 필요. (3) generator는 1회용이라 분기 전에 미리 소비하면 안 됨 — 골드도 generator를 한 경로에서만 소비한다.
- 우리 에이전트 관점: 단일 파일·단일 함수·~5줄 수정이라 로컬라이제이션은 거의 공짜. 막힐 만한 지점은 namedtuple 판별 관용구를 모르고 `try/except TypeError`로 우회하거나, 일반 tuple까지 `*` 언팩으로 망가뜨려 PASS_TO_PASS(F-expression in range 등)를 회귀시키는 것. `_make` hasattr 분기가 회귀 안전한 정답.
