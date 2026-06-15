---
instance_id: django__django-12741
repo: django/django
base_commit: 537d422942b53bc0a2b6a51968f379c0de07793c
version: "3.1"
difficulty: <15 min fix
created_at: 2020-04-17T22:35:55Z
fail_to_pass: 2
pass_to_pass: 67
gold_files: [django/core/management/commands/flush.py, django/db/backends/base/operations.py]
---

# django__django-12741

## 문제 요약
`DatabaseOperations.execute_sql_flush(self, using, sql_list)`의 시그니처에서 `using` 인자가 불필요하다는 리팩터링 요청이다. `using`(데이터베이스 alias)은 호출하는 인스턴스가 이미 `self.connection.alias`로 알고 있으므로 추론 가능하다. 실제로 내부 호출부 일부가 `connection.ops.execute_sql_flush(connection.alias, sql_list)`처럼 자기 alias를 중복 전달하는 패턴을 쓰고 있었다. 기대 동작은 시그니처를 `execute_sql_flush(self, sql_list)`로 단순화하는 것이다.

## 유형 분류
- 버그 카테고리: API-contract (시그니처 단순화 리팩터링; 기능 버그 아님)
- 서브시스템: django db backends operations / management command (flush)
- 증상 타입: 없음 — 동작상 문제 없음, 중복(redundant) 인자 제거 목적의 클린업
- 로컬라이제이션 신호: problem_statement가 메서드명 `execute_sql_flush`와 파일 위치(`DatabaseOperations`)를 명시하고, `self.connection.alias`를 직접 언급해 수정 지점을 사실상 지목한다.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/base/operations.py`:`BaseDatabaseOperations.execute_sql_flush`
  - `django/core/management/commands/flush.py`:`Command.handle`
- 근본 원인: 버그가 아니라 설계 중복. `using` 파라미터로 받던 값이 항상 `self.connection.alias`와 동일했고, 호출부에서 `connection.ops.execute_sql_flush(connection.alias, sql_list)`로 자기 alias를 되넘기는 잉여 코드가 존재.
- 수정 요지:
  1. `execute_sql_flush(self, using, sql_list)` → `execute_sql_flush(self, sql_list)`로 파라미터 제거.
  2. 내부에서 `transaction.atomic(using=using, ...)`를 `transaction.atomic(using=self.connection.alias, savepoint=self.connection.features.can_rollback_ddl)`로 변경해 alias를 인스턴스에서 직접 추론.
  3. flush 커맨드의 호출부 `connection.ops.execute_sql_flush(database, sql_list)`를 `connection.ops.execute_sql_flush(sql_list)`로 갱신.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_execute_sql_flush_statements` (backends.base.test_operations.SqlFlushTests)
  - `test_sequence_name_length_limits_flush` (backends.tests.LongNameTest)
- 두 테스트 모두 호출부를 `connection.ops.execute_sql_flush(connection.alias, sql_list)` → `connection.ops.execute_sql_flush(sql_list)`로 바꾼다. 즉 신규 시그니처로 호출했을 때 정상 동작(테이블 비워짐, 시퀀스 리셋)이 유지되는지를 증명한다. 구 시그니처가 남아 있으면 인자 개수 불일치로 `TypeError`가 나므로 픽스 적용 여부가 곧 통과/실패를 가른다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `execute_sql_flush` 정의(operations.py) 1곳 + grep으로 전 호출부 찾기. `git grep execute_sql_flush`면 정의·관리커맨드·테스트가 한 번에 잡힌다.
- 함정/난이도 메모: 멀티파일(2개 src + 2개 test)이지만 변경은 기계적. `using` 제거 후 `transaction.atomic(using=...)`에 `self.connection.alias`를 다시 넣는 것을 빠뜨리면 미묘하게 깨질 수 있음(현재 alias 대신 default DB로 트랜잭션이 걸림). flush.py 호출부의 변수명이 `database`라 `using`과 시각적으로 다른 점도 누락 위험.
- 우리 에이전트 관점: 난이도 <15분짜리 순수 리팩터링이라 막힐 지점은 거의 없음. 유일한 리스크는 호출부를 전수로 못 찾아 일부만 고치는 것 — 정의만 바꾸고 flush.py 호출부를 빠뜨리면 런타임 TypeError. grep-기반 전수 탐색만 하면 안전하게 닫힌다.
