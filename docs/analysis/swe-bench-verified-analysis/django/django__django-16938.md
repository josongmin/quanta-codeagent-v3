---
instance_id: django__django-16938
repo: django/django
base_commit: 1136aa5005f0ae70fea12796b7e37d6f027b9263
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-06-03T11:18:11Z
fail_to_pass: 23
pass_to_pass: 65
gold_files: [django/core/serializers/python.py, django/core/serializers/xml_serializer.py]
---

# django__django-16938

## 문제 요약
m2m 관련 모델이 `select_related()`를 거는 커스텀 매니저를 기본 매니저로 쓰면, 객체 직렬화 시 `FieldError: Field cannot be both deferred and traversed using select_related at the same time` 예외가 터진다. 직렬화기는 m2m 대상에서 PK만 필요하므로 `.only("pk")`로 다른 필드를 defer하는데, 매니저가 자동으로 건 `select_related("master")`가 그 defer된 FK를 타고 들어가려다 충돌한다. 사용자는 단순히 m2m 직렬화가 성공하길 기대했다.

## 유형 분류
- 버그 카테고리: regression (성능 최적화 #33937 = commit 19e0587 이후 발생) / edge-case
- 서브시스템: django serializers (core/serializers) + ORM query (only/select_related 상호작용)
- 증상 타입: 예외 (FieldError) — 직렬화 크래시
- 로컬라이제이션 신호: 스택트레이스가 정확히 `django/core/serializers/python.py:88` (`handle_m2m_field` → `queryset_iterator` → `.only("pk").iterator()`)를 가리킨다. 에러 메시지의 "deferred and traversed using select_related"가 `.only()`와 매니저의 `select_related()`가 한 쿼리에 공존한다는 직접 단서.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/core/serializers/python.py` : `Serializer.handle_m2m_field` 내부 `queryset_iterator`
  - `django/core/serializers/xml_serializer.py` : `Serializer.handle_m2m` 내부 `queryset_iterator`
- 근본 원인: m2m 대상 RelatedManager가 기본 매니저의 `get_queryset()`을 상속받아 `select_related(...)`를 자동 적용한다. 직렬화기는 PK만 필요해서 `.only("pk")`로 나머지를 defer하는데, `select_related`가 defer된 FK를 다시 traverse하려다 `select_related_descend`(query_utils.py)에서 FieldError를 던진다.
- 수정 요지: `queryset_iterator`에서 `.only("pk")` 앞에 인자 없는 `.select_related()`를 체이닝해, 매니저가 걸어둔 기존 select_related를 전부 clear한 뒤 PK만 가져오게 한다. 즉 `getattr(obj, field.name).only("pk").iterator()` → `getattr(obj, field.name).select_related().only("pk").iterator()`. 이로써 deferred 필드를 traverse하지 않아 충돌이 사라진다. python/xml 두 직렬화기 모두 동일하게 패치.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `tests/serializers/models/base.py`에 `select_related("category")`를 거는 `TopicManager`와 그를 기본 매니저로 쓰는 `Topic` 모델, 그리고 `Article.topics = ManyToManyField(Topic)`를 추가. 즉 버그를 재현하는 모델 구성을 fixture에 박는다.
- 테스트가 픽스를 증명하는 방식:
  - `test_serialize_prefetch_related_m2m` / `test_serialize_only_pk` / `test_serialize_no_only_pk_with_natural_keys` 등 전 포맷(json/jsonl/xml/yaml)에서 `topics` m2m을 포함해 직렬화하면 — 픽스 전에는 FieldError로 크래시, 픽스 후 정상 동작.
  - `test_serialize_only_pk`는 `ctx[3]["sql"]`에 `category_id`가 **없음**을 단언 → `select_related().only("pk")`가 실제로 category FK를 안 끌어옴을 증명.
  - assertNumQueries 카운트를 3→4, 5→7 등으로 올려, topics m2m이 추가 쿼리 1개씩 발생하되 PK-only 쿼리로 정상 수행됨을 고정.

## 공략 포인트 (뭘 조져야)
- localization 전략: 스택트레이스가 정확히 `serializers/python.py`의 m2m 핸들러를 짚으므로 진입점은 명확. `.only("pk")` 라인이 핵심. 같은 패턴이 `xml_serializer.py`에도 있으니 grep으로 `only("pk").iterator()`를 찾아 두 곳 모두 고쳐야 한다.
- 함정/난이도 메모: 멀티파일(python + xml 두 직렬화기) — 한쪽만 고치면 xml 포맷 FAIL_TO_PASS가 남는다. 또 직관적으로 "select_related를 제거"라고 생각하지만, 실제 해법은 `.select_related()` (인자 없이)를 **추가**해서 매니저의 것을 reset하는 것. json/jsonl/yaml은 내부적으로 python 직렬화기를 공유하므로 python.py 한 번 고치면 세 포맷이 같이 통과.
- 우리 에이전트 관점: 막힐 지점은 (1) "에러를 없애려면 select_related를 빼야 한다"는 오답으로 빠지기 쉬움 — 인자 없는 `select_related()`가 clear 의미라는 ORM 지식 필요, (2) xml_serializer.py의 동일 패턴을 놓쳐 부분 통과에 그칠 위험, (3) fixture 모델/테스트는 골드가 추가했으므로, 에이전트가 자체 재현 테스트를 만들 때 커스텀 매니저+select_related 조합을 정확히 구성해야 함.
