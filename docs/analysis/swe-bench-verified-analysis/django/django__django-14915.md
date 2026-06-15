---
instance_id: django__django-14915
repo: django/django
base_commit: 903aaa35e5ceaa33bfc9b19b7f6da65ce5a91dd4
version: 4.1
difficulty: <15 min fix
created_at: 2021-09-29T22:00:15Z
fail_to_pass: 1
pass_to_pass: 23
gold_files: [django/forms/models.py]
---

# django__django-14915

## 문제 요약
Django 3.0 → 3.1 마이그레이션 후, select 위젯 옵션에 커스텀 `data-*` 속성을 추가하는 코드가 `TypeError: unhashable type: 'ModelChoiceIteratorValue'`로 깨졌다. 3.1부터 `create_option`에 넘어오는 `value`가 raw pk가 아니라 `ModelChoiceIteratorValue` 래퍼 객체인데, 이 객체가 `__eq__`만 정의하고 `__hash__`가 없어서 dict 키 멤버십 검사(`value in {1: [...]}`)에서 실패한다. 사용자는 이전처럼 `value`를 dict 키/멤버십에 쓸 수 있길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (regression — `__eq__` 추가 시 `__hash__` 미정의로 인한 unhashable)
- 서브시스템: django forms (ModelChoiceField / ModelChoiceIterator)
- 증상 타입: 예외 (TypeError: unhashable type)
- 로컬라이제이션 신호: problem_statement에 `ModelChoiceIteratorValue`라는 클래스명이 그대로 박혀 있고, "is not hashable" / "unhashable type"이 명시되어 단일 클래스로 직행 가능. array(`in [1,2]`)는 되고 dict(`in {1:...}`)는 안 되는 대비가 hash 기반 lookup임을 정확히 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py` : `ModelChoiceIteratorValue.__hash__` (신규 추가)
- 근본 원인: Python은 클래스가 `__eq__`를 정의하면 상속받은 `__hash__`를 자동으로 `None`으로 만들어 객체를 unhashable로 만든다. `ModelChoiceIteratorValue`는 `__eq__`만 정의했으므로 dict 키 비교/set 멤버십 등 해시가 필요한 모든 경로에서 깨졌다.
- 수정 요지: `__str__`과 `__eq__` 사이에 `__hash__`를 추가하고, 내부 값으로 위임 — `return hash(self.value)`. `__eq__`가 `self.value` 기준으로 동등성을 판정하므로 hash도 `self.value` 기준으로 맞춰 hash/eq 계약(같으면 hash도 같다)을 보존한다. 단 3줄 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_choice_value_hash` — `ModelChoiceIteratorValue`가 hashable이고 hash가 내부 value로 정해지는지 검증.
- 테스트가 증명하는 방식: `ModelChoiceIteratorValue(self.c1.pk, self.c1)`의 hash가 `ModelChoiceIteratorValue(self.c1.pk, None)`의 hash와 같음을 단언(instance 인자는 hash에 무관, value(pk)만 좌우 → 위임 정확성 증명). 또한 서로 다른 pk(c1 vs c2)는 hash가 다름을 단언해 단순 상수 반환이 아님을 배제. 픽스 전엔 `hash(...)` 호출 자체가 TypeError로 죽어 RED.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement의 클래스명 `ModelChoiceIteratorValue`를 그대로 grep → `django/forms/models.py` 한 곳. `__eq__`만 있고 `__hash__` 없음을 즉시 확인.
- 함정/난이도: 단일 파일·3줄이라 난이도 낮음. 함정은 (1) `__hash__`를 `self.value`가 아니라 `id(self)`나 `super().__hash__()`로 잘못 위임하면 eq/hash 계약이 깨져 다른 인스턴스 같은 pk에서 hash 불일치 → 테스트의 첫 assertEqual에서 fail. (2) `create_option` 호출 측을 고치려는 유혹(증상 위치)에 빠지지 말고 래퍼 클래스 자체를 고쳐야 함.
- 우리 에이전트 관점: 증상이 사용자 코드(`create_option`)에서 발생하므로, 스택트레이스/사용처가 아닌 진짜 원인 클래스로 한 단계 거슬러 올라가는 판단만 하면 거의 막힐 데 없음. Python의 "`__eq__` 정의 시 `__hash__` 자동 무효화" 규칙을 아는지가 근본 원인 설명의 핵심.
