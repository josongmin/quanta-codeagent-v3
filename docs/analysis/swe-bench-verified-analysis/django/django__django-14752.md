---
instance_id: django__django-14752
repo: django/django
base_commit: b64db05b9cedd96905d637a2d824cbbf428e40e7
version: 4.0
difficulty: <15 min fix
created_at: 2021-08-07T16:34:32Z
fail_to_pass: 1
pass_to_pass: 15
gold_files: [django/contrib/admin/views/autocomplete.py]
---

# django__django-14752

## 문제 요약
admin의 autocomplete foreign key 필드 결과(JSON)에 커스텀 필드를 추가하려면 현재는 `AutocompleteJsonView.get()` 메서드 전체를 오버라이드해야 한다. `get()`이 계속 진화하기 때문에 결과 dict 한 줄만 바꾸고 싶어도 전체 메서드를 복붙·유지보수해야 하는 부담이 크다. 사용자는 결과 직렬화 로직만 떼어낸 확장 지점(extension point)을 원한다.

## 유형 분류
- 버그 카테고리: API-contract (확장성/리팩터링 — 버그라기보단 extension point 누락)
- 서브시스템: django contrib.admin / autocomplete view
- 증상 타입: silent-wrong 아님 — 커스터마이징 시 과도한 코드 중복/유지보수 부담 (확장 불가)
- 로컬라이제이션 신호: problem_statement가 파일·클래스·메서드를 직접 명시 (`contrib.admin.views.autocomplete.AutocompleteJsonView.get()`)하고, 원하는 `serialize_result()` 시그니처와 본문까지 제시한다. 거의 골드패치 청사진 그대로.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/views/autocomplete.py` : `AutocompleteJsonView.get()` + 신규 `AutocompleteJsonView.serialize_result()`
- 근본 원인: 결과 객체→dict 변환 로직(`{'id': str(getattr(obj, to_field_name)), 'text': str(obj)}`)이 `get()` 안의 list comprehension에 인라인으로 박혀 있어, 이 한 줄을 바꾸려면 `get()` 전체를 오버라이드해야 했다.
- 수정 요지: 인라인 dict 생성 표현식을 `self.serialize_result(obj, to_field_name)` 호출로 교체하고, 동일한 변환 로직을 담은 새 메서드 `serialize_result(self, obj, to_field_name)`를 클래스에 추가. 기본 동작은 완전히 동일(byte-identical 출력)하되 서브클래스가 이 메서드만 오버라이드하면 필드를 추가/변경할 수 있다. `get()` docstring도 "serialize_result()에 정의된 형태"로 갱신.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_serialize_result` — `AutocompleteJsonView`를 상속해 `serialize_result()`에서 `super().serialize_result(...)` 결과에 `'posted'` 필드를 추가하는 서브클래스를 정의하고, 응답 JSON에 추가 필드가 실제로 나타나는지 확인.
- 증명 방식: `posted` 날짜가 다른 Question 2건 생성 → 커스텀 뷰로 요청 → 응답이 `{'id', 'text', 'posted'}` 3개 키를 가진 결과 리스트(`-posted` 정렬)와 일치하는지 `assertEqual`. `super().serialize_result()` 호출이 동작하려면 부모에 해당 메서드가 존재해야 하므로, 메서드 추출이 안 되어 있으면 `AttributeError`로 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·메서드·신규 시그니처를 전부 명시하므로 `autocomplete.py`의 `AutocompleteJsonView.get()` 한 곳만 보면 된다. 단일 파일, 단일 클래스.
- 함정/난이도: 거의 없음 (<15분). 핵심은 동작을 바꾸지 말 것 — 기본 출력은 기존과 동일해야 하고(PASS_TO_PASS 15개가 기존 `test_success` 등을 지킨다), 단지 추출만 한다. `to_field_name` 인자를 메서드로 그대로 전달해야 한다는 점만 주의.
- 우리 에이전트 관점: 리팩터링형 문제라 "버그 증상"이 없어 에이전트가 무엇을 바꿔야 할지 과해석할 위험은 있으나, 본문에 패치가 사실상 제시되어 있어 막힐 지점이 거의 없다. 오히려 problem_statement의 예시 코드(`super.serialize_result` 오타, `|` dict merge)를 그대로 베끼지 말고 정석 메서드 추출만 하면 됨.
