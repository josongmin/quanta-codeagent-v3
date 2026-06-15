---
instance_id: django__django-16901
repo: django/django
base_commit: ee36e101e8f8c0acde4bb148b738ab7034e902a0
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-05-30T05:08:34Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [django/db/models/sql/where.py]
---

# django__django-16901

## 문제 요약
XOR을 네이티브 지원하지 않는 DB(PostgreSQL 등)에서 `Q(...) ^ Q(...) ^ Q(...)`처럼 3개 이상 인자가 있을 때 Django가 생성하는 폴백 SQL이 틀렸다. 올바른 n-ary XOR 의미(그리고 MySQL 같은 네이티브 지원 DB의 의미)는 "참인 피연산자 개수가 홀수일 때 참"(parity)인데, Django의 폴백은 "정확히 하나만 참일 때 참"(exactly-one)으로 해석한다. 그래서 `Q(id=37)`을 3개 XOR하면 1이 나와야 하는데 0이 나온다 (기대값: 1, 0, 1, 0, 1).

## 유형 분류
- 버그 카테고리: logic (잘못된 의미론적 fallback) + edge-case (인자 3개 이상)
- 서브시스템: django ORM query compilation (`sql/where.py`의 XOR fallback)
- 증상 타입: silent-wrong (예외 없이 잘못된 쿼리 결과)
- 로컬라이제이션 신호: problem_statement가 "databases lacking XOR", "fallback SQL", "introduced in #29865"를 명시 → XOR을 SQL로 변환하는 fallback 경로, 즉 `WhereNode.as_sql`의 XOR 분기로 직결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/where.py` : `WhereNode.as_sql`
- 근본 원인: XOR 미지원 DB용 fallback이 `a XOR b XOR ...`를 `(a OR b OR ...) AND (a + b + c + ...) == 1`로 변환했다. `Case(When(c, then=1), default=0)`들의 합이 정확히 1일 때만 참이므로, 이는 "참인 인자가 정확히 1개"를 의미한다. n-ary XOR의 올바른 정의는 "참인 인자 개수가 홀수"이므로 인자가 3개 이상일 때 어긋난다.
- 수정 요지:
  - `from django.db.models.functions import Mod` import 추가.
  - 합계 `rhs_sum`을 구한 뒤, `if len(self.children) > 2:`이면 `rhs_sum = Mod(rhs_sum, 2)`로 감싼다.
  - 결과 조건이 `MOD(a + b + c + ..., 2) == 1`이 되어, 참인 인자 개수가 홀수일 때 참(parity)이 된다.
  - 인자가 2개 이하일 때는 `sum == 1`이 곧 parity와 동일하므로 `Mod`를 적용하지 않아 기존 동작/SQL을 보존한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `xor_lookups.tests.XorLookupsTests.test_filter_multiple`
- 테스트가 어떻게 픽스를 증명하는지: `Q(num__gte=1) ^ Q(num__gte=3) ^ Q(num__gte=5) ^ Q(num__gte=7) ^ Q(num__gte=9)` (XOR 5개)로 필터링한 결과를, 순수 파이썬 parity 식 `(i>=1)^(i>=3)^(i>=5)^(i>=7)^(i>=9)`로 계산한 기대 집합과 `assertCountEqual`로 비교한다. exactly-one 폴백에서는 결과가 비거나 틀리고, parity 폴백(Mod)에서는 일치한다. PASS_TO_PASS의 기존 `test_filter`(XOR 2개) 등은 2개 이하 경로가 변경되지 않음을 보장한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: "XOR fallback" / "databases lacking XOR"라는 표현으로 `django/db/models/sql/where.py`의 `XOR` 분기를 찾는다. `as_sql` 내 `Case(When(...))` + `reduce(operator.add, ...)` + `Exact(1, rhs_sum)` 블록이 정확히 그 fallback 구현이다.
- 함정/난이도 메모:
  - 단일 파일·소수 라인 수정이지만 의미론(parity vs exactly-one)을 정확히 이해해야 한다. `== 1`을 단순히 `>= 1`이나 `% 2 == 1`의 raw SQL로 바꾸려는 유혹이 있으나, 정석은 ORM 표현식 `Mod`를 쓰는 것.
  - 2개 이하에서는 `Mod`를 적용하면 안 됨(불필요한 SQL 변경/회귀). `len(self.children) > 2` 가드가 핵심 디테일.
  - `Mod`는 `django.db.models.functions`에서 import해야 하며, 기존 import(`Case`, `When`, `Exact`)와 다른 모듈이라 누락하기 쉽다.
- 우리 에이전트 관점: fallback 위치 찾기는 단서가 명확해 쉬우나, "참인 개수가 홀수"라는 parity 정의를 정확히 도출하고 이를 합계의 `MOD 2`로 환원하는 추론에서 막힐 수 있다. exactly-one을 그대로 두고 OR 조합을 손대는 잘못된 방향으로 빠질 위험이 있다.
