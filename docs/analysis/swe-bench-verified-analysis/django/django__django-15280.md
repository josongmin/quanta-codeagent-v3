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
---

# django__django-15280

## 문제 요약
`only()`로 필드를 제한한 부모 쿼리셋에서 `prefetch_related`로 자식을 가져오고, 그 자식 쿼리셋이 다시 부모로 되돌아가는 중첩 `Prefetch`를 지정하면, 안쪽(중첩) prefetch 결과가 무시되고 바깥쪽 부모 인스턴스가 자식의 역참조 슬롯에 덮어써진다. 그 결과 사용자가 `user.profile.user.kind`처럼 안쪽에서만 로드된 필드에 접근하면 deferred로 잘못 인식되어 추가 쿼리(`assertNumQueries(0)` 실패)가 발생한다. 사용자는 중첩 prefetch가 로드한 인스턴스가 그대로 보존되기를 기대했다.

## 유형 분류
- 버그 카테고리: logic / edge-case (역참조 캐시 무조건 덮어쓰기)
- 서브시스템: django ORM — prefetch_related / related descriptors
- 증상 타입: silent-wrong (잘못된 인스턴스 할당 → 의도치 않은 추가 DB 쿼리)
- 로컬라이제이션 신호: problem_statement이 "instances are inheriting the set of fields they think have been deferred from the outer User queryset"라고 정확히 진단; hints_text가 `prefetch_one_level`의 "already cached instances를 special-case"하라고 명시. 핵심은 자식 객체의 reverse 관계를 부모로 설정하는 `get_prefetch_queryset` 내부 setattr 루프.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/related_descriptors.py` : `ReverseOneToOneDescriptor.get_prefetch_queryset` (그리고 역참조를 수동으로 채우는 루프)
- 근본 원인: prefetch가 자식(`Profile`/`Room`)들을 가져온 뒤, `get_queryset()`를 우회했기 때문에 역관계를 수동으로 채운다. 이때 자식 객체에 이미 중첩 Prefetch로 부모(`user`/`house`)가 캐시되어 있어도 무조건 `setattr(rel_obj, self.field.name, instance)`로 바깥쪽 부모 인스턴스를 덮어썼다. 바깥쪽 부모는 `only('email')`로 다른 필드가 deferred 상태라, 안쪽에서 제대로 로드된 인스턴스가 사라지고 deferred 인스턴스로 바뀐다.
- 수정 요지: setattr 전에 `if not self.field.is_cached(rel_obj):` 가드를 추가. 자식 객체가 이미 해당 역관계를 캐시하고 있으면(=중첩 prefetch가 채웠으면) 덮어쓰지 않고 그 인스턴스를 보존한다. 캐시되지 않은 경우에만 기존처럼 origin 인스턴스를 할당.

## 검증 (test_patch)
- FAIL_TO_PASS: `NestedPrefetchTests.test_nested_prefetch_is_not_overwritten_by_related_object` — "The prefetched relationship is used rather than populating the reverse..."
- 재현 입력: `House.objects.only('name').prefetch_related(Prefetch('rooms', queryset=Room.objects.prefetch_related(Prefetch('house', queryset=House.objects.only('address')))))`
- 증명 방식: 두 단계로 픽스를 증명한다. (1) `Room.house.is_cached(self.room) is True` — 중첩 prefetch가 채운 house 캐시가 바깥쪽에 의해 덮어써지지 않았음을 직접 단언. (2) `with self.assertNumQueries(0): house.rooms.first().house.address` — 안쪽 `only('address')`로 로드된 인스턴스가 보존됐으므로 `address` 접근 시 추가 쿼리가 0이어야 함(버그 시 1 쿼리 발생). 메인 쿼리셋 평가는 `assertNumQueries(3)`로 고정.

## 공략 포인트 (뭘 조져야)
- localization 전략: prefetch가 reverse 관계를 "수동으로 채우는" 코드를 찾는다. hints가 `query.py`의 `prefetch_one_level`을 가리키지만 실제 골드 수정은 descriptor 쪽 `get_prefetch_queryset`의 setattr 루프다. `is_cached` / `get_cache_name` / `setattr(rel_obj, self.field.name, ...)` 패턴을 grep하면 빠르게 좁혀진다.
- 함정/난이도: (1) hints가 가리키는 위치(`query.py` 1905-1913)와 실제 수정 위치(`related_descriptors.py`)가 다르다 — hints만 믿고 query.py를 고치면 표면 증상만 잡거나 회귀를 낸다. (2) `ReverseOneToOneDescriptor`만 손대면 되는데 ForeignKey reverse(`profile_set`) 경로도 같은 증상이라 헷갈릴 수 있음(골드는 O2O descriptor 한 곳 수정으로 처리). (3) 무조건 덮어쓰던 동작을 바꾸므로 84개 PASS_TO_PASS 회귀(특히 `test_nested_prefetch_related_are_not_overwritten`, `DirectPrefetchedObjectCacheReuseTests`)를 깨지 않아야 한다 — `is_cached` 가드라는 최소 변경이 핵심.
- 우리 에이전트 관점: deferred-field/prefetch 캐시의 상호작용이라는 의미적 인과를 이해해야 한다. "왜 쿼리가 1번 더 도는가"를 `only()`의 deferred 상태와 역캐시 덮어쓰기로 연결하지 못하면, 캐시 무효화나 쿼리 카운트 쪽을 잘못 건드릴 위험이 크다. 정답은 단 2줄 가드라 과잉 수정 억제가 관건.
