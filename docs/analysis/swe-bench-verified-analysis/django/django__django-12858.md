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
---

# django__django-12858

## 문제 요약
`Meta.ordering`에 transform이 아닌 lookup(`__isnull` 등)을 쓰면 시스템 체크가 `models.E015` ("ordering refers to the nonexistent field, related field, or lookup")를 잘못 띄운다. 실제로 `order_by('supply__product__parent__isnull')` 쿼리는 정상 동작하는데 체크만 거짓 양성을 낸다. 사용자는 런타임에 유효한 ordering이면 `./manage.py check`도 통과하길 기대한다. 리포터는 #29408(ordering의 transform 지원) 도입 이후 회귀로 추정.

## 유형 분류
- 버그 카테고리: regression / 누락처리 (lookup 케이스 미고려)
- 서브시스템: django ORM model system checks (`_check_ordering`)
- 증상 타입: 잘못된 출력 (false-positive 시스템 체크 에러)
- 로컬라이제이션 신호: 에러 코드 `models.E015`와 메시지 문구 "refers to the nonexistent field, related field, or lookup"를 grep하면 곧장 `django/db/models/base.py`의 `Model._check_ordering`로 수렴. "transform"/"#29408" 언급이 transform 처리 분기를 지목.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/base.py` : `Model._check_ordering` (classmethod)
- 근본 원인: ordering 경로의 마지막 part를 해석할 때, 필드가 아니면 "transform이냐"만 검사했다. `fld.get_transform(part) is None`이면 무조건 에러로 처리. 그러나 `__isnull` 같은 등록된 lookup은 transform이 아니라서 `get_transform`이 None을 반환 → 유효한 ordering인데도 E015가 발생.
- 수정 요지: 에러 추가 조건을 `fld.get_transform(part) is None`에서 `fld.get_transform(part) is None and fld.get_lookup(part) is None`으로 확장. 즉 해당 part가 transform이 아니더라도 lookup으로 해석 가능하면 유효한 것으로 보고 에러를 내지 않는다. transform과 lookup 둘 다 None일 때만 nonexistent로 판정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_ordering_pointing_to_lookup_not_transform` — `CharField test`에 `ordering = ('test__isnull',)`를 가진 모델을 정의하고 `Model.check()`가 빈 리스트(에러 없음)를 반환하는지 확인.
- 증명 방식: `__isnull`은 transform이 아니고 lookup이라, 패치 전에는 `get_transform('isnull') is None` → E015가 append되어 `check()`가 비어있지 않았다. 패치 후 `get_lookup('isnull')`이 lookup 객체를 반환해 조건이 False가 되어 에러가 추가되지 않음. 재현 입력(`ordering=('test__isnull',)`) → 기대 출력(`[]`).

## 공략 포인트 (뭘 조져야)
- localization 전략: 에러 메시지/코드(E015)로 단일 함수 `_check_ordering` 진입 → except `(FieldDoesNotExist, AttributeError)` 블록 안의 transform 분기가 핵심. 단일 파일·단일 줄 수정.
- 함정/난이도 메모: transform과 lookup이 다른 개념이라는 걸 알아야 함(`get_transform` vs `get_lookup`). 또한 마지막 part만 transform/lookup일 수 있고 중간 part는 관계 탐색이므로, `get_transform` 검사를 `get_lookup`으로 단순 치환하면 안 되고 OR로 추가해야 함. 인접한 `test_ordering_allows_registered_lookups`(이미 PASS_TO_PASS) 테스트가 등록 lookup 케이스를 다루지만 `__isnull` 같은 빌트인 lookup 경로를 놓쳤던 것.
- 우리 에이전트 관점: 막힐 만한 지점은 (1) transform과 lookup의 차이를 모르고 `get_transform`만 더 손대려 시도, (2) 정규식/문자열로 lookup 화이트리스트를 하드코딩하는 휴리스틱 유혹 — 정답은 필드 API `get_lookup`을 그대로 호출하는 것. 기존 transform 테스트를 깨지 않으면서 OR 조건만 추가하는 최소 변경이 핵심.
