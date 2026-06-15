---
instance_id: django__django-15695
repo: django/django
base_commit: 647480166bfe7532e8c471fef0146e3a17e6c0c9
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-05-16T07:58:51Z
fail_to_pass: 1
pass_to_pass: 123
gold_files: [django/db/migrations/operations/models.py]
---

# django__django-15695

## 문제 요약
`RenameIndex()` 마이그레이션 연산이 unnamed index(`unique_together`로 자동 생성된 인덱스)를 backward로 되돌린 뒤 다시 forward로 재적용하면 크래시한다. backward 시점에 인덱스 이름이 자동 생성 이름으로 복원되어야 하는데, 그 후 forward를 재실행하면 PostgreSQL에서 `relation "new_pony_test_idx" already exists` 에러가 난다. 사용자는 동일 연산의 apply/un-apply가 멱등(idempotent)하게 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (멱등성 미보장, no-op 가드 누락)
- 서브시스템: django migrations operations (RenameIndex)
- 증상 타입: 예외 / 크래시 (DB ProgrammingError: relation already exists)
- 로컬라이제이션 신호: problem_statement가 `RenameIndex` 클래스와 `tests/migrations/test_operations.py`의 `test_rename_index_unnamed_index`를 직접 지목. hints의 "backward operation은 noop", "idempotency", `SchemaEditor._create_index_name()` 언급이 `RenameIndex.database_forwards/backwards`로 직행.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/models.py` : `RenameIndex.database_forwards`
- 근본 원인: backward 연산이 unnamed old index에 대해 noop으로 처리되어 forward로 새 이름을 붙였던 상태가 그대로 남는다. 따라서 forward를 재적용하면 old_index의 현재 이름이 이미 new_name과 동일한데도 코드가 무조건 RENAME INDEX SQL을 생성해 "이미 존재함" 충돌을 일으킨다.
- 수정 요지: `database_forwards` 안에서 `old_index`를 구한 직후, `old_index.name == self.new_name`이면 즉시 `return`하는 early-return 가드를 추가. 이름이 바뀌지 않는 경우 alter를 아예 수행하지 않아 연산을 멱등하게 만든다(3줄 추가).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_rename_index_unnamed_index` — unnamed index에 대해 forward→backward→forward 재적용 시퀀스가 크래시 없이 통과하고 인덱스 이름이 유지되는지 확인.
- 증명 방식: backward로 되돌린 뒤 `database_forwards`를 다시 호출(`# Reapply, RenameIndex operation is a noop when the old and new name match.`)하고, 그 후 `assertIndexNameExists(table_name, "new_pony_test_idx")`로 인덱스가 정상 존재함을 단언. 가드가 없으면 두 번째 forward가 "relation already exists"로 죽으므로, no-op 처리가 들어가야만 테스트가 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `RenameIndex` 클래스(`models.py`)의 `database_forwards`/`database_backwards` 한 쌍을 먼저 읽는다. backward가 unnamed old index에서 noop이라는 점이 핵심 → forward의 멱등성 결여로 이어진다.
- 함정/난이도 메모: 단일 파일·3줄 패치라 표면적으론 쉽지만, "backward를 고쳐야 하나 forward를 고쳐야 하나" 헷갈리기 쉽다. hints가 backward noop을 "on purpose"라 못 박았으므로 backward 로직 변경이 아니라 forward에 충돌 회피 가드를 넣는 것이 정답. `get_index_by_name`로 가져온 `old_index.name`과 `self.new_name` 비교가 판정 키.
- 우리 에이전트 관점: 막힐 지점은 (1) backward를 건드려 hints 의도(unnamed→named 유지)를 깨는 과교정, (2) DB를 실제로 띄우지 않으면 충돌이 재현되지 않아 `assertNumQueries(0)`/멱등 시나리오를 놓치는 점. 가드 위치를 `old_index`를 양쪽 분기(named/unnamed)에서 확정한 직후로 잡아야 두 경로 모두 커버된다.
