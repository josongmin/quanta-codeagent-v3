---
instance_id: django__django-13112
repo: django/django
base_commit: 09914ccf688974e068941f55412b930729bafa06
version: 3.2
difficulty: <15 min fix
created_at: 2020-06-26T04:51:38Z
fail_to_pass: 1
pass_to_pass: 63
gold_files: [django/db/models/fields/related.py]
---

# django__django-13112

## 문제 요약
대소문자가 섞인 app 라벨(예: `DJ_RegLogin`)을 가진 앱에서 ForeignKey를 사용하면 Django 3.1b1에서 `migrate`/`makemigrations`가 크래시한다. 증상은 `ValueError: ... lazy reference to 'dj_reglogin.category', but app 'dj_reglogin' isn't installed` 형태로, FK가 가리키는 타깃 참조 문자열이 전체가 소문자로 뭉개져 실제 등록된 mixed-case app 라벨과 매칭되지 않는다. 3.0에서는 정상 동작했던 회귀(regression)다.

## 유형 분류
- 버그 카테고리: regression / edge-case (mixed-case app label 처리 누락)
- 서브시스템: django ORM / migrations state (related field deconstruct)
- 증상 타입: 예외(ValueError) — lazy reference 해소 실패로 크래시
- 로컬라이제이션 신호: 에러 메시지가 `'dj_reglogin.category'`처럼 `app_label.model_name`을 전부 소문자화한 문자열이라는 점, hints가 회귀 커밋 `9e1b6b8a66`을 지목하고 `related.py`의 `deconstruct` 후보 패치를 제시한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/related.py` : `ForeignObject.deconstruct()` (line ~582 부근, `kwargs['to']` 생성 로직)
- 근본 원인: `self.remote_field.model`이 문자열(lazy reference)일 때 무조건 `.lower()`를 호출해 문자열 전체를 소문자화했다. 그 결과 `DJ_RegLogin.Category` 같은 참조가 `dj_reglogin.category`로 변환되어, model_name뿐 아니라 **app_label까지 소문자**가 되어버린다. app 라벨은 마이그레이션에서 대소문자를 구분하므로 이후 lazy reference 해소 시 `dj_reglogin` 앱을 찾지 못해 실패한다.
- 수정 요지: 문자열에 `.`이 있으면 `app_label, model_name = model.split('.')`로 분리해서 model_name만 `.lower()`하고 app_label은 원래 대소문자를 보존한다(`'%s.%s' % (app_label, model_name.lower())`). `.`이 없는(app_label 없는) 경우는 기존처럼 전체를 lower한다. 즉 소문자화 대상을 model_name으로만 좁힌 것.

## 검증 (test_patch)
- FAIL_TO_PASS: `migrations.test_state.StateTests.test_reference_mixed_case_app_label`
- 테스트가 어떻게 픽스를 증명하는지: `app_label = 'MiXedCase_migrations'`(대소문자 혼합)인 `Author`, `Book`(FK), `Magazine`(M2M) 세 모델을 만든다. `ProjectState`에 `ModelState.from_model()`로 등록한 뒤 `project_state.apps.get_models()`를 호출한다. 픽스 전에는 deconstruct가 app_label을 소문자로 만들어 FK/M2M의 lazy reference 해소가 실패(dangling reference ValueError)하지만, 픽스 후에는 app_label이 보존되어 3개 모델이 정상 렌더링되고 `len(... .get_models()) == 3`을 만족한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: 에러 메시지의 `dj_reglogin.category`가 입력 app_label(`DJ_RegLogin`)을 통째로 소문자화한 형태임을 인지 → "어디서 lazy reference 문자열을 소문자화하나"를 grep. `related.py`의 `deconstruct`에서 `self.remote_field.model.lower()`가 유일 후보.
- 함정/난이도 메모: `.lower()`를 전부 제거하면 model_name 정규화가 깨져 다른 테스트(label_lower 일관성)가 회귀할 수 있다 — model_name만 소문자화하는 게 핵심. 또한 `.`이 없는 self-reference나 단순 모델명 케이스를 빠뜨리면 split이 ValueError를 낸다(else 분기 필수). hints에는 split만 있는 더 단순한 버전이 있으나 골드는 `.` 유무 가드를 추가해 더 안전하다.
- 우리 에이전트 관점: 단일 파일/단일 함수 수정이라 멀티파일 추적은 없다. 막힐 지점은 (1) 증상이 `migrate` 런타임 크래시로 표면화되지만 실제 결함은 deconstruct 시점이라는 인과 거리, (2) `.lower()` 전체 제거라는 과도한 수정으로 PASS_TO_PASS 64개를 깨뜨릴 위험. 정답은 소문자화 범위를 model_name으로 좁히고 dot-less 분기를 보존하는 최소 변경이다.
