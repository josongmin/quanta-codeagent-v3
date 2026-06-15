---
instance_id: django__django-11211
repo: django/django
base_commit: ba726067604ce5a8ca3919edf653496722b433ab
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-04-13T12:01:14Z
fail_to_pass: 1
pass_to_pass: 76
gold_files: [django/db/models/fields/__init__.py]
---

# django__django-11211

## 문제 요약
UUID를 PK로 쓰는 모델을 GenericForeignKey(GFK)로 가리킬 때 `prefetch_related()`가 동작하지 않고 해당 속성으로 `None`을 반환한다. 사용자는 일반 PK처럼 prefetch한 객체가 채워지길 기대했지만, GFK가 `object_id`(문자열로 저장됨)와 대상 모델의 UUID PK를 매칭하지 못해 빈 결과가 나온다. (이슈 보고 당시 메인테이너가 "GFK는 prefetch 미지원"이라 오답했으나 실제로는 UUIDField 한정 버그였다.)

## 유형 분류
- 버그 카테고리: edge-case (특정 필드 타입에서의 누락처리)
- 서브시스템: django ORM model fields / GenericForeignKey prefetch
- 증상 타입: silent-wrong (예외 없이 prefetch 결과가 None)
- 로컬라이제이션 신호: 증상이 "UUIDField를 PK로 쓸 때만" 발생 → GFK prefetch의 키 매칭 단계에서 UUID 값의 타입 변환 책임이 `UUIDField`에 있다는 점을 가리킨다. GFK는 `object_id`를 텍스트로 보관하므로, 매칭 시 prep 단계에서 UUID로 정규화돼야 한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` → `UUIDField.get_prep_value`
- 근본 원인: GFK prefetch는 `object_id`(문자열, 예: dash 없는 hex)를 대상 모델 PK로 in-query 매칭한다. 이때 lookup 값이 `get_prep_value`를 거치는데, `UUIDField`는 `get_prep_value`를 오버라이드하지 않아 `Field`의 기본 구현이 값을 UUID 정규형으로 바꾸지 않은 채 통과시켰다. 결과적으로 prefetch 캐시의 키(정규화된 UUID PK)와 lookup 키(원시 문자열)가 불일치해 매칭 실패 → None.
- 수정 요지: `UUIDField`에 `get_prep_value`를 추가해 `super().get_prep_value(value)` 후 `self.to_python(value)`로 값을 실제 `uuid.UUID`(또는 일관된 표현)로 변환하도록 했다. 이로써 prefetch가 비교하는 양쪽 키가 동일 정규형이 되어 매칭이 성립한다. 기존 `get_db_prep_value`는 그대로 두고, 더 상위의 prep 단계에서 정규화를 보장한 것이 핵심.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_prefetch_GFK_uuid_pk (prefetch_related.tests.GenericRelationTests)`
- 테스트 구성: `tests/prefetch_related/models.py`에 UUID PK를 가진 `Article` 모델 추가, `Comment`에 UUID용 GFK 쌍(`content_type_uuid`/`object_pk_uuid`/`content_object_uuid`) 추가(기존 content_type을 null 허용으로 완화).
- 증명 방식: `Article.objects.create(name='Django')`로 UUID PK 객체를 만들고 `Comment`에 GFK로 연결한 뒤 `Comment.objects.prefetch_related('content_object_uuid')`를 실행. `[c.content_object_uuid for c in qs] == [article]`을 단언한다. 픽스 전에는 `content_object_uuid`가 None이라 `[None] != [article]`로 실패, 픽스 후 UUID 정규화로 키가 매칭돼 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: "UUIDField + GFK + prefetch에서만 None"이라는 조건 교차에서 출발. GFK prefetch 매칭 경로(`GenericForeignKey.get_prefetch_queryset`)를 따라가면 결국 PK 비교에 lookup 값이 들어가고, 그 값의 정규화는 대상 필드(`UUIDField`)의 prep 메서드 책임임을 짚어야 한다. 수정 자체는 `UUIDField` 한 곳, 4줄.
- 함정/난이도: (1) 증상이 GFK·prefetch에서 나타나 그쪽 코드(contenttypes, prefetch_related.py)를 파고들기 쉽지만, 실제 root cause는 단일 필드 클래스의 prep 메서드 누락이다. (2) 이미 `get_db_prep_value`가 있어 "변환은 처리됨"으로 오판하기 쉬움 — db prep은 더 늦은 단계라 prefetch 키 매칭(파이썬 레벨 lookup prep)에는 적용되지 않는다. (3) 메인테이너가 "미지원"이라 답한 hints_text에 끌려가면 안 된다.
- 우리 에이전트 관점: 증상 표면(GFK/prefetch)과 수정 지점(UUIDField)이 멀어 localization에서 헤맬 위험이 큼. `get_prep_value` vs `get_db_prep_value`의 호출 시점 차이를 정확히 이해하지 못하면 잘못된 메서드를 고치거나 GFK 측에 우회 패치를 넣어 PASS_TO_PASS(76개)를 깨뜨릴 수 있다.
