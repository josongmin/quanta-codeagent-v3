---
instance_id: django__django-16661
repo: django/django
base_commit: d687febce5868545f99974d2499a91f81a32fef5
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-03-18T09:26:58Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/contrib/admin/options.py]
---

# django__django-16661

## 문제 요약
`ModelAdmin.lookup_allowed()`이 PK가 외래키(OneToOneField primary_key=True 등)인 모델을 거칠 때 정상 lookup을 `DisallowedModelAdminLookup`으로 잘못 막는다. 예를 들어 `Restaurant.place`가 PK 역할의 OneToOneField일 때 `restaurant__place__country`가 `list_filter`에 있는데도 차단된다. 사용자는 list_filter에 등록된 관계 lookup이 허용되길 기대했고, 같은 코드가 Django 1.8에서는 통과했다.

## 유형 분류
- 버그 카테고리: regression / edge-case (FK-as-PK를 concrete inheritance로 오인)
- 서브시스템: django.contrib.admin (ModelAdmin lookup 권한 검사)
- 증상 타입: 예외 (DisallowedModelAdminLookup 부당 발생)
- 로컬라이제이션 신호: 메시지의 `lookup_allowed`, `list_filter`, 그리고 problem_statement이 직접 "admin이 FK를 PK로 가진 것을 concrete inheritance와 동일시한다 → restaurant__country로 단축한다"고 원인을 지목 → `django/contrib/admin/options.py`의 `lookup_allowed`

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py:ModelAdmin.lookup_allowed`
- 근본 원인: lookup 경로를 따라가며 "이 part가 부모 모델에서 이미 찾을 수 있는 값이면 relation_parts에 추가하지 않고 건너뛴다"는 단축 로직이 있었다. 그 단축 판정이 `field not in prev_field.path_infos[-1].target_fields`였는데, PK가 FK인 경우 target_fields가 그 FK를 가리켜 정상 관계 part까지 inheritance처럼 흡수해 버려 `restaurant__country`로 줄여 list_filter 미등록으로 차단됐다.
- 수정 요지: 단축 조건을 target_fields 기반 비교에서 실제 부모/PK 판정으로 교체했다. 이제 part를 건너뛰려면 (1) field가 `model._meta.parents.values()`(진짜 concrete 부모 링크)에 없고, (2) field가 `model._meta.auto_field`가 아니며, (3) auto_field가 None이거나 part가 `prev_field.to_fields`에 없어야 한다. 즉 진짜 상속 부모 링크와 자동 PK 케이스만 단축하고, FK-as-PK는 정상 관계 part로 유지한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_lookup_allowed_foreign_primary` — `Country/Place/Restaurant(place=OneToOneField primary_key)/Waiter` 체인을 `@isolate_apps`로 정의하고 `WaiterAdmin.list_filter`에 `restaurant__place__country`, `restaurant__place__country__name`을 등록.
- 픽스 증명: `ma.lookup_allowed('restaurant__place__country', '1')`, `'restaurant__place__country__id__exact'`, `'restaurant__place__country__name'`이 모두 `True`를 반환해야 한다. 버그 코드에서는 경로가 `restaurant__country`로 단축되어 list_filter 미등록 → False/예외가 났고, 픽스 후 단축이 안 일어나 정상 True.

## 공략 포인트 (뭘 조져야)
- 어디부터: `lookup_allowed` 단일 함수의 relation_parts 누적 루프. 단일 파일·단일 함수라 멀티파일 아님.
- 함정/난이도 메모: 핵심은 "왜 target_fields 비교가 FK-as-PK에서 무너지는가"를 이해하는 것. concrete inheritance(`_meta.parents`), 자동 PK(`_meta.auto_field`), FK PK의 `to_fields`를 구분해야 한다. 단순히 조건을 지우면 다른 케이스(auto_field로 끝나는 `__id` lookup)가 깨진다 — PASS_TO_PASS의 `test_lookup_allowed_onetoone`, `test_lookup_allowed`가 회귀 가드.
- 우리 에이전트 관점: Django _meta 내부 API(`parents`, `auto_field`, `path_infos`, `to_fields`)에 대한 도메인 지식이 없으면 "왜 단축 로직이 있는지" 의도를 파악 못 해 과교정하기 쉽다. 기존 단축의 정당한 케이스(상속/자동PK)는 보존하면서 FK-PK만 배제하는 정밀 조건을 도출하는 게 핵심 난점. hints의 bisect 커밋(8f30556)을 못 보면 회귀 도입 지점 역추적이 더 어려움.
