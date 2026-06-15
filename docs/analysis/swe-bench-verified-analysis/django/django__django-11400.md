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
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-11400

## 문제 요약
admin 의 `RelatedFieldListFilter` 가 list filter 항목을 정렬할 때 관련 모델의 `Meta.ordering` 으로 폴백하지 않는다. 관련 모델의 ModelAdmin 에 `ordering` 이 명시되지 않으면 정렬이 빈 튜플(`()`)로 남아 정렬되지 않은 채 표시된다. 또한 `RelatedOnlyFieldListFilter` 는 ModelAdmin 에 ordering 이 있어도 아예 정렬을 적용하지 않는데, `field.get_choices` 호출에서 `ordering` kwarg 자체를 누락하기 때문이다. 사용자는 #29835 이전처럼 모델 기본 정렬 순서대로 필터 항목이 나오기를 기대한다(릴리스 블로커 회귀로 분류됨). 픽스는 admin 필터 2곳 + ORM `get_choices` 2곳에 걸쳐 조율돼야 한다.

## 유형 (정형화)
- **L (Localization) = L3 (Multi-site).** problem_statement 가 `filters.py#L196`(ordering 빈 튜플 set)과 `#L422`(get_choices 호출에서 ordering 누락)을 라인 번호로 직접 지목해 admin 진입점은 L0급으로 명백하다. 그러나 올바른 픽스는 거기서 끝나지 않고 `Field.get_choices`(`fields/__init__.py`)와 `ForeignObjectRel.get_choices`(`reverse_related.py`)의 빈 `order_by` 가드까지 **함께** 바뀌어야 한다 → 3파일 조율. 진짜 어려움이 "두 번째·세 번째 수정 지점이 어디인지"에 있어 L3.
- **S (Repair Strategy) = S6 (+S2).** 단순 가드 한 줄이 아니라 작은 구조 변경이다: admin 쪽은 공용 헬퍼 `field_admin_ordering` 을 **추출**해 두 `field_choices` 가 공유하게 하고(S6), ORM 쪽은 `qs` 를 먼저 구성한 뒤 `if ordering:` 일 때만 `order_by` 를 적용하는 collect-then-process 재배치(S6)다. 여기에 "빈 ordering 이 곧 무정렬이 아니라 모델 기본 정렬 보존을 의미한다"는 불변식을 추론으로 맞춰야 하므로 S2 보조. 후보를 여러 개 던져 테스트로 거르는 G&V 가 아니라, 도메인 불변식을 따져 한 번에 일관되게 고치는 성격.
- **K (Knowledge) = K-Domain.** `_default_manager` / `complex_filter` / `get_choices` / `ForeignObjectRel` / `Meta.ordering` 이 빈 `order_by()` 에 의해 무효화된다는 django ORM·admin 내부 동작 지식이 병목. 일반 파이썬 추론만으로는 "admin 한 줄"에서 멈춘다.
- **primary_type = T-DiffuseLoc.** 픽스 식 자체는 어렵지 않다(가드 추가 + ordering 전달). 본질적 난점은 admin 라인 번호가 주어졌음에도 **수정이 ORM 레이어 2파일로 번지고 그 2번째 진입점을 스스로 찾아야** 한다는 점 — L3 multi-site 가 dominant 하므로 T-DiffuseLoc. (T-DesignRefactor 후보였으나, refactor 규모는 작고 진짜 병목은 localization 확산이라 T-DiffuseLoc 채택.)

## 난이도 티어
**Tier = T5 (어려움).** 공식 라벨은 `1-4 hours` (≈T4)이나 한 단계 위로 본다.
- **이 티어로 미는 구조적 피처:** (1) **L3 멀티파일 조율** — gold patch 가 3파일(admin filters + fields/__init__ + reverse_related)에 걸쳐 함께 바뀌어야 하고, ICLR 2024 컷에서 ≥3파일은 solve <10% 구간. (2) **regression-trap** — PASS_TO_PASS 58건, 그 중 `test_get_choices`, `test_get_choices_reverse_related_field`, `test_relatedfieldlistfilter_foreignkey_ordering_reverse`, `RelatedFieldListFilter ordering respects ModelAdmin.ordering.` 등 **명시적 ordering 이 주어진 경로**를 깨면 안 됨 → `if ordering:` 가드가 명시 ordering 케이스를 그대로 보존해야 함. (3) **cross-file-dep** — admin 의 빈 `()` 가 ORM 의 빈 `order_by()` 와 의미적으로 결합돼 있어, 한쪽만 고치면 다른 쪽이 무효화. (4) **K-Domain** — 빈 ordering 이 Meta.ordering 을 죽인다는 비자명한 ORM 동작.
- **공식 라벨과 다른 이유:** `1-4 hours` 는 패치를 이미 이해한 개발자의 구현 시간(실제 diff 는 작음)을 반영한다. 그러나 에이전트 난이도는 *localize 확산*에서 온다 — admin 라인 번호만 보고 그 한 파일을 고친 뒤 멈추기 쉽고(아래 함정), 시간 라벨은 이 "두 번째 진입점을 못 찾는" 비용을 잡지 못한다. has-repro(샘플 프로젝트/스크린샷) 신호는 난이도를 낮추지만 멀티파일·regression-trap 이 그것을 상쇄.

## 골드패치 분석
- **건드린 파일/함수:**
  - `django/contrib/admin/filters.py`: 신규 `RelatedFieldListFilter.field_admin_ordering`, 수정 `RelatedFieldListFilter.field_choices`, 수정 `RelatedOnlyFieldListFilter.field_choices`
  - `django/db/models/fields/__init__.py`: `Field.get_choices`
  - `django/db/models/fields/reverse_related.py`: `ForeignObjectRel.get_choices`
- **근본 원인:** `field_choices` 가 related ModelAdmin 의 ordering 만 보고, 비어있으면 `()` 로 둔 채 `get_choices` 에 넘겼다. 그런데 `Field.get_choices` / `ForeignObjectRel.get_choices` 는 ordering 이 비어도 **무조건** `.order_by(*ordering)` 를 호출했다 — 빈 `order_by()` 는 매니저 쿼리셋의 `Meta.ordering` 을 명시적으로 무효화하므로, 모델 기본 정렬 폴백이 원천 차단됐다. 또 `RelatedOnlyFieldListFilter.field_choices` 는 `ordering` kwarg 를 아예 전달하지 않아 ModelAdmin.ordering 조차 적용되지 않았다.
- **수정 요지:**
  - 공용 헬퍼 `field_admin_ordering(field, request, model_admin)` 추출 — related admin 이 등록돼 있으면 `related_admin.get_ordering(request)`, 없으면 `()` 반환.
  - `RelatedFieldListFilter.field_choices` 와 `RelatedOnlyFieldListFilter.field_choices` 둘 다 이 헬퍼로 ordering 을 구해 `get_choices(..., ordering=ordering)` 로 전달(후자는 `limit_choices_to` 경로에 빠져있던 ordering kwarg 추가).
  - `Field.get_choices` 와 `ForeignObjectRel.get_choices` 를 collect-then-process 로 재배치: `qs` 를 먼저 만들고 `if ordering: qs = qs.order_by(*ordering)` — ordering 이 비면 매니저 기본 쿼리셋(=Meta.ordering)이 살아남는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (6건) 가 체크하는 동작:**
  - `test_get_choices_default_ordering` (model_fields): ordering 인자 없이 `Field.get_choices` 호출 시 `Foo._meta.ordering=('d',)` 가 적용되는지.
  - `test_get_choices_reverse_related_field_default_ordering` (model_fields): 역방향 `ForeignObjectRel.get_choices` 가 `Bar._meta.ordering=('b',)` 폴백을 적용하는지.
  - `RelatedFieldListFilter ordering respects Model.ordering.` (`test_relatedfieldlistfilter_foreignkey_default_ordering`): ModelAdmin ordering 없이 `Employee._meta.ordering=('name',)` 만으로 필터 정렬.
  - `test_relatedfieldlistfilter_reverse_relationships_default_ordering`: 역방향 관계에서 `Book._meta.ordering=('title',)` 폴백.
  - `RelatedOnlyFieldListFilter ordering respects Meta.ordering.` / `... respects ModelAdmin.ordering.`: RelatedOnly 필터가 Meta.ordering / ModelAdmin.ordering 을 존중.
- **픽스 증명:** 예컨대 `Employee._meta.ordering=('name',)` 로 두고 `BookAdmin(list_filter=('employee',))` changelist 에서 `filterspec.lookup_choices` 를 읽어 이름순 `[(jack,'Jack Red'),(john,'John Blue')]` 를 assert. 픽스 전엔 ordering=`()` → 빈 `order_by()` 가 Meta.ordering 을 덮어써 PK/임의 순서로 나와 실패. 결정적으로 test_patch 의 `setUpTestData` 가 `d='12.34'→'12.35'`, `b='a'→'b'` 로 바뀌어 **정렬 기준 컬럼 순서가 PK 순과 갈라지게** 만든다 — 폴백이 진짜 동작하는지(우연히 PK 순과 일치해 통과하는 게 아닌지)를 구별하는 강한 테스트.
- **overfit / regression 관점:** FAIL_TO_PASS 가 정방향/역방향 × admin/ORM 양 레이어를 교차 커버해 special-case 픽스로는 6건 다 못 통과 → overfit 위험 낮음(S4/CEGIS 아님). regression 측면에선 PASS_TO_PASS 의 명시 ordering 경로(`test_get_choices`, `..._ordering_reverse`, `... respects ModelAdmin.ordering.`)가 `if ordering:` 분기에서 그대로 보존돼야 함 — admin/ORM 어느 쪽을 잘못 고치면 즉시 P2P 가 깨지는 trap.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement 가 라인 번호(`filters.py#L196`, `#L422`)와 두 클래스명(`RelatedFieldListFilter`, `RelatedOnlyFieldListFilter`)을 직접 준다 → `admin/filters.py` 의 두 `field_choices` 가 1차 타깃. 여기서 멈추지 말고 `field.get_choices` 의 호출체인을 따라 `Field.get_choices`(`fields/__init__.py`)와 그 역방향 형제 `ForeignObjectRel.get_choices`(`reverse_related.py`)까지 내려가 `.order_by(*ordering)` 가 무조건 호출됨을 확인 — 이게 폴백을 막는 ORM 레벨 근본 원인.
2. **픽스와 올바른 일반화:** (a) admin 에서 ModelAdmin ordering 을 구하되 비면 `()` 를 넘기고, (b) ORM `get_choices` 두 곳에서 `if ordering:` 일 때만 `order_by` 적용. 이게 올바른 일반화인 이유: "빈 ordering = 무정렬"이 아니라 "빈 ordering = 모델 기본 정렬에 위임"이라는 의도를 ORM 레벨 한 곳에서 일관되게 표현하므로, 정방향/역방향/RelatedOnly 모든 경로가 자동으로 폴백을 얻는다. admin 에서 `or related_model._meta.ordering` 로 우회하는 핫픽스는 model_fields 의 ORM 직접 호출 테스트 2건을 못 잡으므로 일반화가 아님.
3. **regression 안전:** `if ordering:` 가드가 명시 ordering 케이스(`get_choices(ordering=('a',))`, ModelAdmin.ordering 지정)를 그대로 `order_by` 로 흘려보내야 함 — `test_get_choices`, `test_get_choices_reverse_related_field`, `..._ordering_reverse`, `RelatedFieldListFilter ordering respects ModelAdmin.ordering.` 등 P2P 가 이를 지킴. 빈 ordering 만 분기로 빠지고 비어있지 않으면 기존 동작 동일.
4. **함정 회피:** 오라클 없는 에이전트의 전형 실패는 **admin 한 파일에서 멈추기** — `ordering = related_admin.get_ordering(...) or related_model._meta.ordering` 식으로 admin 에서 Meta.ordering 을 직접 끌어와 넣는 것. 이러면 admin 테스트 일부는 통과하나 (i) `get_choices` 의 빈 `order_by()` 가 여전히 명시 빈 ordering 을 덮어쓰는 ORM 케이스(model_fields FAIL_TO_PASS 2건)를 못 잡고, (ii) `RelatedOnlyFieldListFilter` 의 `limit_choices_to` 별도 경로에 ordering kwarg 를 안 넣어 RelatedOnly 2건 실패. 회피법: 증상이 admin 에 보여도 **수정은 가장 깊은 공통 지점(ORM `get_choices`)에서** 하고, 정방향/역방향/RelatedOnly 세 호출 경로를 모두 같은 가드로 통일.
