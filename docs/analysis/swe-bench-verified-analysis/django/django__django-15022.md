---
instance_id: django__django-15022
repo: django/django
base_commit: e1d673c373a7d032060872b690a92fc95496612e
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-10-24T17:48:28Z
fail_to_pass: 3
pass_to_pass: 56
gold_files: [django/contrib/admin/options.py]
---

# django__django-15022

## 문제 요약
admin changelist 검색에서 search_fields에 FK/M2M 관계 필드가 포함되고 검색어가 여러 단어(>3)일 때, 단어마다 `queryset = queryset.filter(...)`를 반복 호출하는 패턴 때문에 단어 수만큼 동일 관계 테이블에 JOIN이 누적된다. 1만 row 규모 테이블에서 검색이 사실상 멈춰버린다(stall). 사용자는 여러 단어 검색이 합리적인 SQL(중복 JOIN 없이)로 실행되길 기대했다.

## 유형 분류
- 버그 카테고리: logic / 성능 회귀 (반복 filter 호출이 JOIN을 매번 새로 만듦)
- 서브시스템: django.contrib.admin changelist 검색 (ORM query 생성과 연계)
- 증상 타입: 성능 (N개 단어 → N개 중복 JOIN으로 인한 쿼리 hang/stall). 부수적으로 다중값 관계에서 결과 정확성도 달라짐(silent-wrong 교정)
- 로컬라이제이션 신호: "admin changelist query", "search_fields", "각 단어가 추가 JOIN을 만든다", "qs = qs.filter(...) 패턴" — 곧바로 `ModelAdmin.get_search_results`의 검색어 루프를 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py` : `ModelAdmin.get_search_results` (내부 `construct_search` 헬퍼가 있는 메서드)
- 근본 원인: `for bit in smart_split(search_term)` 루프 안에서 단어마다 `queryset = queryset.filter(or_queries)`를 호출. 각 filter 호출은 별도의 multi-valued 관계 JOIN을 생성하므로, 단어 개수만큼 JOIN이 쌓여 쿼리가 폭발한다.
- 수정 요지: 루프 안에서 즉시 filter하지 않고 단어별 OR 조건(`or_queries`)을 `term_queries` 리스트에 누적한 뒤, 루프가 끝나고 단 한 번 `queryset = queryset.filter(models.Q(*term_queries))`로 AND 결합해 적용한다. 단일 filter 호출이라 관계 JOIN이 한 번만 생성된다. 부작용으로 다중값 관계에서 "모든 단어가 같은 row에 매치되어야 한다"는 의미가 바뀐다(이전엔 서로 다른 row에 단어가 흩어져 매치돼도 통과했음).

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_many_search_terms`: 80번 반복된 'daniel' 검색어로도 결과가 1건이고, 캡처된 SQL의 `JOIN` 개수가 정확히 1이어야 함 — JOIN 누적 회귀를 직접 단언.
  - `test_related_field_multiple_search_terms`: `ParentAdminTwoSearchFields`(search_fields=`child__name`, `child__age`)에서 'danielle 19'는 0건('danielle'와 '19'가 서로 다른 child row), 'daniel 19'는 1건(같은 row Daniel/age=19) — 다중값 관계의 AND-on-same-row 의미를 검증.
- 기존 `test_multiple_search_fields`의 기대값도 `('Mary Jonathan Duo', 1)` → `0`으로 변경: 이전 동작이 의도치 않은 cross-row 매치였음을 명시.
- 테스트는 `CaptureQueriesContext`로 실제 발행 SQL을 잡아 JOIN 수를 세고, queryset.count()로 결과 정확성을 동시에 증명한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `contrib/admin/options.py`에서 `search_fields` / `get_search_results` / `construct_search`를 grep. 핵심은 단어 루프 내부의 `queryset.filter` 위치 한 곳.
- 함정/난이도 메모: 단일 파일·소규모 diff지만 "JOIN 줄이기"만 보면 의미 변화(다중값 관계에서 모든 단어가 한 row에 매치되어야 함)를 놓치기 쉽다. Q 객체를 리스트에 모아 `Q(*term_queries)`로 한 번에 거는 것이 핵심 트릭. 기존 테스트 기대값까지 1→0으로 고쳐야 한다는 점이 정답을 가른다.
- 우리 에이전트 관점: 막힐 지점은 (1) 성능 문제를 "쿼리 캐싱/limit 추가" 같은 우회로 잘못 푸는 것(hints에도 #27864 term 수 제한 시도 언급), (2) filter 누적 → 단일 Q 결합 변환은 맞췄어도 다중값 관계 의미 변경을 인지 못해 `test_related_field_multiple_search_terms`와 변경된 `test_multiple_search_fields` 기대값에서 탈락하는 것.
