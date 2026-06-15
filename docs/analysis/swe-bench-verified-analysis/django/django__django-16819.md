---
instance_id: django__django-16819
repo: django/django
base_commit: 0b0998dc151feb77068e2387c34cc50ef6b356ae
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-05-01T15:20:04Z
fail_to_pass: 1
pass_to_pass: 38
gold_files: [django/db/migrations/operations/models.py]
---

# django__django-16819

## 문제 요약
마이그레이션 연산 최적화 시 `AddIndex` 뒤에 같은 인덱스에 대한 `RemoveIndex`가 오면 두 연산이 서로를 상쇄하므로 둘 다 제거(reduce)할 수 있어야 한다. 현재 optimizer는 이를 줄이지 못해 같은 인덱스를 추가했다 지우는 불필요한 연산 쌍이 마이그레이션에 그대로 남는다. 사용자는 이런 쌍이 빈 리스트(`[]`)로 최적화되기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (optimizer reduce 규칙 미구현)
- 서브시스템: django migrations / operations optimizer
- 증상 타입: silent-wrong (틀린 건 아니지만 불필요한 연산이 남아 최적화 누락)
- 로컬라이제이션 신호: problem_statement가 "AddIndex/RemoveIndex operations when optimizing"를 명시 → `db/migrations/operations/models.py`의 `AddIndex`/`RemoveIndex`와 optimizer의 `reduce` 메커니즘으로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/models.py` : `AddIndex.reduce` (신규 추가)
- 근본 원인: optimizer는 각 연산의 `reduce(operation, app_label)`를 호출해 뒤따르는 연산과 합칠 수 있는지 묻는다. `AddIndex`에는 이 메서드 오버라이드가 없어 기본 `Operation.reduce`만 타고, 따라서 동일 인덱스를 지우는 `RemoveIndex`가 와도 상쇄 규칙이 없어 두 연산이 모두 보존됐다.
- 수정 요지: `AddIndex`에 `reduce`를 추가. 뒤 연산이 `RemoveIndex`이고 `self.index.name == operation.name`(같은 인덱스 이름)이면 `[]`를 반환해 두 연산을 모두 제거한다. 그 외에는 `super().reduce(...)`로 위임해 기존 동작을 보존한다. 이름 일치만 비교하므로 다른 인덱스 제거에는 영향 없음.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_add_remove_index` — `migrations.test_optimizer.OptimizerTests`에 추가됨.
- 테스트가 어떻게 픽스를 증명하는지: `assertOptimizesTo`로 입력 `[AddIndex("Pony", Index(fields=["weight","pink"], name="idx_pony_weight_pink")), RemoveIndex("Pony", "idx_pony_weight_pink")]`를 주고 기대 결과를 `[]`(빈 리스트)로 단언한다. 픽스 전에는 두 연산이 그대로 남아 `[]`가 아니므로 실패, 픽스 후 `AddIndex.reduce`가 이름 일치를 보고 빈 리스트를 반환해 통과. 39개 PASS_TO_PASS(특히 `test_rename_index`, `test_alter_alter_index_model`)는 인접한 인덱스/필드 최적화가 회귀하지 않음을 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: optimizer가 연산 상쇄를 어떻게 하는지부터 본다. `MigrationOptimizer`가 각 연산의 `reduce()`를 호출하는 구조이므로, "AddX + RemoveX → 없음" 패턴의 기존 사례(예: `AddField`/`RemoveField`, `RenameIndex`의 `reduce`)를 찾아 `AddIndex`에 동일 패턴을 이식하면 된다.
- 함정/난이도 메모: 단일 파일·5줄짜리 변경이라 난이도는 낮음. 다만 비교 키를 `self.index.name == operation.name`으로 잡는 게 핵심 — `RemoveIndex`는 인덱스 객체가 아니라 이름 문자열만 들고 있으므로 `operation.index`가 아닌 `operation.name`을 봐야 한다. 또 `model_name`까지 비교할 필요는 없는데, optimizer가 이미 같은 모델 범위 내에서만 인접 연산을 reduce하기 때문(과도하게 조건을 추가하면 테스트는 통과하나 패턴 불일치).
- 우리 에이전트 관점: 막힐 만한 지점은 "어떤 클래스에 reduce를 넣어야 하는가"의 방향성. 상쇄는 보통 먼저 오는 연산(`AddIndex`) 쪽에 `reduce(RemoveIndex)`로 구현하는 게 Django 관례인데, 거꾸로 `RemoveIndex`에 넣으려다 헤맬 수 있다. `RenameIndex`/`AddField`의 `reduce` 선례를 먼저 grep하면 곧장 풀린다.
