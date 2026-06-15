---
instance_id: django__django-14434
repo: django/django
base_commit: 5e04e84d67da8163f365e9f5fcd169e2630e2873
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-05-23T12:27:14Z
fail_to_pass: 1
pass_to_pass: 133
gold_files: [django/db/backends/base/schema.py]
---

# django__django-14434

## 문제 요약
`_create_unique_sql`이 만든 `Statement` 객체에서 `references_column()`이 항상 `False`를 반환한다. 원인은 `Columns`/`Expressions`에 문자열 테이블 이름이 와야 할 자리에 `Table` 인스턴스가 전달되기 때문이다. 사용자는 생성된 UNIQUE 제약 SQL이 자기 테이블/컬럼을 올바르게 참조한다고 보고(`references_table`/`references_column`이 `True`) 기대하는데, 컬럼 참조 판정이 깨져 있었다.

## 유형 분류
- 버그 카테고리: 타입 (문자열 기대 자리에 `Table` 객체 전달) / API-contract
- 서브시스템: django DB backend schema editor (DDL SQL 생성, `db/backends/base/schema.py`)
- 증상 타입: silent-wrong (예외는 안 나고 `references_column`이 조용히 항상 `False`)
- 로컬라이제이션 신호: problem_statement가 `_create_unique_sql`와 "Table 인스턴스가 Columns에 string 기대 자리로 전달"을 명시 → `base/schema.py`의 해당 메서드로 바로 직행 가능

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/base/schema.py` : `_create_unique_sql` (내부 `create_unique_name` 클로저 포함 영역)
- 근본 원인: `table = Table(model._meta.db_table, self.quote_name)`로 `Table` 객체를 만들어 두고, 그 객체를 `_index_columns`/`Expressions`/`IndexName`에 그대로 넘겼다. 이들 헬퍼는 테이블 이름이 **문자열**이라고 가정하므로, `Table` 인스턴스가 들어오면 `references_column`이 비교에 실패해 항상 `False`가 된다.
- 수정 요지: `table`을 `model._meta.db_table`(순수 문자열)로 바꾼다. `IndexName`, `Expressions`에 이 문자열 `table`을 전달하도록 인자를 교체한다. `Table` 래핑은 더 이상 중간 변수로 쓰지 않고, 최종 `Statement(table=...)`에 넘길 때만 `Table(table, self.quote_name)`로 그 자리에서 감싼다. 즉 quoting용 `Table` 래퍼와 참조 판정용 raw 문자열을 분리한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_unique_constraint (schema.tests.SchemaTests)`
- 테스트가 어떻게 픽스를 증명하는지: `Author` 모델에 `UniqueConstraint(fields=['name'], name='name_uq')`를 추가하고 `constraint.create_sql(Author, editor)`로 SQL `Statement`를 얻는다. 그 다음 `sql.references_table(table) is True`와 핵심으로 `sql.references_column(table, 'name') is True`를 단언한다. 픽스 전이면 `references_column`이 `False`라 두 번째 단언에서 실패한다. 마지막으로 `remove_constraint` 후 `get_constraints`에 제약 이름이 없음을 확인해 제거 경로도 회귀 방지한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement에 함수명이 박혀 있으므로 `_create_unique_sql`로 직행. 그 안에서 `Table(...)` 인스턴스가 어떤 헬퍼들(`IndexName`, `Expressions`, `_index_columns`)로 흘러가는지 데이터 흐름을 따라가면 된다.
- 함정/난이도 메모: `Table` 래퍼를 무조건 전부 문자열로 바꾸면 안 된다 — 최종 `Statement(table=...)`는 quoting을 위해 여전히 `Table` 인스턴스를 원한다. 정답은 "참조 판정용 raw 문자열"과 "출력용 `Table` 래퍼"를 분리하는 것. 단일 파일/단일 함수 수정이라 멀티파일은 아님.
- 우리 에이전트 관점: 막힐 만한 지점은 `references_column`이 왜 항상 `False`인지 원인 추적. `Statement.references_column`이 컬럼 객체의 `table` 속성을 문자열 `db_table`과 비교하는데, 거기 `Table` 인스턴스가 끼면 `==`가 깨진다는 걸 이해해야 정확히 어떤 인자만 문자열로 돌려야 하는지 판단 가능. 무지성으로 `Table` 제거 시 PASS_TO_PASS(예: `test_unique_name_quoting`)가 깨질 수 있어 quoting 보존이 필요함을 놓치기 쉽다.
