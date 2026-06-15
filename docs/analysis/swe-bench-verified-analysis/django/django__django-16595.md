---
instance_id: django__django-16595
repo: django/django
base_commit: f9fe062de5fc0896d6bbbf3f260b5c44473b3c77
version: 5.0
difficulty: <15 min fix
created_at: 2023-02-24T10:30:35Z
fail_to_pass: 1
pass_to_pass: 37
gold_files: [django/db/migrations/operations/fields.py]
---

# django__django-16595

## 문제 요약
마이그레이션 옵티마이저가 같은 필드에 대한 연속된 여러 `AlterField` 연산을 하나로 합치지 못한다. `AddField`가 함께 있으면 `AlterField`들이 `AddField`로 흡수되어 사라지지만, `AddField`가 분리되어 있는 경우(non-elidable 마이그레이션, 비-squash 마이그레이션 등) `optimizer.optimize(operations[1:], ...)`를 돌리면 `AlterField` 세 개가 그대로 남는다. 사용자는 동일 필드를 반복 변경하는 `AlterField`들이 마지막 하나로 축약되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (옵티마이저 reduce 케이스 미구현)
- 서브시스템: django migrations / migration optimizer (operations.fields)
- 증상 타입: silent-wrong (예외는 없고, 최적화가 일어나야 하는데 안 일어남)
- 로컬라이제이션 신호: problem_statement가 "`AlterField.reduce` does not consider the case where operation is also an `AlterField`"라고 정확히 지목하고, 패치 후보 코드까지 제시. `AlterField` + `reduce` 키워드 = `operations/fields.py`의 `AlterField.reduce`.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/fields.py` : `AlterField.reduce`
- 근본 원인: `AlterField.reduce`의 첫 분기가 `isinstance(operation, RemoveField)`만 검사했다. 후속 연산이 같은 필드에 대한 또 다른 `AlterField`인 경우를 다루지 않아, 동일 필드 변경이 누적될 때 마지막 상태만 남기면 됨에도 모든 중간 `AlterField`가 살아남았다.
- 수정 요지: 해당 분기를 `isinstance(operation, (AlterField, RemoveField))`로 확장. `is_same_field_operation(operation)`이 참이면 `[operation]`(= 뒤쪽 연산)을 반환하여, 같은 필드를 다시 바꾸는 `AlterField`가 들어오면 이전 `AlterField`를 버리고 나중 것으로 collapse한다. `RemoveField`의 기존 흡수 동작은 그대로 유지(동일 반환 경로 재사용).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_alter_alter_field` — 같은 모델/필드(`Foo.name`)에 대한 두 `AlterField`가 두 번째 것으로 collapse되는지 확인.
- 테스트가 어떻게 픽스를 증명하는지: 기존 헬퍼 `_test_alter_alter_model`을 `_test_alter_alter`로 일반화하고, 이 헬퍼는 `[alter_foo, alter_bar]`가 `[alter_bar]` 하나로 최적화됨을 `assertOptimizesTo`로 단언. 신규 `test_alter_alter_field`는 `AlterField("Foo","name", IntegerField())` 와 `AlterField("Foo","name", IntegerField(help_text="help"))`를 입력해 두 번째(help_text 포함) 하나로 축약되는지 검증. 패치 전이면 두 연산이 그대로 남아 실패한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `git grep "def reduce" django/db/migrations/operations/fields.py`로 `AlterField`, `RemoveField`, `RenameField` 각 클래스의 `reduce`를 비교. 다른 Alter 계열(AlterModelTable/UniqueTogether 등)은 이미 "두 번째로 collapse"하는데 `AlterField`만 그 경로가 빠진 비대칭을 포착하면 한 줄 수정으로 직결.
- 함정/난이도 메모: 단일 파일·단일 분기 수정이라 난이도 매우 낮음(<15분). 단 `is_same_field_operation` 가드를 빼먹으면 서로 다른 필드까지 잘못 합쳐 PASS_TO_PASS(RenameField/Remove 상호작용 케이스)가 깨질 수 있음. `RemoveField`의 기존 흡수 동작을 함께 유지해야 함(튜플에 둘 다 포함).
- 우리 에이전트 관점: 막힐 지점은 거의 없음. 위험은 과잉수정 — `elif RenameField` 분기를 건드리거나 collapse 방향을 first가 아닌 second로 한다는 점을 혼동하는 것. problem_statement에 정답 스니펫이 명시되어 있어 오히려 그것을 그대로 채택하되 `RemoveField`와 합쳐 튜플로 묶는 미세 정리만 하면 됨.
