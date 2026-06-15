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
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15022

## 문제 요약
admin changelist 검색에서 `search_fields`에 FK/M2M 같은 multi-valued 관계 필드가 포함되고 검색어가 여러 단어(>3)일 때, 단어마다 `queryset = queryset.filter(...)`를 반복 호출하는 패턴 때문에 단어 수만큼 동일 관계 테이블에 JOIN이 누적된다. ~1만 row 규모 테이블에서 검색이 사실상 멈춰버린다(stall). 사용자는 여러 단어 검색이 합리적인 SQL(중복 JOIN 없이)로 실행되길 기대했다. 근본적으로는 성능 결함이지만, 올바른 픽스가 동시에 다중값 관계의 검색 의미(여러 단어가 같은 row에 매치되어야 함)까지 바로잡는 silent-correctness 교정을 동반한다.

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈 본문이 결함 위치를 거의 직접 지목한다: "admin changelist query", "search_fields", "each word ... leads to additional JOIN", "`qs = qs.filter(...)` pattern", 그리고 hints가 "for bit in self.query.split(): ... qs = qs.filter(...)"라고 패턴을 그대로 인용한다. `contrib/admin/options.py`의 `get_search_results` 단어 루프 한 곳으로 grep 한 방에 수렴한다. 탐색이 거의 불필요하므로 L0.

- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 고칠 지점은 명확하나(L0) 기계적 가드/상수 치환(S1)으로 풀리지 않는다. "JOIN을 1개로 만든다"는 제약을 만족하면서 동시에 "여러 단어 = AND, 단어 내 여러 필드 = OR"라는 검색 시맨틱을 보존(실은 교정)하는 *올바른 부울 식*을 추론으로 합성해야 한다 → S2. 그리고 그 합성 방식이 단순 한 줄 수정이 아니라 "루프 안에서 즉시 filter" → "루프에서 Q를 collect한 뒤 루프 밖에서 한 번 filter"로 **collect-then-process 구조 변경**을 요구한다 → S6 보조. 단순히 limit 추가나 caching 같은 우회로는 정답이 될 수 없다는 점이 G&V(S3)가 아니라 reasoning(S2/S6)임을 가른다.

- **K-Domain** — Django ORM의 핵심 시맨틱 지식이 병목이다: `QuerySet.filter()`를 반복 체이닝하면 multi-valued 관계마다 새 JOIN/별칭이 생긴다는 점(`filter()` chaining vs 단일 `filter(Q(...) & Q(...))`의 SQL 차이), 그리고 `models.Q(*term_queries)`로 Q들을 AND 결합하면 동일 JOIN 위에서 평가된다는 점을 알아야 정답이 나온다. 일반 파이썬 추론(K-Gen)으로는 도달 불가. 공개 API 시그니처 호환 이슈(K-API)는 아님.

- **primary type = T-DomainBound** — 위치는 trivial(L0)이라 T-DiffuseLoc/T-LocTrivial 후보가 빠지고, 픽스가 기계적이지 않아 T-DirectMap도 아니다. 진짜 난점은 "Django ORM이 왜 JOIN을 중복 생성하는지, Q 결합으로 어떻게 한 JOIN에서 AND 평가되는지"라는 프레임워크 내부지식이며, 그것이 dominant 축이므로 T-DomainBound. (S2 추론도 그 도메인 지식 위에서만 성립한다.)

## 난이도 티어
**T4 (약간 어려움)** — 공식 라벨 "15 min - 1 hour"(T3급 prior)보다 한 단계 올린다.

이 티어로 미는 구조적 피처:
- **localize는 trivial(L0)·1파일·diff ~5줄** → 이 축만 보면 T2~T3.
- **그러나 K-Domain이 dominant**: ORM filter-chaining의 JOIN 누적과 Q 결합 시맨틱은 비-django 추론으로 도출 불가. 루브릭 T4 정의("constraint추론·소규모 refactor·도메인지식 중 하나")의 K-Domain + S2 + 소규모 S6 refactor 세 조건을 동시에 만족.
- **regression-trap이 실재**: PASS_TO_PASS 56개 중 검색/관계 관련 인접 테스트(`test_multiple_search_fields`, `test_select_related_preserved_when_multi_valued_in_search_fields`, `test_spanning_relations_with_custom_lookup_in_search_fields`, `#13902`/`#15819` M2M 관련)를 안 깨야 하며, 더 까다롭게 기존 `test_multiple_search_fields`의 기대값 자체를 `('Mary Jonathan Duo', 1)` → `0`으로 **바꿔야** 통과한다. 즉 "기존 테스트를 안 깬다"가 아니라 "기존 테스트가 틀렸음을 인지하고 고쳐야 한다"는 함정.
- **silent-correctness 변경 동반**: 성능만 고치고 의미 변화를 놓치면 `test_related_field_multiple_search_terms`에서 탈락.

공식 시간라벨과 다른 이유: 시간라벨은 "정답을 아는 코어 개발자의 구현시간"이라 짧지만, 오라클 없는 에이전트 관점에선 (a) 도메인지식 의존, (b) 의미변화 인지, (c) 기존 테스트 기대값 수정 필요가 모두 라벨에 안 잡히는 난이도다. localize 쉬움과 도메인+regression-trap의 상충으로 T4가 적정.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/admin/options.py` : `ModelAdmin.get_search_results`(내부 `construct_search` 헬퍼 포함 메서드).
- **근본 원인**: `for bit in smart_split(search_term)` 루프 안에서 단어마다 `queryset = queryset.filter(or_queries)`를 호출. Django ORM에서 multi-valued 관계에 대한 `filter()` 반복 호출은 호출마다 별도 JOIN(별칭)을 생성하므로, 단어 N개 → 동일 관계 테이블 N개 JOIN이 누적되어 대용량 테이블에서 쿼리가 폭발/stall한다. 추가로, 별도 JOIN으로 평가되면 서로 다른 관련 row에 단어가 흩어져 매치돼도 통과하는(cross-row) 의도치 않은 매칭 의미를 가진다.
- **수정 요지**: 루프 진입 전 `term_queries = []`를 만들고, 루프 안에서는 즉시 filter하지 않고 단어별 OR 조건(`or_queries`)을 `term_queries.append(or_queries)`로 누적한다. 루프 종료 후 단 한 번 `queryset = queryset.filter(models.Q(*term_queries))`로 모든 단어 조건을 AND 결합해 적용한다. 단일 filter 호출이므로 multi-valued 관계 JOIN이 한 번만 생성되고, 모든 단어가 **같은 관계 row**에서 평가되어 "여러 단어는 한 row에서 모두 매치" 시맨틱으로 교정된다. (collect-then-process; S6.)

## 검증 (test_patch)
- **FAIL_TO_PASS (3)**:
  - `test_many_search_terms` — 80번 반복된 `'daniel ' * 80` 검색에도 결과가 1건이고, `CaptureQueriesContext`로 잡은 SQL의 `JOIN` 개수가 **정확히 1**이어야 함. JOIN 누적 성능 회귀를 직접 단언(픽스 증명의 핵심).
  - "All rows containing each of the searched words are returned, where each ..." — 단어 AND 의미 보존 검증(docstring 라벨).
  - "Searches over multi-valued relationships return rows from related ..." (`test_related_field_multiple_search_terms`) — `ParentAdminTwoSearchFields`(search_fields=`child__name`,`child__age`)에서 `'danielle 19'`는 0건('danielle'와 '19'가 서로 다른 child row), `'daniel 19'`는 1건(같은 row Daniel/age=19). 다중값 관계의 AND-on-same-row 의미를 증명.
- **회귀 동반 수정**: 기존 `test_multiple_search_fields`의 기대값이 `('Mary Jonathan Duo', 1)` → `0`으로 변경됨 — 이전 동작이 의도치 않은 cross-row 매치였음을 명시(이 변경 없이는 픽스가 통과 못 함).
- **overfit 관점**: FAIL_TO_PASS가 (JOIN 수=1) + (count 정확성, 0/1 양쪽) + (반복 80단어 스트레스)로 성능·시맨틱 두 측면을 모두 핀으로 박아, special-case(예: 단어 수 cap)로는 통과 불가 → overfit 위험 낮음(`overfit-risk` 플래그 미부여).
- **regression 관점**: PASS_TO_PASS 56개에 검색/관계/select_related 인접 동작이 다수 포함되어 광범위(`regression-trap`). Q 결합이 single-valued 필드 검색과 builtin/custom lookup 동작을 깨지 않아야 통과.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "admin changelist", "search_fields", "each word ... additional JOIN", "`qs = qs.filter(...)` pattern" + hints의 `for bit in self.query.split(): ... qs = qs.filter(...)` 인용을 신호로 `django/contrib/admin/options.py`에서 `get_search_results` / `construct_search` / `smart_split` 루프를 grep. 단어 루프 내부의 `queryset = queryset.filter(or_queries)` 한 줄이 결함 지점.

2. **픽스와 올바른 일반화인 이유**: 루프 안 즉시 filter를 제거하고 단어별 `or_queries`를 `term_queries`에 모은 뒤 루프 밖에서 `queryset.filter(models.Q(*term_queries))` 한 번. 이게 올바른 일반화인 이유 — (a) 성능: multi-valued 관계 JOIN이 호출당 생성되므로 filter를 1회로 줄이면 JOIN도 1개로 수렴(단어 수와 무관, 80단어 스트레스에도 O(1) JOIN); (b) 시맨틱: 모든 단어 Q를 같은 JOIN 위에서 AND 평가 → "한 관련 row에서 모든 단어가 매치"가 올바른 검색 의미. 단어 수 cap이나 caching 같은 우회는 JOIN 누적 원인 자체를 안 고쳐 일반화 실패.

3. **regression 안전**: single-valued 필드(`name`, `name2`)만 검색하던 기존 케이스는 JOIN이 원래 1개라 결과 동일해야 하고, builtin/custom lookup·spanning relations·select_related 보존 테스트(PASS_TO_PASS의 #13902/#15819/`test_select_related_preserved_when_multi_valued_in_search_fields` 등)를 깨면 안 됨. `Q(*term_queries)` AND 결합은 단일 필드 검색의 부울 의미를 바꾸지 않으므로 이들을 보존. 단, cross-row로 통과하던 `('Mary Jonathan Duo', 1)`는 의도된 거짓양성이므로 기대값을 `0`으로 **고쳐야** 회귀가 아니라 교정이다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (1) 성능 문제를 "term 수 제한/limit"이나 distinct/캐싱 같은 우회로 잘못 풀기(hints가 #27864의 term-cap 시도를 언급하며 유혹); 근본 원인은 filter-chaining이므로 collect-then-Q로 변환해야 함. (2) JOIN은 1개로 줄였으나 다중값 관계의 의미 변화(cross-row → same-row AND)를 인지 못해, `test_related_field_multiple_search_terms`와 변경된 `test_multiple_search_fields` 기대값에서 탈락. (3) `models.Q(*term_queries)`의 default connector가 AND임을 활용해야 하는데 OR로 잘못 결합하면 결과 정확성 붕괴. 회피법: 픽스 후 `CaptureQueriesContext`로 JOIN 수를 직접 세고, single/multi-valued 양쪽 search_fields 시나리오로 count를 검증해 시맨틱까지 함께 확인.
