---
instance_id: django__django-13933
repo: django/django
base_commit: 42e8cf47c7ee2db238bf91197ea398126c546741
version: 4.0
difficulty: <15 min fix
created_at: 2021-01-26T03:58:23Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [django/forms/models.py]
---

# django__django-13933

## 문제 요약
`ModelChoiceField`는 `ChoiceField` 같은 다른 필드와 달리, 유효하지 않은 선택값으로 `ValidationError`를 던질 때 그 값(invalid choice)을 에러 메시지에 노출하지 않는다. 사용자가 `error_messages`의 `invalid_choice`를 `%(value)s` 플레이스홀더로 커스터마이즈해도, 정작 `params`로 값이 전달되지 않아 placeholder가 채워지지 않는다. 사용자는 어떤 값이 거부됐는지 메시지에 표시되기를 기대한다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (다른 필드와의 일관성 누락)
- 서브시스템: django forms (ModelChoiceField / ModelMultipleChoiceField)
- 증상 타입: silent-wrong (예외는 나지만 메시지에 값이 채워지지 않음)
- 로컬라이제이션 신호: problem_statement가 `ModelChoiceField`와 `ChoiceField`의 `default_error_messages` 소스를 직접 인용하고, "does not pass the value to the validation error"라고 명시 → `django/forms/models.py`의 `ModelChoiceField` 내부 `ValidationError(... code='invalid_choice')` 발생 지점으로 직결.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py` : `ModelChoiceField.to_python`
- 근본 원인: `to_python`의 `except (ValueError, TypeError, DoesNotExist)` 핸들러에서 `ValidationError(self.error_messages['invalid_choice'], code='invalid_choice')`를 던질 때 `params`를 넘기지 않았다. 따라서 메시지 문자열에 `%(value)s`가 있어도 보간할 데이터가 없어 값이 표시되지 않음.
- 수정 요지: 동일한 `ValidationError` 호출에 `params={'value': value}`를 추가한다. `value`는 변환 실패한 입력값이며, 이로써 `%(value)s` 플레이스홀더가 실제 invalid choice로 채워진다. `ChoiceField`가 이미 하던 동작과 일관성을 맞추는 4줄짜리 수정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_modelchoicefield_value_placeholder` — `ModelChoiceField`에 `invalid_choice` 메시지를 `'"%(value)s" is not one of the available choices.'`로 오버라이드.
- 테스트 증명 방식: `f.clean('invalid')`를 호출(쿼리셋에 존재하지 않는 값)하면 `to_python`이 예외 경로를 타고 `ValidationError`를 던진다. 기대 출력은 `'"invalid" is not one of the available choices.'` — 즉 `params={'value': value}`가 전달되어야만 `%(value)s`가 `invalid`로 보간된다. 픽스 전에는 placeholder가 빈 채(혹은 KeyError 방향) 남아 메시지가 일치하지 않음.

## 공략 포인트 (뭘 조져야)
- localization 전략: `grep -n "invalid_choice" django/forms/models.py`로 `ModelChoiceField.to_python`의 except 핸들러를 바로 찾는다. problem_statement가 클래스명과 메시지 키를 그대로 줌.
- 함정/난이도 메모: `default_error_messages`(`ModelChoiceField`/`ModelMultipleChoiceField`)를 고치고 싶어질 수 있으나, 정답은 메시지 텍스트가 아니라 `ValidationError`에 `params`를 넘기는 것. `ModelMultipleChoiceField`는 이미 `%(value)s`가 들어간 메시지를 갖지만 이번 픽스 범위는 단일 `to_python`뿐. 멀티파일 아님(단일 파일, 단일 호출 지점).
- 우리 에이전트 관점: 막힐 지점은 "메시지를 바꿔야 하나, params를 넘겨야 하나"의 판단. 테스트가 메시지를 오버라이드하므로 default 텍스트 수정으로는 통과 불가 — `params` 누락이 진짜 원인임을 잡아야 한다. 또한 같은 패턴의 인접 `ValidationError`(예: validate)와 혼동하지 말고 `to_python`의 invalid_choice 분기만 정확히 수정해야 한다.
