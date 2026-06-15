---
instance_id: django__django-11400
repo: django/django
base_commit: 1f8382d34d54061eddc41df6994e20ee38c60907
version: 3.0
difficulty: 1-4 hours
created_at: 2019-05-22T11:30:39Z
fail_to_pass: 6
pass_to_pass: 58
gold_files: [django/contrib/admin/filters.py, django/db/models/fields/__init__.py, django/db/models/fields/reverse_related.py]
---

# django__django-11400

## 문제 요약
admin 의 `RelatedFieldListFilter` 가 list filter 항목을 정렬할 때 관련 모델의 `Meta.ordering` 으로 폴백하지 않는다. 관련 모델의 ModelAdmin 에 `ordering` 이 명시되지 않으면 정렬이 빈 튜플(`()`)로 남아 정렬되지 않은 채 표시된다. 또한 `RelatedOnlyFieldListFilter` 는 ModelAdmin 에 ordering 이 있어도 아예 정렬을 적용하지 않는데, `field.get_choices` 호출에서 `ordering` kwarg 자체를 누락하기 때문이다. 사용자는 #29835 이전처럼 모델 기본 정렬 순서대로 필터 항목이 나오기를 기대한다(회귀로 분류됨).

## 유형 분류
- 버그 카테고리: 누락처리 / regression (Meta.ordering 폴백 누락 + ordering kwarg 누락)
- 서브시스템: django.contrib.admin list filters + ORM Field.get_choices
- 증상 타입: silent-wrong (정렬이 안 된 채 잘못된 순서로 출력)
- 로컬라이제이션 신호: problem_statement 가 `filters.py#L196`(ordering 빈 튜플 set)과 `#L422`(get_choices 호출에서 ordering 누락)을 직접 라인 번호로 지목 → 정확히 `RelatedFieldListFilter.field_choices` / `RelatedOnlyFieldListFilter.field_choices` 로 연결.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/contrib/admin/filters.py`: `RelatedFieldListFilter.field_choices`, 신규 `field_admin_ordering`, `RelatedOnlyFieldListFilter.field_choices`
  - `django/db/models/fields/__init__.py`: `Field.get_choices`
  - `django/db/models/fields/reverse_related.py`: `ForeignObjectRel.get_choices`
- 근본 원인: `field_choices` 가 ModelAdmin 의 ordering 만 보고, 비어있으면 `()` 로 둔 채 그대로 `get_choices` 에 넘겨 모델의 `Meta.ordering` 폴백이 일어나지 않았다. `RelatedOnlyFieldListFilter` 는 ordering 인자 자체를 주지 않았다. 게다가 `get_choices` 들은 `ordering` 이 비어도 무조건 `.order_by(*ordering)` 를 호출해, 빈 ordering 이 모델 기본 정렬을 덮어써(빈 order_by 가 Meta.ordering 무효화) 폴백을 막았다.
- 수정 요지:
  - 공용 헬퍼 `field_admin_ordering` 추출 — related ModelAdmin 이 등록돼 있으면 `get_ordering(request)`, 없으면 `()` 반환.
  - `RelatedFieldListFilter.field_choices` 와 `RelatedOnlyFieldListFilter.field_choices` 둘 다 이 헬퍼로 ordering 을 구해 `get_choices(..., ordering=ordering)` 로 전달(후자는 기존에 빠져있던 kwarg 추가).
  - `Field.get_choices` 와 `ForeignObjectRel.get_choices` 에서 `if ordering:` 일 때만 `.order_by(*ordering)` 적용 → ordering 이 비면 매니저 기본 쿼리셋(=Meta.ordering)이 살아남도록 변경.

## 검증 (test_patch)
- FAIL_TO_PASS 가 체크하는 동작:
  - `test_get_choices_default_ordering`, `test_get_choices_reverse_related_field_default_ordering`: ordering 인자 없이 호출 시 `Foo._meta.ordering` / `Bar._meta.ordering` 가 적용되는지.
  - `test_relatedfieldlistfilter_foreignkey_default_ordering`, `test_relatedfieldlistfilter_reverse_relationships_default_ordering`: ModelAdmin ordering 없이 Meta.ordering 만으로 필터 정렬.
  - `test_relatedonlyfieldlistfilter_foreignkey_ordering` / `_default_ordering`: RelatedOnly 필터가 ModelAdmin.ordering / Meta.ordering 을 존중.
- 증명 방식: 예컨대 `Employee._meta.ordering = ('name',)` 로 두고 `BookAdmin(list_filter=('employee',))` 의 changelist 에서 `filterspec.lookup_choices` 를 읽어, 이름순 `[(jack,'Jack Red'),(john,'John Blue')]` 가 나오는지 assert. 픽스 전엔 ordering=`()` 라 빈 order_by 가 Meta.ordering 을 덮어써 PK/임의 순서로 나와 실패. `model_fields/tests.py` 의 setUpTestData 도 `d='12.34'→'12.35'`, `b='a'→'b'` 로 바꿔 정렬 기준이 PK 순과 갈라지게 만들어 폴백을 진짜로 구별.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement 가 라인 번호까지 줘서 `admin/filters.py` 의 두 `field_choices` 가 1차 타깃. 하지만 거기만 고치면 안 되고, 빈 ordering 이 Meta.ordering 을 무효화하던 `get_choices` 쪽(`fields/__init__.py`, `reverse_related.py`)의 `order_by` 가드까지 함께 손봐야 한다.
- 함정/난이도: (1) 멀티파일(3파일) — admin 레이어만 고치면 `RelatedFieldListFilter` 의 Meta.ordering 폴백은 여전히 빈 `order_by` 에 막힘. (2) `RelatedOnly` 는 `limit_choices_to` 를 쓰는 별도 경로라 ordering kwarg 를 따로 추가해야 함. (3) `Field.get_choices` 와 `ForeignObjectRel.get_choices` 는 시그니처가 비슷하지만 다른 파일/다른 매니저 호출이라 둘 다 동일 가드 필요.
- 우리 에이전트 관점: admin 한 파일에서 ordering 폴백만 추가하고 멈추기 쉽다(`ordering = related_admin.get_ordering(...) or related_model._meta.ordering` 같은 식). 그러면 admin 테스트 일부는 통과해도 `model_fields` 의 FAIL_TO_PASS 2건과 빈 order_by 덮어쓰기 케이스가 미해결로 남는다. "빈 ordering 이 모델 기본 정렬을 죽인다"는 ORM 레벨 근본 원인을 잡아야 전부 green.
