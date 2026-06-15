---
instance_id: django__django-15127
repo: django/django
base_commit: 9a6e2df3a8f01ea761529bec48e5a8dc0ea9575b
version: 4.1
difficulty: <15 min fix
created_at: 2021-11-25T13:14:38Z
fail_to_pass: 1
pass_to_pass: 1
gold_files: [django/contrib/messages/apps.py]
---

# django__django-15127

## 문제 요약
`@override_settings(MESSAGE_TAGS=...)`로 메시지 태그를 바꿔도 `django.contrib.messages.storage.base.LEVEL_TAGS` 모듈 상수가 갱신되지 않는다. 그 결과 `Message.level_tag` 프로퍼티가 새 태그를 모른 채 빈 문자열을 반환한다. 사용자는 테스트에서 override한 MESSAGE_TAGS가 메시지 태그에 즉시 반영되길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (setting 변경 시 파생 모듈 상수 동기화 누락) / API-contract
- 서브시스템: django.contrib.messages (storage / 설정 동기화)
- 증상 타입: silent-wrong (예외 없이 빈 문자열 반환)
- 로컬라이제이션 신호: problem_statement가 `LEVEL_TAGS`와 `storage.base` 모듈, `Message.level_tag`를 직접 지목. hints_text가 "setting_changed receiver를 추가해 LEVEL_TAGS를 갱신"하라고 명시 → 수정 위치를 거의 확정적으로 가리킴.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/messages/apps.py` — 새 함수 `update_level_tags(setting, **kwargs)` + `MessagesConfig.ready()`
- 근본 원인: `LEVEL_TAGS`는 import 시점에 `get_level_tags()`로 한 번 계산되어 `storage.base` 모듈에 박힌 상수다. `MESSAGE_TAGS` 설정이 런타임에 바뀌어도(특히 `override_settings`) 이 상수가 재계산되지 않아 stale 상태가 된다. 기존엔 테스트 전용 `override_settings_tags` 헬퍼로만 수동 동기화했다.
- 수정 요지: `setting == 'MESSAGE_TAGS'`일 때 `base.LEVEL_TAGS = get_level_tags()`로 재계산하는 `update_level_tags` receiver를 정의하고, `MessagesConfig.ready()`에서 `setting_changed.connect(update_level_tags)`로 연결한다. 이제 설정 변경 신호가 발생할 때마다(override_settings 진입/이탈 포함) 모듈 상수가 자동 동기화된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_override_settings_level_tags (messages_tests.tests.TestLevelTags)` — `@override_settings(MESSAGE_TAGS=message_tags)` 적용 후 `base.LEVEL_TAGS`가 override한 dict와 같은지 검증.
- 증명 방식: 커스텀 레벨 12를 포함한 `message_tags`로 override → 픽스 전엔 `base.LEVEL_TAGS`가 갱신되지 않아 불일치. 픽스 후 `setting_changed` 신호가 `update_level_tags`를 호출해 상수를 재계산하므로 `assertEqual(base.LEVEL_TAGS, message_tags)` 통과. 또한 test_patch는 테스트 헬퍼 쪽의 임시방편 `override_settings_tags` 서브클래스를 전부 제거하고 평범한 `override_settings`로 교체해, 동기화가 이제 프레임워크 레벨에서 동작함을 입증한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement의 `LEVEL_TAGS` / `storage.base` / `level_tag` 키워드로 `django/contrib/messages/` 디렉터리 진입. `LEVEL_TAGS`가 모듈 import 시점에 한 번만 설정되는 점과 `setting_changed` 시그널 패턴을 인지하면 `apps.py`의 `ready()`가 정답 위치임이 드러남.
- 함정/난이도 메모: 순진하게 `storage/base.py`에서 `LEVEL_TAGS`를 동적 호출로 바꾸려 들 수 있으나, 골드는 그 대신 `apps.py`에 시그널 receiver를 추가하는 Django 관용 패턴을 택함. 기존 테스트의 `override_settings_tags` 헬퍼(수동 동기화)가 이미 존재한다는 점이 "프레임워크가 자동 처리해야 한다"는 방향을 가리키는 강한 힌트.
- 우리 에이전트 관점: 단일 파일·소규모 수정이라 난이도는 낮으나, `setting_changed.connect`를 어디에(=`AppConfig.ready`) 두어야 하는지 Django 라이프사이클 지식이 필요. 수정 위치를 base 모듈로 오판하면 receiver 자동등록 없이 부분 픽스에 그칠 위험.
