---
instance_id: django__django-12858
repo: django/django
base_commit: f2051eb8a7febdaaa43bd33bf5a6108c5f428e59
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-05-05T04:49:02Z
fail_to_pass: 1
pass_to_pass: 73
gold_files: [django/db/models/base.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-12858

## 문제 요약
`Meta.ordering`에 transform이 아닌 lookup(`__isnull` 등)을 쓰면 시스템 체크가 `models.E015` ("'ordering' refers to the nonexistent field, related field, or lookup")를 잘못 띄운다. 실제로 `Stock.objects.order_by('supply__product__parent__isnull')` 쿼리는 정상 동작하는데 `./manage.py check`만 거짓 양성(false-positive)을 낸다. 리포터는 transform 지원을 도입한 #29408 이후의 회귀로 추정하며, 런타임에 유효한 ordering이면 시스템 체크도 통과해야 한다는 기대를 명시한다. 이슈에 재현 코드(쿼리 + 모델 관계)와 회귀 원인 티켓이 모두 포함돼 있다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable)** — 이슈가 함수명을 직접 주진 않지만, 에러 코드 `models.E015`와 메시지 문구 "refers to the nonexistent field, related field, or lookup"가 코드베이스에 유일하게 존재해 grep 한두 방으로 `django/db/models/base.py`의 `Model._check_ordering`로 좁혀진다. "transform"/"#29408" 언급이 transform 분기를 정확히 지목. 단일 파일·단일 분기로 수렴하는 약한 탐색이라 L0가 아니라 L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning) (+S1)** — 고칠 지점(except 블록의 transform 가드)은 빠르게 찾지만, 올바른 조건식을 **추론으로 합성**해야 한다. "transform이 아니면 에러"라는 불완전한 술어를, "transform도 아니고 lookup도 아닐 때만 에러"로 바꿔야 함을 깨달으려면 transform⊊(transform∪lookup)이라는 도메인 불변식을 따져야 한다. 조건 가드 확장이라는 결과 형태는 S1(누락 케이스 가드 추가)에 가깝지만, 올바른 보조 술어(`get_lookup`)를 발견·합성하는 추론이 본질이라 dominant는 S2.
- **K (Knowledge) = K-Domain** — django 필드 API에서 transform과 lookup이 **서로 다른 레지스트리**(`get_transform` vs `get_lookup`)이고 `__isnull`이 transform이 아닌 빌트인 lookup이라는 프레임워크 내부 지식이 병목. 일반 파이썬 추론(K-Gen)으로는 `get_transform`이 None인 이유를 설명할 수 없다.
- **Primary type = T-DomainBound** — 위치는 명확하고 패치는 1줄이지만, 진짜 난점은 "왜 유효한 ordering이 reject되는가"를 transform/lookup 분리라는 ORM 도메인 지식 없이는 풀 수 없다는 데 있다. S2 추론도 결국 그 도메인 지식 위에서만 성립하므로 K-Domain이 dominant → T-DomainBound (T-ConstraintReason보다 우선).

## 난이도 티어
**T3 (중간).** 구조적 피처: 단일 파일(`base.py`) · 실질 변경 1줄(가드 조건 1개 추가) · localize는 L1로 비교적 직접적 · `has-repro`(이슈에 쿼리·모델관계·회귀 티켓 #29408까지 포함, 가장 강한 easiness 신호). 이 피처들만 보면 T2로 내려갈 수 있으나, **K-Domain 추론 병목**(transform vs lookup 분리를 모르면 막힘)과 **넓은 P2P trap**(73개 PASS_TO_PASS, 그중 `test_ordering_*` 다수가 `_check_ordering`의 다른 경로를 직접 검증)이 T3로 민다.

공식 difficulty 라벨("15 min - 1 hour")과 대체로 일치하나, 그 라벨은 "transform/lookup 차이를 이미 아는 django 코어 개발자의 구현시간"이다. 오라클 없는 에이전트 관점에서는 도메인 지식 의존도가 시간라벨에 안 잡히므로 T2가 아닌 T3가 적절. T4까지 올리지 않는 이유는 refactor가 없고(S6 아님) cross-file 조율도 없으며 overfit 위험이 낮기 때문(`get_lookup` 호출은 일반화된 정답이라 S4 아님).

## 골드패치 분석
- **건드린 파일·함수:** `django/db/models/base.py` : `Model._check_ordering` (classmethod), `except (FieldDoesNotExist, AttributeError)` 블록 내부.
- **근본 원인:** ordering 경로의 마지막 part를 필드로 해석하다 실패하면, 그 part가 transform인지만 검사했다 — `if fld is None or fld.get_transform(part) is None:` 이면 무조건 E015. 그러나 #29408이 transform만 허용 경로에 추가했고, `__isnull`·`exact` 같은 등록된 **lookup**은 transform이 아니라 `get_transform(part)`가 None을 반환 → 런타임엔 유효한 ordering인데 체크가 거짓 양성을 낸다.
- **수정 요지:** 에러 추가 술어를 `fld.get_transform(part) is None`에서 `fld.get_transform(part) is None and fld.get_lookup(part) is None`으로 확장. 즉 마지막 part가 transform이 아니어도 lookup으로 해석 가능하면 유효로 보고 에러를 내지 않는다. transform·lookup 둘 다 None일 때만 nonexistent로 판정. `get_transform`을 `get_lookup`으로 치환이 아니라 OR로 **추가**한 것이 핵심(둘 다 살려야 함).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_ordering_pointing_to_lookup_not_transform` — `CharField test`를 가진 모델에 `Meta.ordering = ('test__isnull',)`를 두고 `Model.check()`가 빈 리스트(에러 없음)를 반환하는지 단언.
- **픽스 증명:** `__isnull`은 transform이 아니라 lookup이므로, 패치 전엔 `get_transform('isnull') is None`이 True → E015가 append되어 `check()`가 비어있지 않았다. 패치 후엔 `get_lookup('isnull')`이 lookup 객체를 반환해 두 번째 피연산자가 False가 되고, AND 전체가 False가 되어 에러가 추가되지 않는다. 재현 입력(`ordering=('test__isnull',)`) → 기대 출력 `[]`.
- **overfit 관점:** FAIL_TO_PASS가 1개라 얇아 보이지만, 픽스가 lookup 화이트리스트 하드코딩이 아니라 `get_lookup` API를 직접 호출하므로 `__isnull` 외 모든 등록 lookup으로 자동 일반화된다 — 특정 테스트에 맞춘 special-case가 아니라 올바른 일반해. overfit-risk 플래그 미부여.
- **regression 관점:** 73개 PASS_TO_PASS가 `regression-trap`. 특히 `test_ordering_pointing_to_missing_field`·`test_ordering_pointing_to_non_related_field`·`test_ordering_allows_registered_lookups` 등 `_check_ordering`의 다른 경로를 직접 검증하는 테스트가 다수. 조건을 OR가 아닌 치환으로 바꾸거나 transform 검사를 제거하면 이 중 다수가 깨진다 — 픽스가 AND 추가(기존 transform 분기 보존)인 이유.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈의 에러 코드 `models.E015`와 메시지 "refers to the nonexistent field, related field, or lookup"를 코드베이스에 grep → `django/db/models/base.py`의 `Model._check_ordering` 단일 히트. 이슈가 "#29408 이후 회귀" + "transform"을 언급하므로, 그 함수 안에서 `get_transform`을 쓰는 `except (FieldDoesNotExist, AttributeError)` 블록이 의심 지점으로 즉시 좁혀진다.

2. **픽스와 일반화 정당성:** `get_transform(part) is None`만으로 nonexistent를 판정하는 술어가 lookup을 누락한 것. django 필드는 transform과 lookup을 **별도 레지스트리**로 관리하고 `__isnull`은 후자이므로, 유효성 판정은 `get_transform is None AND get_lookup is None`이어야 한다. lookup 이름을 정규식/화이트리스트로 하드코딩하지 않고 필드의 `get_lookup` API를 그대로 호출하는 것이 핵심 — 이러면 `__isnull`뿐 아니라 모든 등록 lookup·서드파티 lookup에 자동 적용되어 테스트 너머로 올바르게 일반화된다(overfit 아님).

3. **regression 안전:** transform 검사를 **삭제·치환이 아니라 보존**하고 lookup 조건을 AND로 추가해야 한다. `test_ordering_pointing_to_missing_field`(진짜 없는 필드는 여전히 E015여야 함)·`test_ordering_allows_registered_lookups`(등록 lookup 허용)·`test_ordering_pointing_to_non_related_field` 등 73개 P2P가 `_check_ordering`의 양방향(거부해야 할 케이스/허용해야 할 케이스)을 모두 잠근다. AND 추가만이 "둘 다 없을 때만 에러"라는 의도를 깨지 않고 만족시킨다.

4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) transform과 lookup이 별개 개념임을 모르고 `get_transform` 쪽만 더 만지작거리다 실패, (b) `__isnull` 등 lookup 이름을 문자열/정규식 화이트리스트로 하드코딩하는 휴리스틱 유혹(일부 케이스만 통과 → 다른 lookup에서 재발, overfit), (c) `get_transform`을 `get_lookup`으로 통째 치환해 transform ordering 케이스를 깨뜨림. 정답은 도메인 API `get_lookup(part)`를 OR(AND of None-checks)로 한 항만 더하는 **최소·일반** 변경. 핵심은 "런타임에서 valid하면 체크도 valid"라는 이슈의 계약을, 실제로 런타임이 쓰는 동일한 resolution API로 맞추는 것.
