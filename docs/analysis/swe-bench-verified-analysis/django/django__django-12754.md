---
instance_id: django__django-12754
repo: django/django
base_commit: 18759b2209ff556aed7f20d83cbf23e3d234e41c
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-04-19T10:59:30Z
fail_to_pass: 1
pass_to_pass: 112
gold_files: [django/db/migrations/autodetector.py]
---

# django__django-12754

## 문제 요약
모델 서브클래스를 새로 만들면서 같은 스텝에서 필드를 베이스 모델로부터 서브클래스로 옮기면, `makemigrations`는 성공하지만 `migrate` 실행 시 `FieldError: Local field 'title' in class 'Book' clashes with field of the same name from base class 'Readable'`로 죽는다. 자동 감지기가 `CreateModel(Book)` → `RemoveField(Readable.title)` 순서로 마이그레이션을 생성하는데, Book이 만들어지는 시점엔 아직 Readable.title이 남아 있어 필드 충돌이 난다. 사용자는 자동 감지기가 두 연산 순서를 뒤집어(RemoveField 먼저, CreateModel 나중) 적용 가능한 마이그레이션을 만들어 주길 기대했다.

## 유형 분류
- 버그 카테고리: logic (연산 의존성/순서 누락) + 누락처리
- 서브시스템: django migrations / autodetector (스키마 연산 의존성 그래프)
- 증상 타입: 크래시 (migrate 시 FieldError)
- 로컬라이제이션 신호: problem_statement이 "auto-detector should be able to use this order"라 직접 자동 감지기를 지목하고, hints에서 Simon Charette가 `generate_created_models`와 의존성 표현 `(base_app_label, base_model_name, field_name, False)`를 정확히 명시. 충돌하는 필드명 `title`이 그대로 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/autodetector.py` : `generate_created_models()`
- 근본 원인: 생성될 모델이 MTI 베이스(`bases`에 `"app.readable"` 같은 문자열)를 가질 때, 코드는 베이스 모델 자체에 대한 의존성 `(base_app_label, base_name, None, True)`만 추가했다. 베이스에서 제거되는 필드와 서브클래스에서 새로 추가되는 필드가 이름이 겹치는 경우, "그 필드의 RemoveField가 CreateModel보다 먼저 실행되어야 한다"는 의존성이 없어 자동 감지기가 임의(생성 먼저) 순서로 배치 → 런타임 필드 충돌.
- 수정 요지: 베이스 의존성을 추가한 직후, `from_state`(이전 상태)와 `to_state`(현재 상태)에서 베이스 모델 상태를 가져와 `old_base_model_state.fields`에서 `new_base_model_state.fields`를 뺀 "베이스에서 제거된 필드" 집합을 구하고, 이를 다시 새 서브클래스의 `model_state.fields`와 교집합한다(겹치는 필드만). 각 `removed_base_field`에 대해 `(base_app_label, base_name, removed_base_field, False)` 의존성을 추가해, 해당 필드의 RemoveField가 이 CreateModel보다 먼저 오도록 강제한다. `from_state`를 써야 제거 전 필드를 볼 수 있는 점이 핵심(`to_state`엔 이미 사라짐).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_add_model_with_field_removed_from_base_model` — Readable(title 보유) → Readable(필드 없음) + Book(bases=`app.readable`, title 보유)로 바뀔 때 연산 순서를 검증.
- 증명 방식: before/after ModelState를 `get_changes()`에 넣고 단일 마이그레이션이 나오는지(`assertNumberMigrations 1`), 연산 타입이 정확히 `['RemoveField', 'CreateModel']` 순인지(`assertOperationTypes`), 첫 연산이 `model_name='readable', name='title'`의 RemoveField이고 둘째가 `name='book'` CreateModel인지(`assertOperationAttributes`) 확인. 픽스 전이면 순서가 `['CreateModel', 'RemoveField']`로 뒤집혀 fail.

## 공략 포인트 (뭘 조져야)
- 어디부터: `autodetector.py`의 `generate_created_models` 내 `bases` 처리 루프(문자열 베이스 `"app.model"` 분해 후 의존성 append 지점, 약 563번 라인). 의존성 튜플 4번째 요소 `True/False`(모델 생성 여부 vs 필드 변경 여부)의 의미를 이해해야 함.
- 함정/난이도: (1) `to_state`에서 베이스 필드를 찾으면 이미 제거되어 비어 있음 — 반드시 `from_state` 사용. (2) 키 튜플 `(app_label, name)`은 소문자여야 조회됨. (3) 두 서브클래스(Book, Magazine)가 같은 필드를 동시에 옮길 때 RemoveField가 중복 생성되면 안 됨 — 의존성은 같은 `(base, base, field, False)`를 가리키므로 단일 RemoveField에 수렴(이미 처리됨, 추가 dedup 불필요). 멀티파일 아님(단일 파일·단일 함수).
- 우리 에이전트 관점: 막힐 지점은 "충돌 자체를 고친다"는 오판이다. 진짜 픽스는 필드 충돌 회피가 아니라 마이그레이션 연산 순서를 바꾸는 의존성 추가다. 의존성 그래프 표현(4-튜플 시맨틱)과 `from_state`/`to_state` 구분을 모르면 엉뚱한 곳(operations 실행기, MTI 베이스 검증)을 건드릴 위험. 또 difference→intersection 2단계 집합 연산(베이스에서 빠졌고 AND 서브클래스에 들어온 필드만)을 정확히 좁혀야 false 의존성을 안 만든다.
