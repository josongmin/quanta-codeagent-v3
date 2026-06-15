---
instance_id: django__django-15957
repo: django/django
base_commit: f387d024fc75569d2a4a338bfda76cc2f328f627
version: 4.2
difficulty: 1-4 hours
created_at: 2022-08-13T06:18:25Z
fail_to_pass: 4
pass_to_pass: 89
gold_files: [django/db/models/fields/related_descriptors.py]
---

# django__django-15957

## 문제 요약
`Prefetch()`에 슬라이스된 queryset(예: `Post.objects.all()[:3]`)을 넘기면 `AssertionError: Cannot filter a query once a slice has been taken.`이 발생한다. prefetch는 내부적으로 `field__in=instances` 필터를 추가로 거는데, 슬라이스가 이미 적용된 query는 더 이상 필터링할 수 없기 때문이다. 사용자는 "카테고리별 예시 3개씩"처럼 그룹당 상위 N개를 효율적으로(전체 로드 없이) prefetch하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (sliced queryset 지원 미구현) / API-contract
- 서브시스템: django ORM — prefetch_related / related descriptors
- 증상 타입: 예외 (AssertionError)
- 로컬라이제이션 신호: 에러 메시지 "Cannot filter a query once a slice has been taken"은 `Query.add_q`/슬라이스 가드에서 나오며, prefetch 경로에서 `filter(**{field__in: instances})`를 호출하는 곳이 `related_descriptors.py`의 `get_prefetch_queryset` 메서드들이다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/related_descriptors.py` — 신규 헬퍼 `_filter_prefetch_queryset()`, 그리고 reverse FK 쪽 `ReverseManyToOneDescriptor` 매니저의 `get_prefetch_queryset` 및 m2m 쪽 매니저의 `get_prefetch_queryset`
- 근본 원인: prefetch는 두 단계로 동작 — (1) 관련 객체를 한 번에 쿼리한 뒤 (2) 인메모리로 부모에 join. 슬라이스가 걸린 queryset은 `query.is_sliced`라 추가 `field__in` 필터를 못 붙여 단언 실패. 단순히 슬라이스를 무시하면 그룹별 limit 의미가 깨진다.
- 수정 요지: 공통 헬퍼 `_filter_prefetch_queryset(queryset, field_name, instances)`를 도입. 기본 predicate `Q(field_name__in=instances)`를 만들고, queryset이 sliced면 `low_mark/high_mark`를 읽어 `Window(RowNumber(), partition_by=field_name, order_by=order_by)` 윈도우 표현식을 만든다. 그 뒤 `GreaterThan(window, low_mark)` 및 (high_mark가 있으면) `LessThanOrEqual(window, high_mark)`를 predicate에 AND로 결합하고, 원래 슬라이스는 `query.clear_limits()`로 제거한 뒤 `queryset.filter(predicate)`를 반환한다. 즉 LIMIT/OFFSET을 그룹별 top-N-per-group 윈도우 쿼리로 변환한다. 호출부 두 곳(forward/reverse 분기)이 인라인 `query={...}; filter(**query)` 대신 이 헬퍼를 호출하도록 교체.

## 검증 (test_patch)
- FAIL_TO_PASS: `PrefetchLimitTests`의 `test_m2m_forward`, `test_m2m_reverse`, `test_foreignkey_reverse`, `test_reverse_ordering`
- 테스트는 같은 관계를 두 번 prefetch한다 — 슬라이스 없는 `Prefetch("authors", authors)`와 슬라이스된 `Prefetch("authors", authors[1:], to_attr=...)`. `assertNumQueries(3)`로 슬라이스 prefetch도 추가 쿼리 없이(인메모리 폭발 없이) 처리됨을 보장하고, `book.authors_sliced == list(book.authors.all())[1:]`로 윈도우 기반 그룹별 슬라이스 결과가 파이썬 인메모리 슬라이스와 동일함을 증명. `test_reverse_ordering`은 `Meta.ordering` 역순(`.reverse()`)에서도 order_by 추출이 올바른지 검증.

## 공략 포인트 (뭘 조져야)
- localization 전략: AssertionError 메시지로 grep → `is_sliced`/슬라이스 가드 → prefetch 호출 경로 역추적하면 `related_descriptors.py`의 `get_prefetch_queryset`들에 도달. forward(ForwardManyToOne류)와 reverse/m2m 두 분기 모두 동일 패턴이라 공통 헬퍼로 묶는 게 정답.
- 함정/난이도 메모: (1) 슬라이스를 그냥 풀어버리면 안 되고 윈도우 함수로 그룹별 limit을 재현해야 함 — `partition_by=field_name`, `order_by`는 컴파일러의 `get_order_by()`에서 추출해야 정확. (2) `low_mark`(>)와 `high_mark`(<=)의 경계 부호가 off-by-one 위험. (3) `clear_limits()`를 빼먹으면 여전히 단언 실패. (4) `queryset._db or DEFAULT_DB_ALIAS`로 multi-db 안전 처리.
- 우리 에이전트 관점: 막힐 지점은 "슬라이스 무시"라는 순진한 픽스로 회귀할 가능성 — PASS_TO_PASS 87개와 `assertNumQueries(3)`가 인메모리 우회를 막는다. 또한 Window/RowNumber/lookups(GreaterThan, LessThanOrEqual)라는 비자명한 ORM 빌딩블록 조합을 떠올려야 해서, "그룹당 top-N은 윈도우 함수"라는 도메인 지식이 없으면 정답 구조를 못 만들 수 있다.
