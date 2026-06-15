---
instance_id: django__django-11551
repo: django/django
base_commit: 7991111af12056ec9a856f35935d273526338c1f
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-07-09T22:28:45Z
fail_to_pass: 1
pass_to_pass: 119
gold_files: [django/contrib/admin/checks.py]
---

# django__django-11551

## 문제 요약
ModelAdmin의 `list_display`에 인스턴스를 통해서만 접근 가능한 필드(예: django-positions의 `PositionField`)를 넣으면, Django 2.2.1부터 시작 시점에 잘못된 `admin.E108` 검증 에러가 발생해 기동이 막힌다. 2.0.7에서는 정상 동작하던 설정이다. 사용자는 실제로 유효한 필드이므로 검증을 통과하길 기대했다. 원인은 ticket 28490 수정 커밋(47016adb)이 다른 케이스를 깨뜨린 회귀.

## 유형 분류
- 버그 카테고리: regression (28490 수정으로 유발된 회귀) + edge-case 누락처리
- 서브시스템: django.contrib.admin 시스템 체크 (ModelAdmin validation)
- 증상 타입: 잘못된 출력 (오탐 E108) → 앱 기동 차단
- 로컬라이제이션 신호: problem_statement가 `django.admin.contrib.checks._check_list_display`와 메서드 `_check_list_display_item`, 그리고 회귀 유발 커밋 47016adbf54b를 직접 지목. 에러 ID `admin.E108`/`E109`로 파일 내 위치까지 좁혀짐.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/checks.py:_check_list_display_item`
- 근본 원인: 기존 코드는 `elif hasattr(obj.model, item):` 로 먼저 분기했다. `PositionField`의 디스크립터 `__get__`은 클래스(인스턴스 아님)에서 호출되면 `AttributeError`를 던지므로 `hasattr(obj.model, item)`이 False가 된다. 그 결과 `get_field(item)`을 시도조차 못하고 곧장 E108로 떨어졌다. `hasattr`의 False를 "필드 없음"으로 잘못 conflation 한 것.
- 수정 요지: `hasattr(obj.model, item)` 분기를 제거하고, 먼저 `obj.model._meta.get_field(item)`을 시도한다. `FieldDoesNotExist`가 나면 그제서야 `getattr(obj.model, item)`을 시도하고, 그것마저 `AttributeError`면 E108을 반환한다. 둘 중 하나로 field를 확보하면, 그 field가 `models.ManyToManyField`인지 검사해 E109를 내거나 `[]`(유효)를 반환한다. None 여부로 분기하던 모호한 로직을 예외 처리 흐름으로 대체.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_valid_field_accessible_via_instance` (modeladmin.test_checks.ListDisplayTests)
- 테스트가 어떻게 픽스를 증명하는지: 테스트는 `Field`를 상속한 `PositionField`를 정의하되 `__get__`에서 `instance is None`이면 `AttributeError`를 던지도록 한다(클래스 레벨 접근 시 hasattr=False 재현). 이 필드를 `list_display = ('field',)`에 넣고 `assertIsValid`로 검증 에러가 0개임을 단언한다. 픽스 전이면 `get_field('field')`가 성공함에도 E108이 잘못 나와 실패하고, 픽스 후엔 get_field가 정상 필드를 반환해 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 파일/함수/회귀 커밋을 명시하므로 곧장 `_check_list_display_item`으로 진입. 12행짜리 진리표(hasattr × get_field × None × M2M)를 읽고 분기 순서를 재설계하는 게 핵심.
- 함정/난이도 메모: 단일 파일·단일 함수지만 4개 변수의 조합을 정확히 따져야 한다. `hasattr` 선검사를 제거하면 `get_field`를 항상 먼저 시도하는 흐름으로 바뀌는데, 순서를 잘못 잡으면 E109(M2M) 검사를 빠뜨리거나 E108 메시지 조건이 깨진다. None 변수로 신호를 보내던 안티패턴을 예외 흐름으로 옮기는 게 정답.
- 우리 에이전트 관점: 막힐 만한 지점은 "수정이 한 줄로 보이는 착시". hasattr를 그냥 try로 감싸는 식의 최소 수정은 진리표의 일부 행(예: get_field raises + M2M)을 여전히 틀린다. problem_statement에 정답 코드 블록이 통째로 주어져 있어 이를 충실히 반영하면 안전하지만, 힌트를 무시하고 자체 분기하면 PASS_TO_PASS의 인접 케이스(E108/E109 테스트)를 깨기 쉽다.
