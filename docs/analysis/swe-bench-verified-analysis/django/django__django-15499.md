---
instance_id: django__django-15499
repo: django/django
base_commit: d90e34c61b27fba2527834806639eebbcfab9631
version: 4.1
difficulty: <15 min fix
created_at: 2022-03-10T22:32:35Z
fail_to_pass: 1
pass_to_pass: 35
gold_files: [django/db/migrations/operations/models.py]
---

# django__django-15499

## 문제 요약
마이그레이션 최적화(squash) 단계에서 `CreateModel` + `AlterModelOptions`는 이미 옵션이 합쳐진 단일 `CreateModel`로 축약된다. 같은 패턴으로 `CreateModel` + `AlterModelManagers`도 managers가 합쳐진 단일 `CreateModel`로 축약될 수 있는데, 이 reduce 케이스가 누락되어 있다. 사용자는 두 operation이 하나로 병합되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (missing optimization case)
- 서브시스템: django migrations / migration optimizer (operations reduce)
- 증상 타입: silent-wrong (틀린 결과는 아니지만 최적화가 안 되어 불필요하게 두 operation이 남음)
- 로컬라이제이션 신호: "migration optimization", "CreateModel + AlterModelOptions is reduced to just CreateModel" 이라는 문구가 곧바로 `CreateModel.reduce()`의 `AlterModelOptions` 분기로 안내한다. 그 옆에 `AlterModelManagers` 분기를 추가하는 문제.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/models.py` : `CreateModel.reduce()`
- 근본 원인: `CreateModel.reduce()`에 `AlterModelOptions`, `AlterTogetherOptionOperation`, `AlterModelTable` 등 동일 모델을 대상으로 한 operation을 흡수하는 분기는 있었지만 `AlterModelManagers`를 흡수하는 분기는 빠져 있었다. 그래서 옵티마이저가 이 조합을 병합하지 못함.
- 수정 요지: `reduce()` 내부에 `isinstance(operation, AlterModelManagers) and self.name_lower == operation.name_lower` 조건의 `elif` 분기를 추가. 매칭되면 기존 `CreateModel`의 `fields`/`options`/`bases`는 그대로 두고 `managers`만 `operation.managers`로 교체한 새 `CreateModel`을 반환한다. 즉 AlterModelOptions 분기를 managers 버전으로 그대로 미러링.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_create_alter_model_managers (migrations.test_optimizer.OptimizerTests)`
- 테스트가 어떻게 픽스를 증명하는지: `assertOptimizesTo()`로 입력 `[CreateModel("Foo", fields=[]), AlterModelManagers(name="Foo", managers=[("objects", Manager()), ("things", Manager())])]`를 주면, 기대 출력은 managers가 합쳐진 단일 `CreateModel("Foo", fields=[], managers=[("objects", ...), ("things", ...)])` 하나뿐임을 단언한다. 픽스 전엔 두 operation이 그대로 남아 길이/내용 불일치로 실패, 픽스 후 한 operation으로 축약되어 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 AlterModelOptions 선례를 직접 명시하므로, `grep AlterModelOptions django/db/migrations/operations/models.py` → `CreateModel.reduce()`의 elif 사다리를 찾으면 거의 즉시 도착.
- 함정/난이도 메모: 단일 파일·단일 함수의 ~13줄 추가. 반환하는 `CreateModel`에서 `managers`만 새 값으로 바꾸고 나머지(`fields`, `options`, `bases`)는 `self`에서 가져와야 함 — `options`를 `operation`에서 가져오는 식의 혼동 주의. 또 `name`은 `self.name`을 유지(케이스 보존). AlterModelManagers는 전체 managers 리스트를 치환(누적 아님)이라 단순 교체로 충분.
- 우리 에이전트 관점: 난이도 낮음. 막힐 만한 지점은 (1) elif 사다리 어디에 끼워넣을지보다 (2) 반환 인자에서 `self.*` vs `operation.*`을 정확히 매핑하는 것. 선행 `AlterModelOptions` 분기를 그대로 복붙해 `options`→`managers`만 바꾸면 정답이라, 패턴 모방으로 안정적으로 해결 가능.
