---
instance_id: django__django-16560
repo: django/django
base_commit: 51c9bb7cd16081133af4f0ab6d06572660309730
version: "5.0"
difficulty: 1-4 hours
created_at: 2023-02-16T10:45:56Z
fail_to_pass: 8
pass_to_pass: 66
gold_files: [django/contrib/postgres/constraints.py, django/db/models/constraints.py]
---

# django__django-16560

## 문제 요약
`BaseConstraint.validate`가 제약 위반 시 `ValidationError`를 던질 때, 메시지(`violation_error_message`)는 커스터마이즈할 수 있지만 `code` 속성은 지정할 수 없었다. 사용자는 폼 검증 가이드대로 위반 에러에 식별용 `code`를 붙이고 싶었으나, 현재는 제약을 서브클래싱해 `validate`를 오버라이드하고 에러를 catch & reraise 해야만 했다. validators처럼 생성자에 `violation_error_code` 파라미터를 추가해 달라는 기능 요청이다.

## 유형 분류
- 버그 카테고리: API-contract (누락된 기능/파라미터 추가)
- 서브시스템: django ORM constraints (db/models constraints + postgres ExclusionConstraint)
- 증상 타입: 기능 부재 (커스텀 `code`를 줄 방법이 없음) — 크래시가 아님
- 로컬라이제이션 신호: problem_statement가 `BaseConstraint.validate`와 `violation_error_message`를 직접 지목 → `django/db/models/constraints.py`의 `BaseConstraint`/`CheckConstraint`/`UniqueConstraint`와 그 미러인 postgres `ExclusionConstraint`가 타깃

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/constraints.py`: `BaseConstraint.__init__`, `BaseConstraint.deconstruct`, `CheckConstraint.__init__/__repr__/__eq__/validate`, `UniqueConstraint.__init__/__repr__/__eq__/validate`
  - `django/contrib/postgres/constraints.py`: `ExclusionConstraint.__init__/__repr__/__eq__/validate`
- 근본 원인: `ValidationError` 생성 시 메시지만 넘기고 `code`를 받는 통로가 클래스 어디에도 없었음. 기존엔 `violation_error_message`만 인스턴스 상태로 보존/비교/직렬화되고 있었다.
- 수정 요지:
  - `BaseConstraint`에 클래스 기본값 `violation_error_code = None`을 추가하고 `__init__`에 `violation_error_code` 키워드 인자 추가(주어졌을 때만 인스턴스 속성으로 설정).
  - `deconstruct()`가 `violation_error_code is not None`이면 kwargs에 포함 → 마이그레이션 round-trip 지원.
  - `CheckConstraint`/`UniqueConstraint`/`ExclusionConstraint` 생성자가 새 인자를 받아 `super().__init__`으로 전달.
  - 각 `validate`의 `raise ValidationError(...)`에 `code=self.violation_error_code` 추가. 단 `UniqueConstraint`의 fields 기반 경로(`unique_error_message`)는 backward-compat 위해 의도적으로 code 미적용(→ `unique_together`).
  - `__repr__`/`__eq__`에 `violation_error_code` 반영.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `test_custom_violation_code_message`: `BaseConstraint(name=..., violation_error_code="custom_code")`가 속성에 저장되는지.
  - `test_deconstruction`: deconstruct kwargs에 `violation_error_code`가 들어가는지.
  - `CheckConstraint`/`UniqueConstraint`의 `test_eq`/`test_repr_with_violation_error_code`: 동치 비교와 repr 출력에 code가 반영되는지.
  - `test_validate_custom_error`/`test_validate_conditon_custom_error`: 위반 시 `cm.exception.code`가 지정한 코드와 일치하는지.
- 픽스 증명: 예컨대 `CheckConstraint(check=Q(price__gt=F("discounted_price")), violation_error_code="fake_discount")`로 invalid 인스턴스를 validate → `ValidationError` 메시지는 그대로지만 `cm.exception.code == "fake_discount"`. UniqueConstraint의 fields 경로 테스트(`test_validate`)는 커스텀 code를 세팅해도 `unique_together`가 나옴을 확인해 의도적 예외를 잠금.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/db/models/constraints.py`의 `BaseConstraint`가 SSOT. 기존 `violation_error_message`가 흐르는 모든 지점(`__init__`/`deconstruct`/`__repr__`/`__eq__`/`validate`)을 그대로 미러링하면 됨 — 새 패턴 발명 불필요.
- 함정/난이도:
  - 멀티파일: postgres `ExclusionConstraint`까지 동일 수정 필요(빠뜨리기 쉬움). `__repr__`의 포맷 문자열 placeholder 개수도 같이 늘려야 함.
  - `UniqueConstraint.validate`의 fields-기반 분기는 code를 붙이면 안 됨(backward-compat `unique_together`). 무지성으로 모든 raise에 code를 추가하면 PASS_TO_PASS의 `test_validate`가 깨짐.
  - `deconstruct`/`__eq__`/`__repr__` 중 하나라도 누락하면 해당 FAIL_TO_PASS만 빨갛게 남음.
- 우리 에이전트 관점: 본질은 단순 미러링이지만 "건드릴 곳 4클래스 × 5메서드 + 2파일"이라 완전성이 관건. 한 메서드(특히 ExclusionConstraint repr/eq)나 fields-경로 예외를 놓치면 부분 실패. localization은 쉬우나 enumeration 누락이 실수 포인트.
