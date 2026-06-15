---
instance_id: django__django-13158
repo: django/django
base_commit: 7af8f4127397279d19ef7c7899e93018274e2f9b
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-07-06T19:18:11Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [django/db/models/sql/query.py]
---

# django__django-13158

## 문제 요약
`union()`(또는 intersection/difference) 같은 결합 쿼리셋에 `.none()`을 호출하면 빈 결과가 아니라 모든 결과가 반환된다. 증상은 `ModelMultipleChoiceField`에 union 쿼리셋을 넣고 빈 폼을 제출했을 때 드러나는데, 아무것도 선택하지 않았는데도 쿼리셋에 매칭되는 모든 객체가 저장된다. 동일 시나리오에서 OR(`|`) 쿼리셋은 정상적으로 0개를 반환하므로, 사용자는 `.none()`이 결합 쿼리셋에서도 똑같이 빈 결과를 내길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (edge-case) — set-operation 쿼리에 대해 empty 전파가 빠짐
- 서브시스템: django ORM query (SQL compiler / combined queries)
- 증상 타입: silent-wrong (예외 없이 잘못된 결과 — 전체 행 반환)
- 로컬라이제이션 신호: "QuerySet.none() on combined queries returns all results" + hint "doesn't work properly on combined querysets". `none()`은 내부적으로 `set_empty()`를 호출하고, "combined"는 `Query.combined_queries`를 가리킨다. 즉 `sql/query.py`의 `set_empty`가 핵심.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py`:`Query.set_empty`, `Query.clone`
- 근본 원인: `none()` → `set_empty()`는 바깥 쿼리의 `where`에만 `NothingNode`를 추가했다. 하지만 `union()`이 만든 결합 쿼리는 실제 SQL을 `combined_queries`에 보관하고 이들을 UNION으로 합쳐 컴파일한다. 바깥 where에 추가된 `NothingNode`는 컴파일 시 결합 쿼리 본체에 적용되지 않아, 각 subquery는 원래 조건 그대로 실행되고 합집합이 전부 반환된다.
- 수정 요지: (1) `set_empty()`가 자기 where에 `NothingNode`를 넣은 뒤 `for query in self.combined_queries: query.set_empty()`로 모든 결합 하위 쿼리에도 empty를 재귀 전파. (2) `clone()`에서 `obj.combined_queries = tuple(query.clone() for query in self.combined_queries)`를 추가해, 클론된 쿼리가 원본과 결합 쿼리 객체를 공유하지 않도록 깊은 복사. 이게 없으면 `set_empty()`가 원본의 결합 쿼리까지 변형시키는 부작용이 생긴다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_union_none` — `qs1.union(qs2)` 결합 쿼리셋에 `.none()`을 적용했을 때 빈 시퀀스가 나오는지 검증.
- 증명 방식: `qs3 = qs1.union(qs2)` 생성 후 `assertSequenceEqual(qs3.none(), [])`로 `.none()`이 실제로 0개를 반환함을 확인하고, 이어서 `assertNumbersEqual(qs3, [0, 1, 8, 9], ordered=False)`로 `.none()` 호출이 원본 `qs3`를 오염시키지 않았음(클론 분리)을 확인한다. 즉 한 테스트가 set_empty 전파와 clone 격리 두 수정을 모두 커버한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `none()`의 구현 경로를 따라간다 — `QuerySet.none` → `query.set_empty`. `sql/query.py`에서 `set_empty`/`is_empty`와 `combined_queries` 필드를 잡으면 빠르게 수렴한다.
- 함정/난이도 메모: `set_empty`에 한 줄만 추가하면 FAIL_TO_PASS의 첫 assert는 통과하지만, `clone`을 안 고치면 `combined_queries`가 공유 참조라 `.none()`이 원본을 변형시켜 두 번째 assert(`assertNumbersEqual(qs3, ...)`)에서 깨진다. clone 수정은 problem_statement에 직접 안 적혀 있어 놓치기 쉬운 숨은 절반이다.
- 우리 에이전트 관점: 단일 함수만 보고 `set_empty` one-liner로 끝냈다 선언하면 clone 부작용 회귀를 놓친다. 테스트의 두 번째 assertion이 격리를 강제하므로, 픽스 후 결합 쿼리 객체의 mutation 공유 여부를 반드시 점검해야 한다.
