---
instance_id: django__django-11740
repo: django/django
base_commit: 003bb34b218adb23d1a7e67932a6ba9b3c4dcc81
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-09-03T10:44:38Z
fail_to_pass: 1
pass_to_pass: 109
gold_files: [django/db/migrations/autodetector.py]
---

# django__django-11740

## 문제 요약
UUIDField(혹은 IntegerField 등 비-relation 필드)를 다른 앱의 모델을 가리키는 ForeignKey로 바꾸면, makemigrations가 생성하는 `AlterField` 마이그레이션이 참조 대상 앱에 대한 `dependencies`를 만들지 않는다. 그 결과 마이그레이션 실행 시 `ValueError: Related model 'testapp2.App2' cannot be resolved.`가 발생한다. 사용자는 FK로 바뀌었으니 대상 앱(App2)에 대한 의존성이 자동으로 추가되기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (relation으로 전환 시 dependency 누락) / edge-case
- 서브시스템: django migrations autodetector (makemigrations 변경 감지)
- 증상 타입: 크래시 (마이그레이션 적용 시점 ValueError) — 생성 단계는 silent-wrong, 적용 단계에서 폭발
- 로컬라이제이션 신호: problem_statement의 "does not create any dependencies for App2" + hints_text가 직접 `MigrationAutodetector.generate_altered_fields`의 `add_operation` 호출과 `self._get_dependencies_for_foreign_key(new_field)`를 지목

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/autodetector.py` : `MigrationAutodetector.generate_altered_fields`
- 근본 원인: `generate_altered_fields`는 필드가 변경됐을 때 `AlterField` 오퍼레이션을 `add_operation`으로 추가하는데, AddField 경로와 달리 새 필드가 relation으로 바뀐 경우에도 dependencies를 전혀 계산해 넘기지 않았다. 그래서 새로 생긴 FK 대상 앱이 의존성 그래프에 들어가지 않음.
- 수정 요지:
  - 루프 본문 시작에서 `dependencies = []`를 초기화.
  - 기존에 `new_field.remote_field.model`이 있는 분기(FK/relation 처리 블록) 끝에 `dependencies.extend(self._get_dependencies_for_foreign_key(new_field))`를 추가해, 참조 대상 앱의 최신 마이그레이션에 대한 의존성을 수집.
  - 최종 `self.add_operation(... operations.AlterField(...))` 호출에 `dependencies=dependencies` 인자를 전달.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_alter_field_to_fk_dependency_other_app`
- 새 픽스처 `book_with_no_author_fk`는 `otherapp.Book`의 `author`를 `IntegerField`로 정의(비-relation). 테스트는 이 상태에서 `book`(author가 `testapp.Author`를 가리키는 FK) 상태로 변경을 감지시킨다.
- 검증 흐름: `otherapp`에 마이그레이션 1개 생성 → 오퍼레이션 타입이 `['AlterField']` → 그 마이그레이션의 dependencies가 `[('testapp', '__first__')]`를 포함하는지 단언. 픽스 전에는 이 dependency가 비어 있어 단언이 실패하고, `_get_dependencies_for_foreign_key`를 통해 추가되면서 통과한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `autodetector.py`의 `generate_altered_fields`. AddField가 의존성을 어떻게 넘기는지(`generate_added_fields` / `_generate_added_field`)와 비교하면 누락 지점이 바로 드러난다. `_get_dependencies_for_foreign_key`는 이미 존재하는 헬퍼라 재사용만 하면 됨.
- 함정/난이도 메모: dependency를 추가하는 위치가 핵심. `remote_field.model` 분기 안(실제 FK일 때)에서만 extend해야 m2m/through나 비-relation 변경에서 잘못된 의존성이 끼지 않는다. 또한 hints가 강조하듯 참조 앱의 `__first__`/initial이 아니라 "최신" 마이그레이션을 가리켜야 하는데, 이는 `_get_dependencies_for_foreign_key`가 이미 처리하므로 직접 손대지 않는 게 정답.
- 우리 에이전트 관점: 단일 파일·단일 함수·기존 헬퍼 재사용이라 난이도는 낮지만, 함정은 (1) 버그 재현이 마이그레이션 "생성"이 아니라 "적용" 단계에서 터진다는 점 — 생성 결과를 그냥 보면 정상처럼 보여 오진하기 쉽고, (2) AlterField 호출이 if/else 두 갈래(m2m vs concrete)로 나뉘어 있어 dependencies를 어느 분기에 넘길지 헷갈릴 수 있다. PASS_TO_PASS 107개가 모두 같은 테스트 파일이라 회귀 검출이 촘촘하므로, dependency를 과도하게 끼우면 다른 의존성 단언 테스트가 깨진다.
