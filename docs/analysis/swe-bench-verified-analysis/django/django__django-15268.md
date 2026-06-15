---
instance_id: django__django-15268
repo: django/django
base_commit: 0ab58c120939093fea90822f376e1866fc714d1f
version: 4.1
difficulty: 1-4 hours
created_at: 2022-01-01T09:57:13Z
fail_to_pass: 3
pass_to_pass: 130
gold_files: [django/db/migrations/operations/models.py]
---

# django__django-15268

## 문제 요약
#31503에서 `AlterUniqueTogether`/`AlterIndexTogether`(AlterFooTogether)를 "기존 제약 제거 → 새 제약 추가" 두 단계로 쪼개도록 바꿨다. 그 결과 같은 모델에 대해 `unique_together=set()`으로 비우는 연산과 `unique_together={("col",)}`로 다시 채우는 연산이 연달아 나오는데, 이 둘은 사실 하나로 합쳐질 수 있다. 사용자는 마이그레이션 옵티마이저가 이 잉여 쌍을 단일 연산으로 줄여주길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (optimizer reduce 로직 미흡으로 인한 최적화 누락)
- 서브시스템: django migrations / operations optimizer (autodetector가 생성한 연산 시퀀스 reduce)
- 증상 타입: 잘못된 출력 (불필요하게 4개 연산 생성, 2개로 줄지 않음)
- 로컬라이제이션 신호: problem_statement가 "reduce", "AlterFooTogether", "optimize ... into one"을 명시 → 마이그레이션 연산의 `reduce()` 로직, 즉 `db/migrations/operations/models.py`로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/models.py` — `ModelOptionOperation.reduce()`, 신규 `ModelOptionOperation.can_reduce_through()`, 신규 `AlterTogetherOptionOperation.can_reduce_through()`
- 근본 원인: 기존 `reduce()`는 "뒤 연산이 이 모델을 참조하지 않을 때만"(`not operation.references_model(...)`) 통과시켰다. 그런데 또 다른 AlterFooTogether 연산은 같은 모델을 참조하므로 절대 reduce되지 못해, 비우기/채우기 쌍이 항상 둘로 남았다.
- 수정 요지: reduce 조건의 후반부를 `can_reduce_through()` 후크 메서드로 추출하여 서브클래스가 확장 가능하게 만들었다. `AlterTogetherOptionOperation`이 이를 오버라이드해 "상대 연산이 AlterTogether 계열이면서 나와 타입이 다를 때"(`isinstance(operation, AlterTogetherOptionOperation) and type(operation) is not type(self)`)도 reduce를 허용한다. 즉 같은 모델을 참조해도 서로 다른 종류(Unique vs Index)의 AlterTogether면 사이를 통과해 합쳐질 수 있다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `test_foo_together_ordering`, `test_remove_field_and_foo_together`, `test_rename_field_and_foo_together` 세 케이스에서 autodetector가 만드는 AlterTogether 연산 개수.
- 테스트가 어떻게 픽스를 증명하는지: 기존 테스트는 `AlterUniqueTogether(set())` + `AlterIndexTogether(set())` + `AlterUniqueTogether({...})` + `AlterIndexTogether({...})` 4개를 기대했다. 패치 후 테스트는 빈 set으로 비우는 두 연산이 사라지고, 최종값을 가진 `AlterUniqueTogether({('title','author')})` + `AlterIndexTogether(...)` 2개만 남는 것을 단언한다(`assertOperationTypes` 리스트가 4→2로 축소, 인덱스 재정렬). remove/rename 케이스도 같은 방식으로 잉여 비우기 연산이 제거됨을 확인한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement의 "reduce"·"AlterFooTogether" 키워드로 `operations/models.py`의 `ModelOperation.reduce`/`ModelOptionOperation`/`AlterTogetherOptionOperation` 클래스 계층을 먼저 읽는다. autodetector(`autodetector.py`)가 아니라 옵티마이저 reduce가 핵심이다.
- 함정/난이도 메모: 단일 파일 수정이지만 클래스 상속 구조(`ModelOperation` → `ModelOptionOperation` → `AlterTogetherOptionOperation` → `AlterUniqueTogether`/`AlterIndexTogether`)를 정확히 이해해야 한다. `super().reduce()` 단락 평가와 신규 후크의 `super().can_reduce_through()` OR 체인을 깨면 다른 연산의 reduce가 깨진다. `type(operation) is not type(self)` 조건이 미묘 — 같은 타입끼리(Unique+Unique)는 합치면 안 되고 교차 타입만 통과시켜야 한다.
- 우리 에이전트 관점: reduce 조건을 단순히 `references_model` 체크를 제거하는 식으로 과하게 풀면 PASS_TO_PASS(134개, `Fields are altered after deleting some index/unique_together` 등 순서 보장 테스트들)가 깨진다. 옵티마이저가 두 단계 분리를 일부러 유지하는 다른 시나리오를 망가뜨리지 않도록 "교차 타입 AlterTogether만" 범위를 정확히 좁히는 것이 관건. 후크 메서드 추출 없이 인라인으로 처리하면 가독성/회귀 위험이 커진다.
