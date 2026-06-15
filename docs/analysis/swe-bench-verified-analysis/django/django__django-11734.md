---
instance_id: django__django-11734
repo: django/django
base_commit: 999891bd80b3d02dd916731a7a239e1036174885
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-09-01T18:46:50Z
fail_to_pass: 1
pass_to_pass: 275
gold_files: [django/db/models/fields/__init__.py, django/db/models/fields/related_lookups.py, django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-11734

## 문제 요약
`exclude()` 또는 `~Q()` 안에서 `OuterRef('pk')`를 쓰면 서브쿼리가 깨진다. `Item.objects.filter(tags__category_id=OuterRef('pk'))`는 정상이지만, 동일 lookup을 `exclude()`/`filter(~Q(...))`로 바꾸면 초기엔 `ValueError: This queryset contains a reference to an outer query and may only be used in a subquery`가 났고, 그게 고쳐진 뒤에는 `OuterRef`가 바깥 쿼리(`queries_number`)가 아니라 split된 내부 alias(`V0`)로 잘못 resolve되어 `missing FROM-clause entry for table "V0"`가 났다(hints의 SQL 덤프가 `"V0"."id"`로 잘못 매핑됨을 직접 보여줌). 사용자 기대는 exclude/부정 Q에서도 filter와 동일하게 `OuterRef`가 한 단계 바깥 쿼리를 참조하는 것.

## 유형 (정형화)
- **L = L3 (Multi-site)** — 픽스가 3개 파일(`sql/query.py`, `fields/related_lookups.py`, `fields/__init__.py`)에 걸쳐 **함께** 바뀌어야 한다. `split_exclude`에 OuterRef 분기를 추가하면, 그 OuterRef가 related-lookup 준비 단계에서 "직접값"으로 오인되어 다시 정규화되는 2차 결함이 드러나므로 `RelatedLookupMixin.get_prep_lookup`의 가드도 동시에 풀어야 하고, 그 가드 변경이 `AutoField.get_prep_value`의 임시 OuterRef 우회를 불필요(=삭제 가능)하게 만든다. 세 변경이 인과적으로 묶여 있어 단일-사이트가 아니다.
- **S = S2 (+S6)** — 고칠 지점(`split_exclude`)은 비대칭 증상으로 좁혀지지만, **올바른 식을 추론으로 합성**해야 한다: 이미 `OuterRef`인 RHS를 `OuterRef(filter_rhs)`로 **한 번 더** 감싸는 게 정답인데, 이는 inner Query로 한 단계 내려갈 때 참조 깊이(relabel depth)를 보정하는 불변식 추론이지 G&V 시행착오로 나오지 않는다(직관에 반함). 보조로 S6: 단순 한 줄이 아니라 "가드 완화 → 죽은 우회 제거"라는 cross-file 정리(lifecycle 재배치성 구조 변경)를 동반한다.
- **K = K-Domain** — django ORM의 negated-Q → `pk__in <subquery>` 분리 메커니즘, `OuterRef`/`ResolvedOuterRef`의 resolve_expression 계약, query alias relabeling을 알아야 픽스가 왜 "한 번 더 래핑"인지 이해된다. 일반 파이썬 추론(K-Gen)으로는 도달 불가, 공개 시그니처 호환(K-API) 이슈도 아님.
- **primary type = T-DomainBound** — L3 멀티사이트라 T-DiffuseLoc 후보지만, "어디인지 찾기"는 hints SQL 덤프(`V0` 오매핑) + filter/exclude 비대칭으로 사실상 풀린다. 진짜 병목은 ORM 내부 동작(split_exclude relabel, resolve_expression 계약)을 알아야 올바른 식을 합성·가드 정리를 할 수 있다는 점 → K-Domain이 dominant.

## 난이도 티어
- **티어: T5 (어려움)**
- 이 티어로 미는 구조적 피처:
  - **L3 멀티파일 조율(3파일)** — TAXONOMY 구조컷상 ≥3파일이면 solve <10% 구간. 세 파일이 인과적으로 묶여 한 군데만 고치면 다른 경로에서 다시 막힌다(`cross-file-dep`).
  - **S2의 비직관 추론** — `OuterRef`를 `OuterRef(...)`로 재래핑하는 relabel-depth 보정은 ORM alias 생애주기를 모르면 못 만든다.
  - **넓은 P2P trap (275건)** — `Queries1~6Tests`/`ExcludeTest17600`/`RelatedLookupTypeTests`/`ToFieldTests`/`JoinReuseTest` 등 query.py·related_lookups.py 핵심 경로를 광범위하게 커버. `get_prep_lookup` 가드를 `rhs_is_direct_value()`→`not hasattr(...,'resolve_expression')`로 바꾸는 변경은 단일컬럼 related-lookup 정규화 전체에 영향을 줘 회귀 위험이 큼(`regression-trap`).
- **공식 라벨(15min–1h)과 차이**: 공식은 "개발자 구현시간"이라 **diff 자체는 작아** 1시간 미만이 맞다. 하지만 에이전트 관점에서는 (a)3파일 조율 localize, (b)재래핑이라는 비직관 픽스 합성, (c)related-lookup 가드 변경의 광역 regression 통제가 시간라벨에 안 잡히는 난점이라 T5로 올린다(시간라벨은 prior로만 사용).

## 골드패치 분석
- **건드린 파일·함수**
  - `django/db/models/sql/query.py : Query.split_exclude` — exclude를 내부 `NOT IN` 서브쿼리로 분리할 때 RHS가 `OuterRef`인 경우 분기 추가.
  - `django/db/models/fields/related_lookups.py : RelatedLookupMixin.get_prep_lookup` — 직접값 판정 가드 변경.
  - `django/db/models/fields/__init__.py : AutoField.get_prep_value` — 임시 OuterRef 특수처리 **삭제**.
- **근본 원인**: `split_exclude`는 부정 조건을 새 inner `Query`의 `pk__in=<subquery>` 형태로 재작성한다. 기존 코드는 RHS가 `F`일 때만 `OuterRef(filter_rhs.name)`로 다시 감싸 바깥 컨텍스트를 보존했고, RHS가 **이미 `OuterRef`인 경우는 처리하지 않았다**. 그 결과 inner Query로 분리·relabel될 때 `OuterRef`의 참조 대상이 한 단계 안쪽(split이 만든 alias `V0`)으로 밀려 `missing FROM-clause`가 났다. 더해 related-lookup 준비 단계가 `rhs_is_direct_value()`를 참으로 판정해 `OuterRef`를 직접값처럼 `get_normalized_value`/`get_prep_value`로 정규화해 버리는 2차 결함이 있었고, 이를 가리려고 `AutoField.get_prep_value`에 OuterRef 우회가 박혀 있었다.
- **수정 요지**:
  - `split_exclude`에 `isinstance(filter_rhs, OuterRef)` 분기 추가 → `filter_expr = (filter_lhs, OuterRef(filter_rhs))`로 **한 번 더 래핑**해, 분리된 inner query 기준에서 다시 한 단계 바깥(원래 outer)을 가리키도록 relabel 깊이를 보정. 기존 `elif isinstance(filter_rhs, F)` 경로는 보존.
  - `get_prep_lookup` 가드를 `self.rhs_is_direct_value()` → `not hasattr(self.rhs, 'resolve_expression')`로 교체. `OuterRef`처럼 `resolve_expression`을 가진 표현식은 직접값에서 제외되어 잘못 정규화되지 않음.
  - 위 가드 변경으로 `AutoField.get_prep_value`의 OuterRef 우회가 불필요해져 삭제(중복 안전망 제거).

## 검증 (test_patch)
- **FAIL_TO_PASS (1건)**: `test_subquery_exclude_outerref (queries.tests.ExcludeTests)`
- **동작/픽스 증명**:
  - `JobResponsibilities.objects.filter(Exists(Responsibility.objects.exclude(jobs=OuterRef('job'))))`로 exclude+OuterRef 서브쿼리를 구성. 패치 전엔 SQL 생성/실행에서 크래시.
  - 단순 "크래시 안 남"을 넘어 **결과 토글**을 단언: 초기 `qs.exists()`가 `True`여야 하고, `self.r1.delete()`로 데이터를 지운 뒤 `qs.exists()`가 `False`로 바뀌어야 한다. 즉 `OuterRef`가 올바른 바깥 row(`queries_number`/해당 outer)에 결합되어 데이터 변화에 정확히 반응하는지 확인 → relabel depth가 맞아야만 통과.
  - 보조 변경: `setUpTestData`에서 `r1`을 `cls.r1`로 승격시켜 테스트 내부에서 삭제 가능하게 함.
- **overfit 관점**: FAIL_TO_PASS가 1건이라 얇아 보이지만, 토글 단언(`True`→delete→`False`)이 special-case 통과를 막아 overfit 위험을 낮춘다. 단, exclude만 검증하고 `filter(~Q(...))` 경로는 직접 단언하지 않아 미세한 underspec 여지는 있음(같은 split_exclude를 거치므로 실질 커버).
- **regression 관점**: P2P 275건이 핵심 query/related-lookup 경로를 광범위하게 잡고 있어, 특히 `get_prep_lookup` 가드 완화가 `RelatedLookupTypeTests`/`ToFieldTests`/`Queries1~6Tests`/`ExcludeTest17600`을 깨지 않는지로 일반화 안전성을 보증한다. `AutoField.get_prep_value` 삭제가 다른 OuterRef 경로를 깨지 않는지도 이 광역 스위트가 가드.

## 모범답안 (오라클 기반)
1. **localize 경로**: 두 가지 강한 신호를 결합한다. (a)증상 비대칭 — `filter()`는 OK인데 `exclude()`/`~Q()`만 깨짐 → 두 경로가 갈리는 지점은 negated-Q를 subquery로 분리하는 `Query.split_exclude`. (b)hints의 SQL 덤프 — `OuterRef`가 `queries_number."id"`가 아니라 split alias `"V0"."id"`로 매핑됨 → relabel/분리 단계 문제임을 확정. `split_exclude` 본문에서 `isinstance(filter_rhs, F)` 분기 바로 옆에 `OuterRef` 케이스가 비어 있음을 발견하는 게 정공법.
2. **픽스와 올바른 일반화인 이유**: F를 `OuterRef`로 감싸 바깥 컨텍스트를 보존하던 것과 대칭으로, **이미 OuterRef인 RHS도 `OuterRef(filter_rhs)`로 한 번 더 감싼다**. 직관에 반하지만, inner Query로 한 단계 내려갈 때 참조 깊이가 +1 밀리므로 outer를 가리키려면 OuterRef를 한 겹 더 씌워야 한다 — 이것이 특정 테스트가 아니라 "split이 depth를 한 단계 늘린다"는 불변식에서 나온 일반해라 overfit이 아니다. 동반으로 related-lookup 가드를 `resolve_expression` 보유 여부로 바꿔 resolvable 표현식 전반(OuterRef 포함)이 직접값 정규화를 우회하게 일반화.
3. **regression 안전**: `get_prep_lookup` 가드 완화는 단일컬럼 related-lookup 정규화 전반에 영향 → `RelatedLookupTypeTests`(correct/wrong_type/wrong_backward), `ToFieldTests`, `Queries1~6Tests`, `ExcludeTest17600`, `ManyToManyExcludeTest`를 깨면 안 된다. `rhs_is_direct_value()`가 참이던 일반 값(정수 pk 등)은 여전히 `resolve_expression`이 없어 직접값으로 남으므로 동작 보존. `AutoField.get_prep_value` 삭제는 가드가 OuterRef를 이미 직접값에서 제외하므로 안전(이중 안전망 제거).
4. **함정 회피**: 오라클 없는 에이전트는 표면 메시지(`ValueError`/`missing FROM-clause`)만 보고 `OuterRef`/`ResolvedOuterRef` 클래스나 `resolve_expression` 자체를 헤맬 수 있다 — 핵심은 **분리 시점(split_exclude)의 relabel depth**이지 표현식 클래스가 아니다. 또 split_exclude 한 줄만 고치고 멈추면 related-lookup 정규화가 OuterRef를 직접값으로 잡아 다른 경로에서 다시 깨진다(false-fixed). 반대로 가드를 너무 넓게 풀면 P2P related-lookup 회귀를 부른다 — `not hasattr(..., 'resolve_expression')`라는 정확한 경계로 resolvable만 빼야 한다. "이미 OuterRef인데 또 감싸나?"라는 의심으로 재래핑을 버리는 것이 가장 흔한 오답.
