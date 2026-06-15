---
instance_id: django__django-13786
repo: django/django
base_commit: bb64b99b78a579cb2f6178011a4cf9366e634438
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-12-17T21:10:10Z
fail_to_pass: 1
pass_to_pass: 33
gold_files: [django/db/migrations/operations/models.py]
---

# django__django-13786

## 문제 요약
`squashmigrations`가 `CreateModel`과 그 뒤따르는 `AlterModelOptions`를 하나로 최적화(reduce)할 때, 모델 옵션을 "지우지" 못한다. 예컨대 `AlterModelOptions(name="test_model", options={})`처럼 옵션을 비우는 연산이 squash되면, 결과 `CreateModel`에는 기존 옵션이 그대로 남는다. 사용자는 비워진 옵션이 최종 `CreateModel`에서도 제거되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (옵션 제거 로직 부재) / logic
- 서브시스템: django migrations optimizer (operations.models)
- 증상 타입: silent-wrong (예외 없이 잘못된 squash 결과 생성)
- 로컬라이제이션 신호: problem_statement가 `CreateModel.reduce()`와 정확한 파일/라인(`django/db/migrations/operations/models.py`)을 직접 지목하고, `options={**self.options, **operation.options}`라는 버그 표현식과 비교 대상인 `AlterModelOptions.state_forwards()`를 명시. hints_text는 `AlterModelOptions.ALTER_OPTION_KEYS`를 써야 한다고 못박음.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/models.py` : `CreateModel.reduce()` (`isinstance(operation, AlterModelOptions)` 분기)
- 근본 원인: merge 표현식 `{**self.options, **operation.options}`는 dict 병합만 하므로, `operation.options`에 빠진 키(= 사용자가 제거하려는 옵션)는 기존 `self.options` 값이 그대로 살아남는다. 반면 `AlterModelOptions.state_forwards()`는 `ALTER_OPTION_KEYS` 중 새 options에 없는 키를 명시적으로 pop해서 "제거" 의미를 구현한다. reduce()는 이 제거 의미를 복제하지 못했다.
- 수정 요지: 병합 결과 `options`를 만든 뒤, `operation.ALTER_OPTION_KEYS`를 순회하며 `operation.options`에 없는 키를 `options.pop(key, None)`으로 떨어낸다. 그 정제된 `options`를 새 `CreateModel`에 넘긴다. 즉 `AlterModelOptions.state_forwards`의 옵션-제거 시맨틱을 reduce 경로에서 동일하게 재현.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_create_model_and_remove_model_options` (migrations.test_optimizer.OptimizerTests)
- 테스트가 어떻게 픽스를 증명하는지:
  - 케이스1: `CreateModel(options={'verbose_name': 'My Model'})` + `AlterModelOptions(options={})` → 기대 결과 `CreateModel(fields=[])` (옵션 전부 제거). 버그 코드면 verbose_name이 남아 실패.
  - 케이스2: `CreateModel(options={'verbose_name', 'verbose_name_plural'})` + `AlterModelOptions(options={'verbose_name': 'My Model'})` → 기대 결과는 `verbose_name`만 남고 `verbose_name_plural`은 제거. 부분 제거까지 검증.
  - `assertOptimizesTo`로 optimizer를 돌린 squash 결과가 기대 operation 리스트와 정확히 일치하는지 비교.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일·함수·라인을 직접 주므로 `CreateModel.reduce()`의 `AlterModelOptions` 분기를 바로 연다. 참조 모델은 같은 파일의 `AlterModelOptions.state_forwards()` + `ALTER_OPTION_KEYS` 상수.
- 함정/난이도 메모: 단순 dict 병합을 "옵션 덮어쓰기"로만 이해하면 제거 케이스를 놓친다. `ALTER_OPTION_KEYS`(verbose_name, ordering, permissions 등 alter 대상 키 집합)에 한정해서만 pop해야 하며, 그 외 키를 무차별 삭제하면 안 됨. 단일 파일·단일 함수 수정이라 멀티파일 아님.
- 우리 에이전트 관점: 막힐 지점은 "왜 빈 dict가 제거를 의미하는가"를 `state_forwards`와 대조해 파악하는 부분. merge만 고치고 `ALTER_OPTION_KEYS` 한정 pop을 빠뜨리면 케이스2(부분 제거)에서 회귀. 기존 `test_create_alter_model_options`(PASS_TO_PASS)를 깨지 않도록 옵션 추가/유지 시맨틱은 보존해야 함.
