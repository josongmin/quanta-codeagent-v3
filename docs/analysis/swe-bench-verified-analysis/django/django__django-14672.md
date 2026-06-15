---
instance_id: django__django-14672
repo: django/django
base_commit: 00ea883ef56fb5e092cbe4a6f7ff2e7470886ac4
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-07-20T10:47:34Z
fail_to_pass: 168
pass_to_pass: 0
gold_files: [django/db/models/fields/reverse_related.py]
---

# django__django-14672

## 문제 요약
Django 3.2에서 `ForeignObjectRel`에 `identity` property가 추가돼 rel 객체끼리 비교·해시가 가능해졌다. `identity`는 tuple이고 `__hash__`가 `hash(self.identity)`로 동작하는데, 해시 가능하려면 모든 원소가 hashable이어야 한다. `ManyToManyRel.identity`는 `through_fields`를 그대로 끼워 넣는데, `through_fields`가 list로 지정되면 unhashable이라 `TypeError: unhashable type: 'list'`가 터진다. 사용자는 `manage.py check`(특히 proxy 모델 검사)가 정상 통과하길 기대했지만 크래시가 발생한다.

## 유형 분류
- 버그 카테고리: 누락처리 (make_hashable 호출 누락) / edge-case
- 서브시스템: django ORM — model fields의 reverse relation descriptor (`reverse_related.py`)
- 증상 타입: 예외/크래시 (`TypeError: unhashable type: 'list'`)
- 로컬라이제이션 신호: problem_statement가 파일·함수·해결책까지 명시적으로 지목한다 — "Missing call `make_hashable` on `through_fields` in `ManyToManyRel`", 트레이스백 마지막 프레임이 `reverse_related.py` line 140 `__hash__ → return hash(self.identity)`. 사실상 패치 위치가 그대로 주어진 셈.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/reverse_related.py` : `ManyToManyRel.identity` (property)
- 근본 원인: `identity`가 비교/해시용 tuple을 만드는데 `self.through_fields`를 raw로 포함한다. `limit_choices_to`(부모 `ForeignObjectRel.identity`)는 이미 `make_hashable`을 거치지만 `through_fields`는 빠져 있었다. 사용자가 `through_fields=['child', 'parent']`처럼 list로 넘기면 tuple 안에 list가 들어가 `hash()`가 실패한다.
- 수정 요지: `identity` property에서 `self.through_fields,` 한 줄을 `make_hashable(self.through_fields),`로 교체. `make_hashable`이 list를 tuple로 재귀 변환해 identity 전체가 해시 가능해진다. 단 한 줄 변경.

## 검증 (test_patch)
- FAIL_TO_PASS 핵심: `m2m_through.tests.M2mThroughTests.test_reverse_inherited_m2m_with_through_fields_list_hashable`, 그리고 `invalid_models_tests.test_models.ShadowingFieldsTests.test_field_name_clash_with_m2m_through`.
- 증명 방식:
  - `m2m_through/models.py`에서 `Event.invitees` M2M의 `through_fields`를 tuple → `['event', 'invitee']` list로 바꾸고 `PersonChild(Person)` 상속 모델 추가. 테스트는 `Person`과 상속받은 `PersonChild`의 reverse field `events_invited`를 꺼내 `through_fields == ['event', 'invitee']`임을 확인하고, 결정적으로 `hash(reverse_m2m) == hash(inherited_reverse_m2m)`를 단언 — 픽스 전이면 `hash()` 호출 자체가 `TypeError`로 터진다 (재현 입력 → 기대 출력: 두 rel의 해시가 같고 예외 없음).
  - `test_field_name_clash_with_m2m_through`는 `through_fields=['parent', 'model']` list를 쓴 모델에서 `Child.check()`가 크래시 없이 정확히 하나의 `models.E006` 필드 충돌 Error를 반환하는지 검사 — 즉 `_check_field_name_clashes`의 `if f not in used_fields:`(set 멤버십, 내부적으로 `__hash__` 사용) 경로가 살아 있음을 증명.
  - FAIL_TO_PASS가 167개로 폭증한 이유: `m2m_through/models.py`의 `Event` 정의가 모듈 임포트 시점에 평가되므로, 픽스 전엔 이 테스트 파일들의 다수 테스트가 collection/import 단계에서 동반 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·줄·해결책을 직접 준 거의 "정답 공개" 케이스. `reverse_related.py`의 `ManyToManyRel` 클래스 `identity` property를 열고 부모 `ForeignObjectRel.identity`가 이미 쓰는 `make_hashable`을 동일 패턴으로 `through_fields`에 적용하면 끝.
- 함정/난이도: 변경 자체는 1줄이지만 (1) `make_hashable`이 이미 import돼 있는지 확인 필요 (`from django.utils.hashable import make_hashable` 동일 모듈에서 사용 중), (2) `through_fields`를 list→tuple로 강제 변환하는 식으로 "고치면" identity 동등성/직렬화나 다른 소비처에 영향 줄 수 있으니 원본은 보존하고 identity 계산 시점에만 hashable화해야 한다. (3) 멀티파일 아님 — 프로덕션 수정은 단일 파일.
- 우리 에이전트 관점: 막힐 지점은 거의 없음. 위험은 오히려 "단서가 너무 명확한데 over-engineering"하는 것 — `through_fields` 자체를 생성자에서 tuple로 정규화하거나 `__hash__`를 손대는 식으로 범위를 넓히면 골드와 어긋나고 PASS_TO_PASS 외 회귀를 부를 수 있다. 부모 클래스가 쓰는 `make_hashable` 관용구를 그대로 따라가는 게 정답.
