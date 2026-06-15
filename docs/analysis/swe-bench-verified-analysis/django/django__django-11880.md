---
instance_id: django__django-11880
repo: django/django
base_commit: 06909fe084f87a65459a83bd69d7cdbe4fce9a7c
version: 3.1
difficulty: <15 min fix
created_at: 2019-10-07T19:10:59Z
fail_to_pass: 1
pass_to_pass: 114
gold_files: [django/forms/fields.py]
---

# django__django-11880

## 문제 요약
Form `Field`의 `__deepcopy__`가 `error_messages` 딕셔너리를 (deep)copy하지 않아서, 같은 필드를 deepcopy한 모든 복사본이 동일한 `error_messages` 딕셔너리를 공유한다. 결과적으로 한 폼 인스턴스에서 에러 메시지를 동적으로 바꾸면 동일 폼 클래스의 다른 모든 인스턴스에까지 그 변경이 반영되어, 의도치 않은(잘못된) 에러가 발생한다. 사용자는 각 폼 인스턴스의 필드가 서로 격리("sealed")되기를 기대한다. Django 1.11까지 거슬러 올라가 재현된다.

## 유형 분류
- 버그 카테고리: 누락처리 (shallow-copy로 인한 mutable 공유 상태 누락)
- 서브시스템: django forms (Field 정의/복제)
- 증상 타입: silent-wrong (조용히 잘못된 에러 메시지가 인스턴스 간 누수)
- 로컬라이제이션 신호: problem_statement이 `django/forms/fields.py`의 `__deepcopy__`(L200)와 `error_messages` 딕셔너리를 직접 지목. 거의 좌표를 찍어준 수준.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/fields.py` : `Field.__deepcopy__`
- 근본 원인: `__deepcopy__`가 `result = copy.copy(self)` (shallow copy)로 시작한 뒤 `widget`과 `validators`만 따로 복제하고 `error_messages` dict는 그대로 두었다. 그래서 원본과 복사본이 같은 dict 객체를 참조 → 한쪽 mutation이 모두에 전파.
- 수정 요지: `widget` deepcopy 다음 줄에 한 줄 추가 — `result.error_messages = self.error_messages.copy()`. `error_messages` 딕셔너리의 얕은 사본(키/값 1단계 복사)을 새로 만들어 인스턴스별로 독립시킨다. validators가 이미 `[:]`로 복제되던 패턴과 동일한 방식.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_field_deep_copy_error_messages` — `CustomCharField`(생성 시 `error_messages={'invalid': ...}` 주입)를 만들고 `copy.deepcopy`한 뒤, 복사본이 여전히 `CustomCharField` 인스턴스인지, 그리고 `field_copy.error_messages`가 `field.error_messages`와 **다른 객체**(`assertIsNot`)인지 확인.
- 픽스 증명: 패치 전에는 둘이 같은 dict 객체라 `assertIsNot`가 실패. 패치 후 `.copy()`로 별도 dict가 생기므로 통과. 117개 PASS_TO_PASS(`test_validators_independence`, `test_multivalue_deep_copy` 포함)는 기존 복제 동작이 깨지지 않았음을 보장.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement이 파일·라인·메서드까지 명시했으므로 `Field.__deepcopy__`로 직행. `error_messages`가 어디서 초기화되는지(`Field.__init__`의 message dict 병합)를 보면 mutable dict임이 바로 드러남.
- 함정/난이도 메모: validators(`[:]`)와 widget(`deepcopy`)은 이미 처리되어 있어, "복제가 안 되는 mutable 속성"이 `error_messages` 하나뿐임을 알아채는 게 핵심. 굳이 재귀 `deepcopy`까지 갈 필요 없이 `.copy()`면 충분(메시지 값은 보통 문자열/lazy). 멀티파일 아님, 단일 한 줄.
- 우리 에이전트 관점: 난이도 매우 낮음. 막힐 만한 지점은 거의 없으나, 과교정으로 `copy.deepcopy(self.error_messages)`를 쓰거나 `__init__`까지 손대는 등 골드보다 무겁게 고칠 위험. 골드는 최소 1줄·`.copy()`이므로 그 altitude를 맞추는 게 포인트.
