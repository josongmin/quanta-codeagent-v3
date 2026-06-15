---
instance_id: django__django-15973
repo: django/django
base_commit: 2480554dc4ada4ecf3f6a08e318735a2e50783f3
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-08-19T18:10:02Z
fail_to_pass: 1
pass_to_pass: 157
gold_files: [django/db/migrations/autodetector.py]
---

# django__django-15973

## 문제 요약
ManyToManyField의 `through` 모델을 별도 앱에 정의하면 마이그레이션 적용 시 `AttributeError: 'str' object has no attribute '_meta'`가 발생한다. 사용자는 fonte/variavel/fonte_variavel 세 앱으로 모델을 쪼갰고, m2m 필드는 fonte에, through 모델(FonteVariavelModel)은 fonte_variavel에 두었다. 이때 생성된 마이그레이션의 dependencies에 through 모델 앱이 빠져서, 실제 적용 단계(`schema_editor.create_model`)에서 through가 문자열인 채로 남아 `_meta` 접근이 터진다. through 모델을 같은 앱에 두면 정상 동작한다.

## 유형 분류
- 버그 카테고리: 누락처리 (의존성 누락) / logic
- 서브시스템: django db migrations autodetector (의존성 계산)
- 증상 타입: 예외 (AttributeError, 마이그레이션 적용 시점)
- 로컬라이제이션 신호: 트레이스백 끝은 `schema.py`의 `field.remote_field.through._meta`지만, 근본은 "생성된 마이그레이션 dependencies에 through 앱이 없다"는 점. 즉 스키마 단계가 아니라 마이그레이션을 만드는 autodetector의 FK 의존성 계산이 진범. "putting everything in same app works"는 곧 의존성/앱 경계 문제라는 강한 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/autodetector.py` : `MigrationAutodetector._get_dependencies_for_foreign_key`
- 근본 원인: through 모델이 있을 때 `resolve_relation`에 m2m의 **타깃 모델**(`remote_field_model`)을 넘기고 있었다. through 의존성을 계산해야 하는데 엉뚱하게 m2m가 가리키는 to 모델을 resolve 했으므로, through 모델이 속한 앱이 의존성에 포함되지 않았다. 결과적으로 마이그레이션 dependencies가 through 앱을 누락 → 적용 순서가 어긋나 through가 아직 문자열 참조인 상태로 create_model에 도달.
- 수정 요지: `if getattr(field.remote_field, "through", None):` 분기 안에서 `resolve_relation(remote_field_model, ...)`을 `resolve_relation(field.remote_field.through, ...)`로 교체. 한 줄 변경으로 through 모델 자신을 resolve 하여 올바른 through 앱/객체명을 dependency로 등록한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_create_with_through_model_separate_apps` — m2m 필드(authors.Author.publishers, to=testapp.Publisher, through=contract.Contract)와 through 모델(contract.Contract)을 서로 다른 앱에 두고 autodetector를 돌린다.
- 증명 방식: 픽스 전이면 authors의 AddField 마이그레이션 dependencies에 contract 앱이 빠진다. 테스트는 `assertMigrationDependencies(changes, "authors", 1, {("authors","auto_1"), ("contract","auto_1"), ("testapp","auto_1")})`로 contract 앱 의존성이 들어왔음을 단언한다. 또 authors=2개, contract=1개, testapp=1개 마이그레이션 수와 각 CreateModel/AddField 연산을 검증해, through가 별도 앱이어도 의존성과 적용 순서가 올바르게 잡히는지 확인한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 트레이스백 표면(schema.py의 `_meta`)에 낚이지 말 것. "같은 앱이면 동작"이라는 단서가 autodetector의 의존성 계산을 가리킨다. `_get_dependencies_for_foreign_key`에서 `through` 처리 분기를 보면 `remote_field_model` vs `field.remote_field.through` 차이가 바로 보인다.
- 함정/난이도: 단일 라인 수정이지만, `remote_field_model`이 함수 상단에서 이미 계산되어 있어 그걸 재사용하는 게 자연스러워 보인다 — through 분기에서는 의도가 다르다는 걸 알아채야 한다. 멀티파일 아님(autodetector 단일 파일).
- 우리 에이전트 관점: 예외 트레이스백만 보고 schema.py의 `create_model`이나 `_meta` 접근부를 방어 코드로 땜질하려 들면 오답. 증상 발생 지점(적용)과 결함 발생 지점(마이그레이션 생성)이 분리돼 있어, "같은 앱은 되고 다른 앱은 안 됨" 차이를 의존성 누락으로 환원하는 추론이 핵심 관문이다.
