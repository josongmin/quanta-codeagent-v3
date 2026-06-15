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
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep, underspecified]
---

# django__django-11211

## 문제 요약
UUID를 PK로 쓰는 모델을 `GenericForeignKey`(GFK)로 가리킬 때 `prefetch_related()`가 동작하지 않고 해당 속성으로 조용히 `None`을 반환한다. GFK는 참조 대상 PK를 `object_id` 컬럼에 **문자열**로 저장하는데, prefetch가 그 문자열을 가지고 대상 모델(UUID PK)을 in-query로 모아온 뒤 캐시 매칭을 할 때, 한쪽 키는 정규화된 `uuid.UUID`이고 다른 쪽은 원시 문자열이라 불일치해 매칭이 빈다. 예외가 없는 silent-wrong 결함. 이슈 보고 당시 메인테이너가 hints_text에서 "GFK는 prefetch 미지원"이라 오답 처리했으나, 실제로는 `UUIDField` 한정 prep 누락 버그였다.

## 유형 (정형화)

3축 점수:
- **L2 (Diffuse)** — 이슈는 증상(GFK + prefetch + UUID PK)만 제시하고 수정 지점을 직접 지목하지 않는다. 증상 표면은 `contenttypes`/`prefetch_related.py`/`GenericForeignKey.get_prefetch_queryset`인데, 실제 root cause는 전혀 다른 모듈인 `django/db/models/fields/__init__.py`의 `UUIDField`다. prefetch 키 비교 → lookup prep 책임 → 대상 필드 클래스로 이어지는 cross-module 데이터플로우를 역추적해야 도달한다. 단일 함수 한 방(grep)으로 안 잡히므로 L1이 아니라 L2.
- **S2 (Constraint-Reasoning) +S5 (Spec-Inference)** — 고칠 메커니즘을 알아내는 핵심은 "prefetch 매칭의 양쪽 키가 같은 정규형이어야 한다"는 불변식을 추론하는 것(S2). 또한 `get_prep_value`(파이썬 레벨 lookup prep)와 `get_db_prep_value`(DB 직전 단계)의 호출 시점·계약 차이를 Field API 관례에서 재구성해야 어느 메서드를 추가할지 결정된다(S5). 테스트를 난사해 수렴하는 G&V(S3)가 아니라, 타입 정규화 불변식을 "생각으로" 합성하는 문제다.
- **K-Domain** — django ORM 내부지식이 병목. Field의 prep 파이프라인(`get_prep_value` → `get_db_prep_value`), GFK가 PK를 텍스트로 보관한다는 점, prefetch의 캐시-키 매칭 메커니즘을 모르면 풀 수 없다. 일반 파이썬 추론(K-Gen)으로는 닿지 않는다.

primary type = **T-DomainBound**: 진짜 병목이 "어디인지 찾기"(L2)에 일부 있지만, 그 localize와 픽스 설계를 모두 ORM Field prep 도메인지식이 지배한다. localize 어려움 자체가 도메인지식(GFK가 object_id를 문자열로 들고 있고, lookup 정규화는 대상 필드 책임)에서 풀린다는 점에서 T-DiffuseLoc보다 T-DomainBound가 dominant.

왜 이 repair strategy인가 (APR 관점): 픽스는 단 4줄이지만 GenProg/Astor식 mutate-and-test로는 도달 불가능하다. "`super().get_prep_value(value)` 결과를 `self.to_python(value)`로 한 번 더 통과시킨다"는 변환은 후보공간에서 우연히 나올 표현이 아니라, Field 정규화 계약(SemFix/Angelix식 의미합성)을 따져 도출되는 단일 정답이다. 그래서 S2가 dominant이고, 어느 메서드 슬롯에 넣을지를 API 관례에서 읽어내는 S5가 보조.

## 난이도 티어

**T4 (약간 어려움)**. 공식 difficulty 라벨은 `15 min - 1 hour`(개발자 구현시간 기준)으로 T2~T3에 해당하지만, 에이전트 난이도로는 한 단계 올려 T4로 잡는다. 이 라벨은 "골드패치를 아는 개발자의 타이핑 시간"이라 localize 비용과 오답 함정을 반영하지 못한다.

이 티어로 미는 구조적 피처:
- **L2 diffuse localize** — 증상(GFK/prefetch)과 수정 지점(`UUIDField`)이 모듈 단위로 멀다. 에이전트가 표면을 따라 `prefetch_related.py`/`contenttypes`를 파면 잘못된 곳을 고치게 된다. file-level localize가 repair 결과를 지배한다는 실증(2604.05481)상 이게 최대 난점.
- **K-Domain 병목** — `get_prep_value` vs `get_db_prep_value`의 호출 시점 차이라는 깊은 ORM 지식이 정답의 전제. 실패의 ~25%가 지식결함(2509.13941)인 전형.
- **넓은 P2P trap** — PASS_TO_PASS 76개가 전부 `prefetch_related` 스위트(특히 GFK·m2m·nullable 경로). UUIDField나 GFK prep을 잘못 건드리면 인접 동작이 광범위하게 깨질 수 있는 regression-trap.

T5로 안 올리는 이유: 수정 자체는 단일 파일·단일 메서드·4줄, 멀티헌크 조율(L3)이 아니고 overfit 고위험(S4)도 아니다. T3에 안 머무는 이유: 단일파일 가벼운 추론이 아니라 cross-module 추적 + 도메인지식이 동시에 걸린다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` → `UUIDField`에 `get_prep_value` 신규 추가(4줄).
  ```python
  def get_prep_value(self, value):
      value = super().get_prep_value(value)
      return self.to_python(value)
  ```
- 근본 원인: GFK prefetch는 `object_id`(문자열, 예: dash 없는 hex)를 대상 모델 PK에 in-query 매칭하고, 가져온 객체를 PK로 캐시한 뒤 원본 행과 키를 맞춘다. 이 비교에서 lookup 값은 대상 필드의 `get_prep_value`를 거치는데, `UUIDField`가 이 메서드를 오버라이드하지 않아 `Field`의 기본 구현(값을 그대로 통과)이 쓰였다. 결과적으로 캐시 키(정규화된 `uuid.UUID`)와 lookup 키(원시 문자열)가 불일치 → 매칭 실패 → 속성이 `None`. 기존에 있던 `get_db_prep_value`는 DB 바인딩 직전 단계라 파이썬 레벨 prefetch 키 매칭에는 적용되지 않아 이 갭을 못 메웠다.
- 수정 요지: `UUIDField.get_prep_value`를 추가해 부모 prep 후 `self.to_python(value)`로 값을 일관된 `uuid.UUID` 표현으로 정규화. 이로써 prefetch가 비교하는 양쪽 키가 동일 정규형이 되어 매칭이 성립한다. 더 늦은 `get_db_prep_value`가 아니라 더 상위의 `get_prep_value` 단계에서 정규화를 보장한 것이 핵심.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `test_prefetch_GFK_uuid_pk (prefetch_related.tests.GenericRelationTests)`
- 테스트 구성: `tests/prefetch_related/models.py`에 UUID PK를 가진 `Article` 모델 추가, `Comment`에 UUID용 GFK 쌍(`content_type_uuid`/`object_pk_uuid`/`content_object_uuid`) 추가. 이때 기존 `content_type`을 `null=True`로 완화(두 GFK 중 하나만 채워지는 케이스 허용).
- FAIL_TO_PASS 동작: `Article.objects.create(name='Django')`로 UUID PK 객체 생성 → `Comment.objects.create(comment='awesome', content_object_uuid=article)`로 GFK 연결 → `Comment.objects.prefetch_related('content_object_uuid')` 실행 → `[c.content_object_uuid for c in qs] == [article]` 단언. 픽스 전에는 키 불일치로 `[None] != [article]` 실패, 픽스 후 UUID 정규화로 매칭돼 통과.
- 픽스 증명: 테스트는 prefetch 경로 끝단(캐시 매칭 결과가 실제 객체로 채워지는가)을 직접 관찰하므로, 표면 우회가 아니라 키 정규화가 실제로 일어났음을 검증한다.
- overfit 관점: FAIL_TO_PASS가 1개로 얇아 보이나(overfit-risk 후보), 골드 픽스는 UUIDField 전반의 prep 정규화를 고치는 것이라 이 테스트 너머(일반 GFK·필터·in_bulk 등 모든 lookup prep)로 자동 일반화된다. CEGIS(S4)식 special-case 통과 위험은 낮음 — UUIDField에만 정규화를 추가한 것이 곧 올바른 일반해.
- regression 관점: PASS_TO_PASS 76개가 전부 prefetch 스위트(GFK 정수/charfield/nullable PK, m2m, 다중상속 등). `get_prep_value`는 모든 UUIDField lookup이 타는 hot path라 잘못 구현하면 광범위 회귀가 난다. 골드는 `super()`를 먼저 호출해 부모 계약(None 처리 등)을 보존한 뒤 `to_python`만 덧대 부작용을 최소화했다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 결정적 신호는 "UUIDField를 PK로 쓸 때**만**" 발생한다는 교차 조건. 이를 "GFK 미지원"(hints_text 오답)이 아니라 "필드 타입 의존 버그"로 읽어야 한다. prefetch 매칭은 `GenericForeignKey.get_prefetch_queryset`에서 `object_id` 문자열로 대상을 모은 뒤 PK로 매칭하는데, 매칭 키가 어긋난다는 가설을 세우고 "lookup 값 정규화는 대상 필드 책임"이라는 ORM 계약을 따라가면 `UUIDField`로 수렴한다. 표면(prefetch_related.py)이 아니라 데이터플로우의 종점(필드 prep)을 짚는 게 정답 경로.

2. **픽스와 왜 올바른 일반화인가**: `UUIDField.get_prep_value`를 추가해 부모 prep 후 `to_python`으로 `uuid.UUID` 정규화. 이게 특정 테스트만 통과시키는 hack이 아닌 이유는, 정규화가 **모든** UUIDField lookup 입력에 적용되는 필드 레벨 계약을 메우기 때문. GFK prefetch뿐 아니라 일반 filter/in_bulk 등에서 문자열 PK를 넘길 때도 일관되게 동작하게 만든다. `get_db_prep_value`(더 늦은 DB 단계)가 아니라 `get_prep_value`를 고른 것이 핵심 정답 — 파이썬 레벨 lookup 비교가 이 단계를 탄다.

3. **regression 안전**: PASS_TO_PASS 76개 중 위험군은 (a) 정수/charfield PK GFK prefetch(`test_prefetch_GFK`, `test_prefetch_GFK_nonint_pk`, `test_charfield_GFK`) — UUIDField에만 손대므로 영향 없음, (b) nullable GFK(`test_nullable_GFK`) — `super().get_prep_value`를 먼저 호출해 None 전파를 보존해야 안 깨짐. 핵심은 부모 계약을 우회하지 말고 그 위에 정규화만 얹는 것. GFK 측이나 prefetch_related.py를 건드리면 이 76개 전 범위가 위험해진다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (1) hints_text의 "GFK는 prefetch 미지원" 오답에 끌려가 버그가 아니라고 닫아버림 → 증상이 UUID 한정이라는 점으로 반박. (2) 증상 표면(GFK/contenttypes/prefetch_related.py)을 고쳐 우회 패치를 넣음 → P2P 76개를 깨고 overfit. (3) 이미 존재하는 `get_db_prep_value`를 보고 "변환은 처리됨"으로 오판하거나 거기를 고침 → 호출 시점이 달라 prefetch 키 매칭엔 안 먹힘. 회피법: `get_prep_value`와 `get_db_prep_value`의 호출 시점·계약 차이를 먼저 확정하고, "prefetch가 비교하는 양쪽 키가 동일 정규형인가"를 불변식으로 잡아 단일 필드 prep에 4줄로 수렴한다.
