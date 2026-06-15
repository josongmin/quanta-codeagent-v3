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
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-16938

## 문제 요약
m2m 대상 모델이 `select_related()`를 거는 커스텀 매니저를 **기본 매니저**로 쓰면, 객체 직렬화 시 `FieldError: Field cannot be both deferred and traversed using select_related at the same time` 예외가 터진다. 직렬화기는 m2m 대상에서 PK만 필요하므로 `.only("pk")`로 다른 필드를 defer하는데, RelatedManager가 기본 매니저로부터 상속한 `select_related("master")`가 그 defer된 FK를 다시 traverse하려다 충돌한다. 성능 최적화 #33937(commit 19e0587) 이후 발생한 회귀이며, 사용자는 단순히 m2m 직렬화가 성공하길 기대했다. 이슈에 완전한 재현 스니펫(모델 3개 + serialize 호출)과 네이티브 스택트레이스가 모두 포함돼 있다.

## 유형 (정형화)

**L = L3 (Multi-site).** 스택트레이스가 `serializers/python.py:88`의 `queryset_iterator`를 단일 지점으로 정확히 짚지만, 동일 패턴(`.only("pk").iterator()`)이 `xml_serializer.py`의 `handle_m2m`에도 독립적으로 존재해 **두 파일이 함께** 같은 방식으로 바뀌어야 한다(한쪽만 고치면 xml 포맷 F2P가 남음). 진입점 발견 자체는 L0급으로 쉬우나, "수정이 ≥2 파일에 조율되어 걸쳐야 한다"는 L3 정의에 정확히 해당.

**S = S2 Constraint-Reasoning (+S1).** 고칠 줄은 자명하나(`.only("pk")` 라인), 올바른 식은 추론으로 합성해야 한다. 직관적 오답은 "에러를 없애려면 select_related를 빼야 한다"인데, m2m 대상 queryset에는 사용자가 select_related를 명시적으로 건 적이 없다(매니저가 자동 적용). 정답은 인자 없는 `.select_related()`를 **추가**해서 매니저가 걸어둔 기존 select_related를 전부 clear하는 것 — 이 ORM 불변식("select_related() with no args resets prior select_related")을 알아야 식이 나온다. 일단 그 의미를 알면 적용은 기계적(S1)이라 보조로 표기.

**K = K-Domain.** django ORM의 `only()`(deferred loading) ↔ `select_related()`(JOIN traversal) 상호작용, `select_related_descend`의 deferred-vs-traversed 충돌 규칙, RelatedManager가 base manager의 `get_queryset()`을 상속한다는 내부 동작 — 전부 프레임워크 내부지식. 일반 파이썬 추론으로는 도출 불가.

**Primary = T-DomainBound.** 진짜 병목은 위치 찾기(쉬움)도 멀티파일 조율(기계적 미러)도 아니고, "왜 select_related가 자동으로 끼어들었고, 인자 없는 select_related()가 그걸 reset한다"는 **ORM 도메인 지식**이다. K-Domain이 dominant이므로 L3·S2보다 T-DomainBound가 라벨을 지배.

## 난이도 티어
**T4 (약간 어려움).** 미는 피처: (1) K-Domain이 dominant — ORM deferred/select_related 상호작용 지식이 픽스의 병목(루브릭 T4의 "K-Domain 중 하나" 조건 충족). (2) L3 cross-file 조율 — python.py + xml_serializer.py 두 직렬화기를 함께 고쳐야 함. (3) **regression-trap이 넓음** — P2P 65개 + F2P 23개가 4개 포맷(json/jsonl/xml/yaml) × 다수 직렬화 동작을 커버하므로, 잘못 고치면 PK-only 최적화(#33937)나 다른 m2m 동작을 깨기 쉽다. 특히 `assertNumQueries` 카운트가 fixture 변경에 맞물려 있어 부주의한 수정이 쿼리 수를 틀어뜨림.

내림 요인: has-repro(이슈에 완전 재현 + 네이티브 스택트레이스, 가장 강한 easiness 신호)와 픽스가 양쪽 합쳐 2줄이라는 점이 T5로 가는 걸 막는다. 공식 라벨 "15분-1시간"과 정합적 — 다만 공식 라벨은 "개발자 구현시간"이라 멀티파일 미러와 "select_related를 빼는 게 아니라 추가"라는 반직관 함정은 잡지 못한다. 에이전트 관점에선 오답 분기 위험 때문에 T4가 적절(T3로 내리지 않음).

## 골드패치 분석
- **건드린 파일/함수:**
  - `django/core/serializers/python.py` : `Serializer.handle_m2m_field` 내부 `queryset_iterator`
  - `django/core/serializers/xml_serializer.py` : `Serializer.handle_m2m` 내부 `queryset_iterator`
- **근본 원인:** m2m 대상의 RelatedManager가 기본 매니저(`TestTagManager`/테스트의 `TopicManager`)의 `get_queryset()`을 상속받아 `select_related("master"/"category")`를 자동 적용한다. 직렬화기는 PK만 필요해 `.only("pk")`로 나머지를 defer하는데, deferred FK를 select_related가 다시 traverse하려다 `django/db/models/query_utils.py`의 `select_related_descend`가 `FieldError`를 던진다. 이 충돌은 PK-only 최적화 #33937(deferred loading 도입) 이후 생긴 회귀.
- **수정 요지:** `queryset_iterator`에서 `.only("pk")` 앞에 **인자 없는** `.select_related()`를 체이닝 — `getattr(obj, field.name).only("pk").iterator()` → `getattr(obj, field.name).select_related().only("pk").iterator()`. 인자 없는 `select_related()`는 누적된 모든 select_related를 clear하므로, defer된 FK를 traverse하지 않아 충돌이 사라진다. python/xml 두 직렬화기에 동일 미러 적용(json/jsonl/yaml은 python 직렬화기를 공유하므로 python.py 하나로 세 포맷 커버).

## 검증 (test_patch)
- **FAIL_TO_PASS 동작 (23개):** `tests/serializers/models/base.py`에 `select_related("category")`를 거는 `TopicManager`와 그를 `objects`로 쓰는 `Topic` 모델, 그리고 `Article.topics = ManyToManyField(Topic)`를 추가 — 버그를 재현하는 모델 구성을 fixture에 박는다. 그 위에서 json/jsonl/xml/yaml 4포맷의 직렬화 기본 동작(`Basic serialization works.`, `Serialized content can be deserialized.` 등)과 `test_serialize_prefetch_related_m2m` / `test_serialize_only_pk` / `test_serialize_no_only_pk_with_natural_keys` / `test_serialize_progressbar`가 모두 픽스 대상. 픽스 전에는 `topics` m2m 직렬화가 FieldError로 크래시 → fixture를 공유하는 테스트가 광범위하게 동반 실패하므로 F2P가 23개로 커진다.
- **픽스 증명:**
  - `test_serialize_only_pk`는 `ctx[3]["sql"]`(= topics m2m 쿼리)에 `category_id`가 **없음**을 단언 → `select_related().only("pk")`가 실제로 category FK를 JOIN/select하지 않음을 증명. `select_related`를 단순히 제거만 해도 통과할 수 있지만, fixture의 `TopicManager`가 항상 select_related를 다시 거므로 reset 의미의 픽스가 강제된다.
  - `assertNumQueries` 카운트를 3→4, 5→7로 올려 topics m2m이 추가 쿼리 1개씩(PK-only)으로 정상 수행됨을 고정. 쿼리 수를 깨면 즉시 실패.
- **overfit·regression 관점:** F2P가 4포맷 × 여러 동작으로 두껍고, `ctx[3]["sql"]`에 컬럼이 없음을 직접 검사하므로 special-case 통과(예: try/except로 FieldError를 삼키는 식)가 막힌다 → overfit-risk 낮음. 다만 P2P 65개(기존 m2m·FK·deferred·proxy 직렬화 전반)와 `assertNumQueries` 고정이 넓어 regression-trap이 본 문제의 핵심 위험축이다.

## 모범답안 (오라클 기반)
1. **Localize 경로:** 이슈의 네이티브 스택트레이스가 `serializers/python.py:88 → handle_m2m_field → m2m_iter → query.py:_iterator → select_related_descend`를 끝까지 보여준다. 에러 메시지 "deferred and traversed using select_related"가 `.only()`(deferred)와 매니저의 `select_related()`가 한 쿼리에 공존한다는 직접 단서. python.py의 `queryset_iterator`로 직행한 뒤, **반드시** `rg 'only\("pk"\).iterator'`로 동일 패턴을 grep해 `xml_serializer.py`의 쌍둥이 라인을 같이 잡는다(L3 인식).
2. **픽스와 올바른 일반화:** `.only("pk")` 앞에 인자 없는 `.select_related()`를 추가. 이게 올바른 일반화인 이유 — 문제는 "이 특정 매니저가 master를 select_related한 것"이 아니라 "직렬화기가 받는 m2m queryset에 임의의 select_related가 매니저로부터 묻어올 수 있다"는 일반 조건이다. 인자 없는 select_related()는 그 출처와 무관하게 누적 select_related를 모두 reset하므로, 어떤 커스텀 매니저 조합에도 견딘다. (반대로 fixture 모델만 보고 `select_related("master")`를 콕 집어 제거하는 식은 overfit.)
3. **Regression 안전:** P2P 65개 — 기존 FK 직렬화 superfluous-query 억제, deferred_field_serialization, proxy/inherited/specific-fields 직렬화, 4포맷 roundtrip을 안 깨야 한다. select_related() reset은 m2m PK-only 경로에만 작용하고 `only("pk")`로 PK만 가져오는 #33937 최적화를 보존하므로 인접 동작에 무해. `assertNumQueries` 카운트(기존 3/5 → 4/7)는 topics fixture 추가분만 반영 — PK-only 쿼리 수 자체는 유지돼야 한다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) "에러 메시지가 select_related라니 select_related를 빼자"는 1차 반응으로, m2m queryset에는 명시적 select_related가 없어 뺄 대상을 못 찾고 헤맴 → 인자 없는 select_related()가 **reset** 연산이라는 ORM 지식으로 돌파. (b) python.py만 고치고 xml_serializer.py를 놓쳐 xml F2P가 부분 실패 → 패턴 grep으로 미러 강제. (c) 자체 재현 테스트를 만들 때 "커스텀 매니저가 기본 매니저(`objects`)여야 RelatedManager가 그 get_queryset을 쓴다"는 조건을 빠뜨리면 버그가 재현되지 않아 픽스 검증을 못 함 → fixture의 `objects = TopicManager()` 배치가 핵심.
