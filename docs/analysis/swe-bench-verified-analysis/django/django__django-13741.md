---
instance_id: django__django-13741
repo: django/django
base_commit: d746f28949c009251a8741ba03d156964050717f
version: 3.2
difficulty: <15 min fix
created_at: 2020-12-02T10:52:52Z
fail_to_pass: 1
pass_to_pass: 82
gold_files: [django/contrib/auth/forms.py]
---

# django__django-13741

## 문제 요약
`django.contrib.auth.forms.UserChangeForm`은 비밀번호 해시가 사용자에 의해 (실수로) 변경되는 것을 막기 위해 `clean_password` 메서드로 항상 초기값을 되돌려준다. User 모델용 커스텀 폼을 만들 때도 이 메서드를 반드시 정의해야 한다고 문서에 명시되어 있는데, 이걸 빼먹으면 비밀번호가 망가지는 함정이 있다. 폼 `Field`에 이미 존재하는 `disabled` 인자(제출값을 무시하고 initial 값을 강제)를 `ReadOnlyPasswordHashField`에 기본 `True`로 걸면 `clean_password`가 불필요해진다는 개선 요청이다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (기본값 미설정으로 인한 fragile 계약)
- 서브시스템: django contrib.auth forms
- 증상 타입: silent-wrong (커스텀 폼이 `clean_password`를 누락하면 조용히 비밀번호 해시가 덮어써짐)
- 로컬라이제이션 신호: `ReadOnlyPasswordHashField`, `UserChangeForm`, `clean_password`, `disabled` 라는 구체 심볼이 problem_statement에 그대로 명시 → `django/contrib/auth/forms.py` 직행

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/forms.py:ReadOnlyPasswordHashField.__init__` / `UserChangeForm.clean_password` 제거
- 근본 원인: 읽기 전용 필드인데도 `disabled`가 꺼져 있어, 제출값 무시 로직을 폼/필드 레벨의 보일러플레이트(`has_changed`/`bound_data`/`clean_password`)로 직접 구현해야 했다. 커스텀 폼에서 `clean_password`를 누락하면 보호가 사라지는 게 함정.
- 수정 요지:
  - `ReadOnlyPasswordHashField.__init__`에 `kwargs.setdefault('disabled', True)` 추가 → 프레임워크의 `disabled` 메커니즘이 제출값을 무시하고 initial을 강제.
  - 더 이상 필요 없어진 `ReadOnlyPasswordHashField.bound_data`와 `has_changed`(항상 `False` 반환) 메서드를 삭제.
  - `UserChangeForm.clean_password`(항상 `self.initial['password']` 반환) 삭제. 이제 `disabled=True`가 동일한 보호를 대신함.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_readonly_field_has_changed (auth_tests.test_forms.ReadOnlyPasswordHashTest)`
- 테스트가 증명하는 방식: 기존 테스트에 `self.assertIs(field.disabled, True)` 한 줄을 추가. 즉 `ReadOnlyPasswordHashField()`를 인자 없이 생성했을 때 `disabled`가 기본 `True`인지 확인한다. 이어지는 `assertFalse(field.has_changed('aaa', 'bbb'))`는 `has_changed` 메서드를 삭제했음에도 `disabled` 필드는 base `Field.has_changed`가 항상 `False`를 반환하므로 여전히 통과 → initial≠data여도 "변경 없음"이 보장됨을 입증.
- PASS_TO_PASS의 `test_bug_19349_bound_password_field`, "The change form does not return the password value" 등이 `clean_password`/`bound_data` 삭제 후에도 회귀 없음을 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 클래스/메서드/파일이 거의 다 명시되어 있어, `grep ReadOnlyPasswordHashField` → `django/contrib/auth/forms.py` 한 파일로 즉시 수렴.
- 함정/난이도 메모:
  - `disabled` 추가만 하고 `clean_password`/`bound_data`/`has_changed`를 안 지우면 동작은 맞지만 dead code가 남는다. 정답 패치는 중복 로직 제거까지 포함. 단 FAIL_TO_PASS 자체는 `disabled is True`만 보므로 삭제 없이도 테스트는 통과할 수 있다(over-claim 주의: 채점 기준은 disabled 한 줄).
  - `setdefault`를 써야 한다 — 호출자가 명시적으로 `disabled=False`를 넘기는 경우를 깨면 안 됨.
- 우리 에이전트 관점: 단일 파일·15분 난이도라 막힐 여지는 적다. 위험은 "최소 변경" 원칙으로 `disabled` 한 줄만 추가하고 `clean_password`를 남겨두는 것 — 기능상 무해하지만 골드와 diff가 어긋난다. `disabled` 필드 시맨틱(initial 강제, 제출값 무시)을 정확히 이해하면 안전하게 보일러플레이트를 제거할 수 있다.
