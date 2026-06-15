---
instance_id: django__django-7530
repo: django/django
base_commit: f8fab6f90233c7114d642dfe01a4e6d4cb14ee7d
version: 1.11
difficulty: 15 min - 1 hour
created_at: 2016-11-08T17:27:19Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [django/core/management/commands/makemigrations.py]
---

# django__django-7530

## 문제 요약
`makemigrations`의 마이그레이션 이력 일관성 검사 단계에서 `router.allow_migrate()`를 호출할 때, 각 앱(`app_label`)에 대해 **그 앱의 모델만**이 아니라 **프로젝트 전체의 모든 모델**을 짝지어 호출하고 있었다. 즉 `(app_label, model)` 조합이 잘못 생성된다. 그 결과 샤드별로 모델 구성이 다른 라우터에서는 존재하지 않는 (앱, 모델) 조합이 넘어와 라우터가 깨졌다. 사용자는 각 앱에 대해 해당 앱이 실제로 소유한 모델만 전달되기를 기대했다.

## 유형 분류
- 버그 카테고리: logic / API-contract (라우터에 전달되는 인자 계약 위반)
- 서브시스템: django migrations / management command (`makemigrations`)
- 증상 타입: silent-wrong (잘못된 인자 조합 전달 → 사용자 라우터 크래시)
- 로컬라이제이션 신호: problem_statement가 "makemigrations", "router.allow_migrate()", "consistency checks"를 명시 → `commands/makemigrations.py`의 일관성 검사 루프를 직접 가리킴

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/commands/makemigrations.py` : `Command.handle()` 내 일관성 검사 제너레이터 표현식
- 근본 원인: 루프가 `apps.get_models(app_label)`를 호출했는데, `apps.get_models()`는 인자를 받아 그 앱만 필터링하는 API가 아니라 **전체 모델 리스트를 반환**한다(여기서 `app_label`은 사실상 무시/오용됨). 따라서 모든 `app_label`마다 전체 모델 집합이 곱해져 잘못된 조합이 만들어진다.
- 수정 요지: `for model in apps.get_models(app_label)` → `for model in apps.get_app_config(app_label).get_models()`로 교체. 먼저 해당 `app_label`의 `AppConfig`를 가져온 뒤 그 앱이 소유한 모델만 순회하도록 바꿔, `allow_migrate(alias, app_label, model_name=...)`에 항상 올바른 (앱, 모델) 쌍만 전달되게 한다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `tests/migrations/test_commands.py`의 `test_makemigrations_consistency_checks_respect_routers`가 강화되었다. (PASS/FAIL 매핑은 SquashMigrations 항목으로 기재되어 있으나, 실질 검증 변경은 이 테스트다.)
- 테스트가 어떻게 픽스를 증명하는지: `@override_settings(INSTALLED_APPS=['migrations', 'migrations2'])`로 앱 구성을 고정하고, `allow_migrate`를 mock 처리한다. 기존 `assert_called_with`를 `assert_any_call`로 완화한 뒤, **모든 호출**(`allow_migrate.mock_calls`)을 순회하며 각 호출의 `connection_alias`가 `['default','other']`에 속하고, `apps.get_app_config(app_name).get_model(call_kwargs['model_name'])`가 예외 없이 통과하는지 확인한다. 즉 전달된 모든 (app_name, model_name) 쌍이 실제로 그 앱에 존재하는 유효 조합임을 강제한다 — 버그 코드에서는 다른 앱의 모델이 섞여 `get_model`이 `LookupError`를 던진다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement의 키워드가 매우 직접적이다. `makemigrations.py`에서 `allow_migrate`를 호출하는 제너레이터/루프를 찾고, 모델 순회 소스(`apps.get_models(...)` vs `get_app_config(...).get_models()`)를 점검하면 된다.
- 함정/난이도 메모: 핵심은 `apps.get_models(app_label)`가 "그 앱의 모델"을 준다고 착각하기 쉽다는 점이다. 실제로 `Apps.get_models()` 시그니처는 앱 필터 인자를 받지 않으므로 `app_label`이 silently 잘못 쓰인다. 단일 파일·단일 라인 수정이지만 의미적 함정(전체 vs 앱-국소)이 본질이다.
- 우리 에이전트 관점: 1줄 diff라 패치 자체는 쉽지만, "왜 잘못인지"를 이해하려면 Django의 `Apps.get_models` API 계약을 정확히 알아야 한다. 그냥 grep으로 `allow_migrate`만 찾고 끝내면 올바른 교체 형태(`get_app_config().get_models()`)를 떠올리지 못할 수 있고, 테스트가 모든 mock_call을 검사하므로 부분적 수정으로는 통과하지 못한다.
