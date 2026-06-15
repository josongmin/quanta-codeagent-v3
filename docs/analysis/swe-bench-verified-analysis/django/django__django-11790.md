---
instance_id: django__django-11790
repo: django/django
base_commit: b1d6b35e146aea83b171c1b921178bbaae2795ed
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-09-17T14:33:44Z
fail_to_pass: 2
pass_to_pass: 77
gold_files: [django/contrib/auth/forms.py]
---

# django__django-11790

## 문제 요약
`AuthenticationForm`의 username 필드가 더 이상 HTML `maxlength` 속성을 렌더링하지 않는다. #27515(커밋 5ceaf14)에서 도입된 회귀로, 폼 필드의 `max_length`는 설정되지만 그 값이 위젯의 HTML `maxlength` 속성으로 전달되지 않아 브라우저단 입력 길이 제한이 사라졌다. 사용자는 username 입력란이 모델의 USERNAME_FIELD 최대 길이(혹은 기본 254)만큼 `maxlength` 속성을 갖고 렌더되기를 기대한다.

## 유형 분류
- 버그 카테고리: regression (회귀 — #27515에서 깨짐)
- 서브시스템: django auth forms (`django.contrib.auth.forms`)
- 증상 타입: 잘못된 출력 (HTML 속성 누락, silent-wrong — 예외 없이 렌더만 빠짐)
- 로컬라이제이션 신호: problem_statement가 "AuthenticationForm's username field" + "maxlength HTML attribute"를 명시하고 회귀 커밋 SHA(5ceaf14686ce)까지 지목 → `django/contrib/auth/forms.py`의 `AuthenticationForm.__init__`로 바로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/forms.py` : `AuthenticationForm.__init__`
- 근본 원인: `__init__`에서 `self.fields['username'].max_length`(폼 필드의 파이썬 검증용 길이)만 설정하고, 실제 HTML 렌더에 쓰이는 `widget.attrs['maxlength']`는 설정하지 않았다. 회귀 전에는 필드 정의 시점에 max_length가 위젯 attrs로 자동 전파됐으나, 동적으로 런타임에 덮어쓰면서 위젯 동기화가 빠졌다.
- 수정 요지: 계산된 max_length 값을 지역변수 `username_max_length = self.username_field.max_length or 254`로 뽑은 뒤, `self.fields['username'].max_length`와 `self.fields['username'].widget.attrs['maxlength']` 양쪽 모두에 같은 값을 명시적으로 대입한다. 이렇게 폼 검증 길이와 HTML 속성을 일치시킨다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `test_username_field_max_length_matches_user_model`(커스텀 USERNAME_FIELD max_length=255), `test_username_field_max_length_defaults_to_254`(max_length 미지정 → 기본 254). 둘 다 `AuthenticationFormTest`.
- 테스트가 어떻게 픽스를 증명하는지: 각 테스트는 기존의 `form.fields['username'].max_length == 255/254` 단언에 더해, 새로 `form.fields['username'].widget.attrs.get('maxlength') == 255/254` 단언을 추가한다. 픽스 전에는 위젯 attrs에 maxlength 키가 없어 `None`이 반환되어 실패하고, 픽스 후엔 위젯 attrs에 값이 들어가 통과한다 (재현 입력: CustomEmailField/IntegerUsernameUser 모델로 폼 생성 → 기대 출력: 위젯 maxlength 속성 == 모델 길이).

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement의 폼 이름과 회귀 커밋이 단서 — `AuthenticationForm.__init__`에서 `max_length`를 대입하는 한 줄을 찾고, 그 옆에 위젯 attrs 동기화가 빠졌음을 인지한다.
- 함정/난이도 메모: 단일 파일·단일 함수의 1줄→3줄 변경이라 난이도는 낮음. 다만 "폼 필드 max_length"와 "위젯 HTML maxlength"가 별개의 두 곳이라는 점을 모르면 max_length만 고치고 끝낼 수 있다 (이미 그 줄은 존재하므로 "이미 맞는데?"라고 오판하기 쉬움). `or 254` fallback 값을 양쪽에 동일하게 적용해야 한다.
- 우리 에이전트 관점: 막힐 지점은 "증상=HTML 렌더에 maxlength 없음"을 코드상 "widget.attrs 미설정"으로 번역하는 단계. 폼 필드 레벨만 보면 max_length가 멀쩡해 보여 헛다리를 짚을 수 있다. 검증 시 위젯 attrs까지 확인하는 테스트를 작성/실행해야 회귀 재현이 가능하다.
