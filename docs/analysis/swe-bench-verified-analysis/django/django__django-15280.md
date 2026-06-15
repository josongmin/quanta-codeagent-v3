---
instance_id: django__django-15280
repo: django/django
base_commit: 973fa566521037ac140dcece73fceae50ee522f1
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-01-04T11:16:35Z
fail_to_pass: 1
pass_to_pass: 85
gold_files: [django/db/models/fields/related_descriptors.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15280

## 문제 요약
`only()`로 필드를 제한한 부모 쿼리셋에서 `prefetch_related`로 자식을 가져오고, 그 자식 쿼리셋이 다시 부모로 되돌아가는 중첩 `Prefetch`를 지정하면, 안쪽(중첩) prefetch 결과가 무시되고 바깥쪽 부모 인스턴스가 자식의 역참조 슬롯에 무조건 덮어써진다. 그 결과 `user.profile.user.kind`처럼 안쪽에서만 로드된 필드에 접근하면 바깥쪽 `only('email')` 인스턴스가 그 필드를 deferred 상태로 들고 있어 추가 DB 쿼리가 발생한다(`assertNumQueries(0)` 실패, `get_deferred_fields()`가 `{'kind'}` 반환). 사용자는 중첩 prefetch가 로드한 인스턴스가 보존되기를 기대했고, FK 역참조(`profile_set`)에서도 동일 증상이 난다고 보고했다. 이슈 본문에 모델·재현 테스트·실행된 SQL·`get_deferred_fields()` 출력까지 첨부되어 있다.

## 유형 (정형화)

- **L = L1 (Traceable)**: 이슈가 "instances are inheriting the set of fields they think have been deferred from the outer User queryset"로 인과를 정확히 진단하고, hints가 prefetch 역참조 수동 채움 로직을 지목한다. 다만 hints가 `query.py`의 `prefetch_one_level` (L1905-1913)을 가리키는데 골드 수정은 `related_descriptors.py`의 descriptor 쪽이라, 키워드 기반으로 단일파일 후보까지는 가지만 hint를 그대로 따르면 빗나간다 → grep 한 방의 L0는 아님.
- **S = S2 (Constraint-Reasoning) (+S6)**: 고칠 지점(역참조를 `setattr`로 수동 채우는 루프)은 좁혀지지만, 올바른 픽스는 "이미 prefetch로 채워진 역관계는 덮어쓰지 않는다"는 **불변식을 추론으로 합성**해 가드 조건(`not self.field.is_cached(rel_obj)`)을 세우는 일이다. None-가드/상수변경 같은 템플릿 매칭(S1)이 아니라, deferred-field와 prefetch 캐시의 상호작용을 따져 조건식을 만드는 의미적 수리다. 무조건 대입 한 줄을 조건부 블록으로 바꾸는 미세 구조 변경이라 보조로 S6.
- **K = K-Domain**: django ORM의 prefetch 파이프라인, `only()`가 만드는 deferred-field 집합, related descriptor가 역관계를 캐시하는 메커니즘(`is_cached`/`get_cache_name`)을 알아야 "왜 쿼리가 1번 더 도는가"를 캐시 덮어쓰기로 연결할 수 있다. 일반 파이썬 추론(K-Gen)으로는 도달 불가.

**primary type = T-ConstraintReason**: 위치는 좁혀지나(L1) 진짜 난점은 역캐시 덮어쓰기를 막는 정확한 조건을 도메인 불변식에서 합성하는 데 있다. K-Domain이 무겁지만 dominant한 병목은 "어디"가 아니라 "어떤 조건으로 가드하느냐"의 추론이므로 T-DomainBound가 아닌 T-ConstraintReason.

## 난이도 티어
**T4 (약간 어려움)**. 공식 라벨은 "15 min - 1 hour"(T3급 prior)인데 T4로 한 단 올린다.

- 이 티어로 미는 피처: (1) **constraint 추론**이 본질 — 픽스는 2줄이지만 "이미 캐시된 경우만 보존"이라는 조건을 deferred/cache 불변식에서 도출해야 한다. (2) **K-Domain** — prefetch 내부와 `only()`의 deferred 의미를 알아야 한다. (3) **넓은 P2P trap** — PASS_TO_PASS 85개가 전부 prefetch_related 동작이고, 골드는 *무조건* 대입이던 동작을 조건부로 바꾸므로 인접 동작(특히 `test_nested_prefetch_related_are_not_overwritten`, `DirectPrefetchedObjectCacheReuseTests`)을 깰 여지가 크다. (4) **hints 오도** — hints가 `query.py`를 가리켜 잘못된 파일을 고치게 유도한다.
- 공식 라벨보다 높은 이유: 개발자 구현 시간은 짧지만(2줄), 에이전트 관점에서 시간라벨에 안 잡히는 **localize 오도 + 넓은 회귀 표면 + 의미적 인과 이해**가 추가 비용이다. 반대로 T5까지 가지 않는 이유: 단일파일·단일헌크·has-repro라 overfit 위험과 멀티사이트 조율 부담이 없다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/related_descriptors.py` — `ReverseManyToOneDescriptor` 안에 중첩된 `RelatedManager.get_prefetch_queryset`(역 FK / one-to-many 매니저) 내부, `get_queryset()`를 우회한 뒤 역관계를 수동으로 채우는 `for rel_obj in queryset:` 루프. (`ReverseOneToOneDescriptor`가 아니다 — 그쪽 `get_prefetch_queryset`은 `set_cached_value`를 쓰며 패치에 손대지 않았다.)
- 근본 원인: prefetch가 자식(`Profile`/`Room`)들을 가져온 뒤 `get_queryset()`를 우회했기 때문에 역관계를 직접 채운다. 이때 자식 객체에 이미 중첩 `Prefetch`로 부모(`user`/`house`)가 캐시돼 있어도 무조건 `setattr(rel_obj, self.field.name, instance)`로 바깥쪽 origin 인스턴스를 덮어썼다. 바깥쪽 부모는 `only('email')`/`only('name')`로 다른 필드가 deferred 상태라, 안쪽에서 제대로 로드된 인스턴스가 사라지고 deferred 인스턴스로 교체된다 → 해당 필드 접근 시 lazy 쿼리 발생.
- 수정 요지: `setattr` 호출을 `if not self.field.is_cached(rel_obj):` 가드 안으로 감쌌다. 자식 객체가 이미 그 역관계를 캐시하고 있으면(=중첩 prefetch가 채웠으면) 덮어쓰지 않고 보존하고, 캐시되지 않은 경우에만 기존처럼 origin 인스턴스를 대입한다. `cache_name`/return tuple은 그대로.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `prefetch_related.tests.NestedPrefetchTests.test_nested_prefetch_is_not_overwritten_by_related_object` ("The prefetched relationship is used rather than populating the reverse...").
- 동작/픽스 증명: 재현 입력은 `House.objects.only('name').prefetch_related(Prefetch('rooms', queryset=Room.objects.prefetch_related(Prefetch('house', queryset=House.objects.only('address')))))`. 두 단계로 픽스를 입증한다 — (1) `self.assertIs(Room.house.is_cached(self.room), True)`로 중첩 prefetch가 채운 house 캐시가 바깥쪽에 의해 덮어써지지 않았음을 **상태 직접 단언**, (2) `with self.assertNumQueries(0): house.rooms.first().house.address`로 안쪽 `only('address')` 인스턴스가 보존돼 `address` 접근이 추가 쿼리를 안 냄을 **관찰 가능한 effect로 단언**(버그 시 1쿼리). 메인 쿼리셋 평가는 `assertNumQueries(3)`로 고정.
- overfit 관점: FAIL_TO_PASS가 1개로 얇지만, 테스트가 단순 결과값이 아니라 `is_cached` 상태 + 쿼리 카운트라는 **두 직교 신호**를 동시에 본다. special-case(예: 특정 모델/필드만 처리)로 통과시키기 어렵고, 픽스가 `is_cached`라는 일반 불변식이라 overfit 위험은 낮다 → `overfit-risk` 플래그 미부여.
- regression 관점: `regression-trap` 부여. 무조건 대입을 조건부로 바꾸므로 85개 PASS_TO_PASS가 회귀 가드다. 특히 `test_nested_prefetch_related_are_not_overwritten`, `DirectPrefetchedObjectCacheReuseTests`(add/remove가 캐시를 비우는 동작), 다양한 FK/M2M/GFK/상속 prefetch 경로가 "캐시 안 됐을 때는 여전히 origin으로 채운다"를 보증해야 한다 — `is_cached` 가드가 이 분기를 정확히 보존한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "instances are inheriting the deferred fields from the outer queryset"와 첨부된 SQL("inner User에 kind만 select했는데 deferred로 본다")을 신호로, prefetch가 역관계 인스턴스를 *대입*하는 코드를 찾는다. hints는 `query.py`의 `prefetch_one_level`을 가리키지만 그건 호출 측이고, 실제 역관계 `setattr`는 descriptor의 `get_prefetch_queryset`이다. `setattr(rel_obj, self.field.name, ...)` / `get_cache_name` / `is_cached`를 grep해 `ReverseManyToOneDescriptor`의 중첩 `RelatedManager.get_prefetch_queryset`(역 FK 매니저)의 수동 채움 루프로 수렴한다. FAIL_TO_PASS가 쓰는 관계는 `House.rooms`(=`Room.house`의 역 FK)라 정확히 이 매니저 경로다.

2. **픽스와 왜 올바른 일반화인지**: `setattr`를 `if not self.field.is_cached(rel_obj):`로 가드한다. 이는 "중첩 prefetch가 이미 채운 역관계는 권위가 있으니 origin으로 덮지 않는다"는 일반 불변식이지, `kind`/`address`/특정 모델에 묶인 특수 처리가 아니다. `is_cached`는 모든 related field가 노출하는 표준 API라 O2O·deferred 조합뿐 아니라 임의의 중첩 prefetch에 일반적으로 맞는다 → CEGIS식 special-case가 아닌 구조적 일반화.

3. **regression 안전**: 핵심은 "캐시가 없을 때는 기존 동작을 한 바이트도 안 바꾸기"다. `is_cached`가 False면 그대로 `setattr` 실행 → 일반 역 FK(one-to-many) prefetch를 비롯한 FK/M2M/GFK/멀티테이블상속 경로(85 P2P)가 모두 origin으로 채워지는 동작을 보존한다. `DirectPrefetchedObjectCacheReuseTests`처럼 add/remove로 캐시를 비우는 시나리오도 비운 뒤엔 is_cached=False라 정상 재채움된다.

4. **함정 회피**: 오라클 없는 에이전트의 주요 오답 경로 — (a) hints만 믿고 `query.py:1905-1913`을 고쳐 표면 증상만 잡거나 다른 경로를 깬다. (b) 문제 본문이 O2O(`User.profile`)로 서술돼 있어 `ReverseOneToOneDescriptor`를 고치면, 정작 FAIL_TO_PASS가 쓰는 역 FK(`rooms`/`profile_set`) 경로가 안 잡혀 그대로 실패한다(골드는 역 FK `RelatedManager.get_prefetch_queryset` 한 곳만 최소 가드한다 — O2O descriptor는 손대지 않는다). 증상이 O2O·FK 양쪽에 나타나더라도 오라클 테스트가 검증하는 단일 경로는 역 FK 매니저다. (c) 캐시 무효화/쿼리 카운트/`only()` deferred 집합 계산 쪽을 잘못 건드려 P2P 대량 회귀. (d) `is_cached` 대신 `getattr` try/except나 `hasattr`로 흉내 내 엣지(캐시된 값이 None인 경우 등)에서 어긋남. 회피법: 인과를 "역캐시 무조건 덮어쓰기"로 정확히 짚고, 표준 `is_cached` 가드라는 **2줄 최소 변경**으로 한정해 과잉 수정을 억제한다.
