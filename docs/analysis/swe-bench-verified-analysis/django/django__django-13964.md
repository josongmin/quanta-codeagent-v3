---
instance_id: django__django-13964
repo: django/django
base_commit: f39634ff229887bf7790c069d0c411b38494ca38
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2021-02-02T17:07:43Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/db/models/base.py]
---

# django__django-13964

## 문제 요약
non-auto CharField를 primary key로 갖는 모델(Product.sku)을 FK로 참조하는 자식(Order)에서, 자식에 빈 부모 인스턴스를 먼저 할당하고(`order.product = Product()`) 나중에 부모의 pk를 채운 뒤 저장하면 데이터 손실이 발생한다. 기대는 `order.product_id`가 부모의 `sku` 값("foo")으로 채워지는 것이지만, 실제로는 빈 문자열("")로 저장되어 FK 제약 위반(ForeignKeyViolation)으로 커밋이 깨진다. pk를 할당 전에 지정한 경우(`Product(sku="foo")`)는 정상 동작한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (numeric-pk만 고려한 None 체크가 빈 문자열 pk를 못 잡음)
- 서브시스템: django ORM / models 저장 경로 (FK 관계 sync)
- 증상 타입: silent-wrong → 지연된 FK 제약 위반으로 커밋 시 크래시
- 로컬라이제이션 신호: problem_statement의 "how the Order.product_id field is handled at assignment, together with ... fetching of auto vs non-auto primary keys from the related instance" + hints_text가 `_prepare_related_fields_for_save()`와 `empty_values`를 직접 지목

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/base.py` : `Model._prepare_related_fields_for_save`
- 근본 원인: 부모를 늦게 저장한 뒤 자식 저장 시 fk_val을 부모 pk로 재동기화하는 분기가 `getattr(self, field.attname) is None` 조건이었다. 이는 numeric/AutoField pk(미설정 시 None)만 빈 값으로 간주한다. CharField pk는 미설정 시 빈 문자열("")이라 None 체크를 통과하지 못해 재동기화가 일어나지 않고 ""이 그대로 남는다.
- 수정 요지: 단 한 줄. `is None` 비교를 `in field.empty_values`로 교체. `empty_values`는 `[None, '', [], (), {}]`를 포함하므로 빈 문자열 pk도 "아직 안 채워짐"으로 인식되어 부모 저장 후의 `obj.pk`로 `field.attname`을 setattr하게 된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_save_fk_after_parent_with_non_numeric_pk_set_on_child` — 문자열 pk를 갖는 부모를 자식에 할당 후 늦게 pk를 채우고 저장했을 때 product_id가 올바르게 전파되는지 확인.
- 테스트 모델 신설: `tests/many_to_one/models.py`에 `ParentStringPrimaryKey(name=CharField(primary_key=True))`와 이를 FK로 받는 `ChildStringPrimaryKeyParent` 추가.
- 재현 → 기대: `parent = ParentStringPrimaryKey()` → `child = ChildStringPrimaryKeyParent(parent=parent)` → `child.parent.name = 'jeff'` → `parent.save()` → `child.save()` → `refresh_from_db()` 후 `child.parent == parent` 그리고 `child.parent_id == parent.name`('jeff')이어야 한다. 픽스 전에는 parent_id가 ""로 저장되어 실패.

## 공략 포인트 (뭘 조져야)
- localization: FK 저장 경로의 핵심은 `_prepare_related_fields_for_save` 하나. `save()` → 이 헬퍼에서 unsaved related object 가드와 pk 재동기화 로직을 본다. hints_text가 라인까지 지목하므로 거의 단서가 떨어져 있는 수준.
- 함정/난이도: 단일 파일 한 줄이지만, "왜 numeric은 되고 string은 안 되나"의 비대칭을 이해하지 못하면 엉뚱하게 디스크립터(`ForwardManyToOneDescriptor`)나 할당 시점 캐싱을 건드리려 헤맬 수 있다. 진짜 결함은 빈 값 판정 기준이 `is None`에 박혀 있다는 점 하나.
- 우리 에이전트 관점: 막힐 지점은 (1) `empty_values`라는 기존 필드 속성을 떠올리느냐 — 모르면 `== ''` 하드코딩 같은 좁은 임시방편으로 빠질 수 있음(빈 list/tuple pk 등 누락). (2) None과 ""을 모두 커버하는 정석은 `field.empty_values` 재사용임을 아는 것이 SOTA 픽스와의 차이를 가른다.
