---
instance_id: django__django-15731
repo: django/django
base_commit: 93cedc82f29076c824d476354527af1150888e4f
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-05-24T12:30:05Z
fail_to_pass: 1
pass_to_pass: 58
gold_files: [django/db/models/manager.py]
---

# django__django-15731

## 문제 요약
`inspect.signature(Person.objects.bulk_create)` 같은 매니저 메서드에 대해 실제 시그니처(`(objs, batch_size=None, ...)`) 대신 `(*args, **kwargs)`가 반환된다. 매니저가 `QuerySet` 메서드를 동적으로 프록시하면서 래퍼 함수에 `__name__`과 `__doc__`만 수동 복사하고 나머지 메타데이터를 빠뜨렸기 때문이다. 그 결과 ipython/jupyter의 `<obj>?` 도움말이나 IDE 자동완성이 잘못된 시그니처를 보여준다.

## 유형 분류
- 버그 카테고리: 누락처리 (메타데이터 일부만 복사 — incomplete API-contract)
- 서브시스템: django ORM / models manager (QuerySet 프록시 생성)
- 증상 타입: silent-wrong (예외 없이 introspection 결과만 틀림)
- 로컬라이제이션 신호: problem_statement가 `django/db/models/manager.py` 파일과 정확한 라인(L84/87/88), "수동으로 name·docstring만 복사", "functools.wraps로 고쳐라"까지 명시 — 거의 패치 위치를 지목.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/manager.py` → `BaseManager._get_queryset_methods` 내부의 `create_method`/`manager_method`
- 근본 원인: `create_method`가 만든 `manager_method` 래퍼는 `*args, **kwargs`만 받는 일반 래퍼다. 여기에 `manager_method.__name__ = method.__name__`, `__doc__ = method.__doc__`만 수동 할당했기 때문에 `__wrapped__`/`__module__`/`__qualname__`/`__dict__` 등이 비고, 특히 `inspect.signature`가 원본 `QuerySet` 메서드의 시그니처를 따라가지 못한다.
- 수정 요지: `from functools import wraps`를 추가하고, 수동 `__name__`/`__doc__` 할당 2줄을 제거한 뒤 `manager_method`에 `@wraps(method)` 데코레이터를 적용한다. `wraps`는 `__wrapped__`를 세팅하므로 `inspect.signature`가 원본 시그니처를 추적(follow_wrapped)하게 되고, 이름·docstring·module·qualname 등 전체 메타데이터가 함께 복사된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_manager_method_signature (basic.tests.ManagerTest)` — `str(inspect.signature(Article.objects.bulk_create))`가 `(objs, batch_size=None, ignore_conflicts=False, update_conflicts=False, update_fields=None, unique_fields=None)`와 정확히 일치하는지 확인.
- 함께 추가된 `test_manager_method_attributes`는 `Article.objects.get.__doc__ == QuerySet.get.__doc__`, `count.__name__` 일치를 확인(기존 동작 회귀 방지). 픽스 전에는 `signature`가 `(*args, **kwargs)`라 FAIL, `@wraps` 적용 후 `__wrapped__`가 걸리며 원본 `bulk_create` 시그니처가 그대로 노출되어 PASS.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·라인·해결책까지 명시하므로 `manager.py`의 `_get_queryset_methods` → `create_method`로 바로 직행하면 된다.
- 함정/난이도 메모: 핵심은 "왜 `__name__`/`__doc__` 복사만으론 부족한가"다. `inspect.signature`는 `__wrapped__` 속성을 따라가야 하는데 수동 복사는 이걸 안 만든다. `functools.WRAPPER_ASSIGNMENTS`만 흉내내려고 추가 속성을 손으로 더 복사하는 우회는 fragile하고, 정답은 `@wraps(method)` 한 줄로 `__wrapped__`까지 챙기는 것. 단일 파일·수 줄 수정이라 멀티파일 추적은 불필요.
- 우리 에이전트 관점: 막힐 지점은 거의 없다(localization이 거의 주어짐). 유일한 리스크는 `__name__`/`__doc__`만 추가로 손보고 `inspect.signature`가 여전히 `*args,**kwargs`를 반환하는 것을 놓치는 것 — `@wraps`가 `__wrapped__`를 세팅한다는 핵심을 이해해야 FAIL_TO_PASS를 통과한다.
