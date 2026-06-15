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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [regression-trap, cross-file-dep]
---

# django__django-12741

## 문제 요약
`BaseDatabaseOperations.execute_sql_flush(self, using, sql_list)`의 시그니처에서 `using` 인자가 잉여라는 리팩터링 요청이다. `using`(데이터베이스 alias)은 호출 인스턴스가 이미 `self.connection.alias`로 알고 있으므로 내부에서 추론 가능하다. problem_statement는 현재/목표 시그니처를 직접 적어주고, 일부 내부 호출부가 `connection.ops.execute_sql_flush(connection.alias, sql_list)`처럼 자기 alias를 되넘기는 중복 패턴까지 명시한다. 기대 동작은 시그니처를 `execute_sql_flush(self, sql_list)`로 단순화하고 모든 호출부를 그에 맞추는 것. 기능 버그가 아니라 공개 API 시그니처 정리(클린업)다.

## 유형 (정형화)

3축 점수:
- **L = L0 (Pinpointed)** — 이슈가 메서드명 `execute_sql_flush`, 정의 클래스(`DatabaseOperations`), 추론 소스(`self.connection.alias`)를 전부 박아준다. `git grep execute_sql_flush` 한 방이면 정의·관리커맨드·테스트가 동시에 잡힌다. 탐색 노력 사실상 0.
- **S = S1 (Direct-Map / template)** — 이슈가 before/after 시그니처를 사실상 명세하므로 픽스가 기계적이다. "파라미터 제거 + 그 파라미터 사용처를 인스턴스 속성으로 치환 + 호출부 전수 갱신"이라는 정형 리팩터링 템플릿(parameter-removal/inline)에 그대로 매칭된다. 추론으로 식을 합성(S2)할 필요도, 후보를 테스트로 수렴(S3)할 필요도 없다.
- **K = K-API (API-contract)** — 공개 메서드 시그니처를 바꾸는 작업이라 호출 계약(인자 개수·이름)을 정확히 맞춰야 한다. 도메인 ORM 내부 추론(K-Domain)은 필요 없고, 깨질 수 있는 건 시그니처 정합성뿐이다.

**primary type = T-DirectMap** — 위치가 L0로 명확하고 픽스가 S1 기계적 매핑이기 때문. T-LocTrivial(L0+S1)에도 근접하나, 단일 한 줄이 아니라 정의 1곳 + 인스턴스-추론 치환 + 호출부 전수(멀티파일) 갱신이 필요해 "찾으면 끝나는 자명한 한 줄"보다는 정확히 위치를 지목해놓고 기계적으로 매핑하는 T-DirectMap이 더 정확하다.

왜 S1인가 (APR 관점): SemFix/Angelix류 constraint-reasoning이 풀어야 할 미지의 불변식·조건식이 없다. 골드 변경은 `using=using` → `using=self.connection.alias`로 동일 alias를 다른 경로로 가져오는 명백한 inline, 그리고 호출부에서 첫 위치인자 삭제뿐이다. 이는 PAR/TBar의 fix-template(파라미터 제거 + 사용처 대체) 적용에 해당하며, 테스트 피드백 반복(G&V)도 불필요하다.

## 난이도 티어

**Tier = T2 (쉬움)**. 공식 라벨 `<15 min fix`(T1 시간대)와 한 단계 차이.

이 티어로 미는 구조적 피처:
- **파일수 = 4 (src 2 + test 2), src 변경 2파일 cross-file.** 정의(operations.py)와 호출부(flush.py)가 함께 바뀌어야 해 단순 1파일 픽스보다 1노치 위. 정의만 고치고 `flush.py` 호출부를 누락하면 런타임 `TypeError`.
- **줄수 ≈ 5줄(헌크 2개), 기계적.** 줄수 컷(<5줄 ≈ 48% solve)상 매우 쉬운 구간이라 T3 이상으로 갈 근거 없음.
- **localize 직접성 = L0.** 이슈가 심볼을 지목 → 탐색 비용 0이라 T3('약한 localize 노력')로도 못 민다.
- **repro 없음 / 도메인 없음.** 네이티브 스택트레이스 없는 리팩터링이지만 동작 버그가 아니라 repro가 원래 무의미하고, ORM 도메인지식도 불요.
- **regression-trap(약).** P2P 67개로 인접 동작 표면이 넓다 — 특히 같은 파일의 `test_sql_flush`, `test_sql_flush_no_tables` 등 `sql_flush` 계열이 안 깨져야 한다. 다만 이들은 시그니처 변경 대상이 아니므로 trap은 "넓지만 얕다". 이 P2P 폭이 T1(존나쉬움, 보통 regression-trap 약함)이 아니라 T2로 올리는 핵심 요인.

공식 `<15 min fix`(≈T1)와 다른 이유: 개발자 구현시간은 정말 15분 미만이 맞지만, 시간라벨은 (a) 멀티파일 cross-file 호출부 전수 누락 위험과 (b) 67개 P2P의 regression 표면을 잡지 못한다. 에이전트 관점에서 "정의만 바꾸고 호출부 빼먹기"라는 실패 모드가 실재하므로 T1이 아니라 T2가 정직하다.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/base/operations.py` : `BaseDatabaseOperations.execute_sql_flush`
  - `django/core/management/commands/flush.py` : `Command.handle`
- 근본 원인: 버그가 아니라 설계 중복. `execute_sql_flush`가 받던 `using` 값이 항상 호출 인스턴스의 `self.connection.alias`와 동일했고, 호출부에서 그 alias를 다시 인자로 되넘기는 잉여 코드가 존재했다.
- 수정 요지:
  1. `def execute_sql_flush(self, using, sql_list)` → `def execute_sql_flush(self, sql_list)`로 `using` 파라미터 제거.
  2. 본문의 `transaction.atomic(using=using, savepoint=self.connection.features.can_rollback_ddl)`를 `transaction.atomic(using=self.connection.alias, savepoint=self.connection.features.can_rollback_ddl)`로 변경 — alias를 인스턴스에서 직접 추론. (이 inline이 픽스의 의미적 핵심: `using`을 단순 삭제만 하면 `atomic`에 alias가 안 들어가 default DB로 트랜잭션이 걸린다.)
  3. `flush.py`의 호출부 `connection.ops.execute_sql_flush(database, sql_list)` → `connection.ops.execute_sql_flush(sql_list)`로 첫 위치인자 삭제(여기서 `database`가 곧 alias였음).

## 검증 (test_patch)
- FAIL_TO_PASS (2개, JSON 배열 길이와 일치):
  - `test_execute_sql_flush_statements` (backends.base.test_operations.SqlFlushTests)
  - `test_sequence_name_length_limits_flush` (backends.tests.LongNameTest)
- 동작: 두 테스트 모두 호출 라인을 `connection.ops.execute_sql_flush(connection.alias, sql_list)` → `connection.ops.execute_sql_flush(sql_list)`로 바꾼다. 즉 신규 시그니처로 호출했을 때 정상 효과(테이블이 비워지고 `Author.objects.exists()`가 False, 긴 시퀀스명 flush가 에러 없이 완료)가 유지되는지를 검증한다.
- 픽스 증명: 구 시그니처(`using` 남김)가 그대로면 신규 1-인자 호출은 위치인자 부족으로 `TypeError`가 나고, 반대로 픽스만 하고 호출부를 안 고치면 2-인자 호출이 과잉인자로 `TypeError`가 난다. 따라서 시그니처와 모든 호출부가 정확히 일치할 때만 통과 — 통과/실패가 픽스 적용 여부에 1:1 대응한다.
- overfit 관점: FAIL_TO_PASS가 2개로 얇지만, 시그니처 변경은 입력공간이 "인자 개수/이름" 하나라 special-case로 통과시킬 여지가 없다. CEGIS류 일반화 부담 없음 → `overfit-risk` 플래그 미부여.
- regression 관점: P2P 67개 중 `test_sql_flush`, `test_sql_flush_no_tables`(SQL 생성부) 등 인접 `sql_flush` 동작이 안 깨져야 한다 — 골드는 `execute_sql_flush`만 건드리고 `sql_flush`(별개 메서드)는 손대지 않으므로 안전. 단, `transaction.atomic(using=...)` inline을 빠뜨리면 멀티-DB 환경에서 alias 누락 회귀가 가능 → `regression-trap` 부여.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `execute_sql_flush`라는 정확한 심볼과 `DatabaseOperations` 클래스를 적어준다 → `git grep -n "execute_sql_flush"`로 정의(`django/db/backends/base/operations.py`)와 전 호출부(`flush.py`, 테스트들)를 한 번에 수집. localize는 사실상 즉시 종결(L0).
2. **픽스와 일반화 정당성**: 정의에서 `using` 파라미터를 제거하고, 본문의 유일한 `using` 사용처인 `transaction.atomic(using=using, ...)`를 `using=self.connection.alias`로 치환. 이게 올바른 일반화인 이유 — 이슈가 명시하듯 호출자는 늘 자기 alias를 넘겼으므로 `using`은 항상 `self.connection.alias`와 동치였다. 즉 외부에서 받던 값을 인스턴스 불변속성으로 inline하는 것이라 어떤 호출 경로에서도 동작이 보존된다(특정 테스트에 맞춘 hack 아님). 이어 `flush.py`의 `execute_sql_flush(database, sql_list)`에서 첫 인자 삭제.
3. **regression 안전**: 별개 메서드 `sql_flush`(SQL 텍스트 생성)는 건드리지 않아 `test_sql_flush*` P2P가 보존된다. `transaction.atomic`에 `self.connection.alias`를 반드시 다시 넣어 멀티-DB 트랜잭션 라우팅을 유지 — 이걸 보장해야 alias 누락 회귀가 안 난다. 시그니처를 바꿨으니 호출부를 전수로 갱신해 어느 경로도 인자 개수 불일치가 없게 한다.
4. **함정 회피**: 오라클 없는 에이전트의 전형 실패는 (a) 정의만 고치고 `flush.py` 호출부 누락 → 런타임 `TypeError`(cross-file-dep), (b) `using`을 삭제만 하고 `atomic(using=...)`에 alias를 다시 안 넣어 default DB로 트랜잭션이 걸리는 조용한 회귀, (c) 호출부 변수명이 `database`라 `using`과 시각적으로 달라 같은 인자임을 놓치는 것. 회피법: 심볼 grep으로 호출부를 전수 확보한 뒤 정의·본문·모든 호출부를 한 묶음으로 동시에 수정하고, 본문에서 `using`이 쓰이던 자리(여기선 `atomic`)를 인스턴스 속성으로 빠짐없이 대체한다.
