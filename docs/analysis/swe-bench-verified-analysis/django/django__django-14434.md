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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-14434

## 문제 요약
`_create_unique_sql`이 만든 `Statement` 객체에서 `references_column()`이 항상 `False`를 반환한다. 원인은 컬럼/표현식 참조 추적용 헬퍼(`Columns`/`Expressions`/`IndexName`)에 **문자열 테이블 이름**이 와야 할 자리에 `Table` 인스턴스가 전달되기 때문이다. 사용자는 생성된 UNIQUE 제약 SQL이 자기 테이블/컬럼을 올바르게 참조한다고(`references_table`/`references_column`이 `True`) 기대하는데, 컬럼 참조 판정이 조용히 깨져 있었다. 이 참조 추적은 deferred SQL 재작성(테이블/컬럼 rename 시 보류 SQL 갱신)에 쓰이므로, 깨지면 후속 스키마 연산에서 잘못된 SQL이 남을 수 있다.

## 유형 (정형화)

**L (Localization) = L0 — Pinpointed.** problem_statement가 `_create_unique_sql`라는 함수명과 "Table 인스턴스가 Columns에 string 기대 자리로 전달"이라는 정확한 근본원인까지 명시한다. grep 한 방으로 `django/db/backends/base/schema.py`의 단일 함수에 직행한다. 탐색 노력이 거의 0.

**S (Repair Strategy) = S2 (Constraint-Reasoning) + S5 보조.** 고칠 위치는 자명하지만(L0), 올바른 픽스는 기계적 가드/기본값 교체가 아니다. `Table` 래퍼 객체가 어떤 인자들(`IndexName`, `Expressions`, `_index_columns`)로 흘러가야 하고, 어디는 raw 문자열이어야 하며, 어디는 여전히 `Table` 인스턴스를 원하는지(최종 `Statement(table=...)`의 quoting)를 **불변식 추론으로 분리·합성**해야 한다. "문자열 자리엔 문자열, quoting 출력 자리엔 `Table`"이라는 두 역할을 구별하는 게 핵심이라 S2다. 이 두 역할의 계약(`references_column`이 컬럼의 `table` 속성을 `db_table` 문자열과 `==` 비교)은 코드 관례에서 재구성해야 하므로 S5를 보조로 단다.

**K (Knowledge) = K-Domain.** django schema editor의 DDL 생성 파이프라인, `Statement`/`Table`/`Columns`/`Expressions`/`IndexName`의 ddl_references 추상화, deferred SQL 참조 추적이라는 프레임워크 내부 지식이 병목이다. 일반 파이썬 추론만으론 "왜 `Table` 인스턴스가 `==` 비교를 깨는지"를 알 수 없다.

**Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 픽스가 기계적 S1이 아니라 S2 추론 합성이 본질이다. 무지성으로 `Table`을 전부 문자열로 바꾸면 quoting 회귀가 나고, 안 바꾸면 버그가 남는다 — 올바른 식을 추론으로 짜야 하는 전형적 ConstraintReason. (T-DirectMap이 아닌 이유: S1 템플릿 매칭으로는 quoting 보존을 못 맞춘다. T-DomainBound이 dominant가 아닌 이유: 도메인 지식은 필요조건이지만 진짜 난점은 두 역할 분리 추론이다.)

## 난이도 티어

**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior)이지만, 구조적 피처가 T4로 민다:

- **L0 + S2 조합**: localize는 trivial하나 repair가 constraint-reasoning이다. 1줄짜리 "as-is" 픽스가 아니라 4개 인자의 역할을 재분배하는 의미적 수정.
- **regression-trap (광범위 P2P)**: PASS_TO_PASS가 133개로 매우 넓다. `test_unique_name_quoting`, `test_func_unique_constraint*` 계열, `test_rename_table_renames_deferred_sql_references` 등 quoting·deferred-SQL·func-constraint 인접 동작을 하나도 안 깨야 한다. `Table` 래퍼를 잘못 제거하면 quoting/deferred-rename이 깨진다.
- **cross-file-dep**: 픽스는 schema.py 단일 파일이지만, 정답을 도출하려면 `django/db/backends/ddl_references.py`의 `Table`/`Columns`/`Expressions`/`Statement.references_column` 계약을 읽어야 한다(의미적 cross-file 의존).
- **K-Domain**: ddl_references 추상화 이해가 필수.

공식 라벨이 더 낮은 이유: 라벨은 "개발자 구현시간"이라 문제를 이미 이해한 코어 개발자에겐 빠르다. 하지만 오라클 없는 에이전트에겐 "어떤 인자만 문자열로 돌리고 어디는 `Table`로 유지할지"의 미세 추론 + 넓은 P2P trap이 시간라벨에 안 잡히는 난점이다. (T5가 아닌 이유: 멀티사이트 조율/overfit 고위험은 아니고 단일 헌크 영역. FAIL_TO_PASS가 references_table/column을 직접 단언해 overfit 위험은 낮다.)

## 골드패치 분석

- **건드린 파일/함수**: `django/db/backends/base/schema.py` : `_create_unique_sql` (내부 `create_unique_name` 클로저를 포함하는 영역).
- **근본 원인**: 함수 도입부에서 `table = Table(model._meta.db_table, self.quote_name)`로 **`Table` 인스턴스를 중간 변수 `table`에 담고**, 이 객체를 `IndexName`, `_index_columns`, `Expressions`에 그대로 넘겼다. 이들 헬퍼와 그 결과의 `references_column(table, column)`은 컬럼의 `table` 속성을 raw 문자열 `db_table`과 `==`로 비교하는데, 한쪽이 `Table` 인스턴스이면 `'app_author' == Table('app_author', ...)`가 항상 거짓이 되어 `references_column`이 항상 `False`를 반환한다.
- **수정 요지**: 중간 변수 `table`을 **raw 문자열** `model._meta.db_table`로 바꾼다. `IndexName(table, ...)`과 `Expressions(table, ...)`에 이 문자열을 전달한다. quoting이 필요한 곳은 **최종 출력 한 곳뿐**이므로, `Statement(table=Table(table, self.quote_name))`처럼 호출 시점에만 그 자리에서 `Table`로 감싼다. 즉 "참조 판정용 raw 문자열"과 "DDL 출력용 quoting 래퍼"의 두 역할을 변수 수준에서 분리한다. 컬럼이 든 `columns` 분기(`_index_columns` / `Expressions`)와 이름 생성(`IndexName`) 모두 문자열을 받게 되어 `references_column` 비교가 정상화된다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_unique_constraint (schema.tests.SchemaTests)`.
- **동작/픽스 증명**: `Author` 모델을 생성하고 `UniqueConstraint(fields=['name'], name='name_uq')`를 `add_constraint`로 추가한 뒤, `constraint.create_sql(Author, editor)`로 SQL `Statement`를 얻는다. 그리고 `table = Author._meta.db_table`에 대해 `self.assertIs(sql.references_table(table), True)`와 **핵심으로** `self.assertIs(sql.references_column(table, 'name'), True)`를 단언한다. 픽스 전이면 `references_column`이 `False`라 두 번째 단언에서 정확히 실패한다(`assertIs ... True`라 falsy도 못 통과). 마지막으로 `remove_constraint` 후 `get_constraints(table)`에 제약 이름이 없음을 확인해 add/remove 양방향 경로를 함께 회귀 방지한다.
- **overfit 관점**: 낮음. 테스트가 `references_table`/`references_column`이라는 깨진 계약을 **직접** 단언하므로, special-case로 통과시킬 여지가 작다. CEGIS류 일반화가 필요 없다.
- **regression 관점**: 높음. 133개 P2P가 quoting(`test_unique_name_quoting`), func-constraint(`test_func_unique_constraint*`, `test_composite_func_unique_constraint`), deferred-SQL rename(`test_rename_table_renames_deferred_sql_references`)을 커버한다. `Table` 래퍼를 출력 시점에 보존하는 골드 픽스라야 quoting/deferred 동작이 살아남는다.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement가 함수명 `_create_unique_sql`과 "Table 인스턴스가 Columns(string 기대)에 전달"을 명시 → `django/db/backends/base/schema.py`의 해당 메서드로 직행. 그 안에서 `table = Table(...)`로 만든 객체가 `IndexName`/`_index_columns`/`Expressions`/`Statement`로 어떻게 흐르는지 데이터플로우를 따라간다. 보강으로 `django/db/backends/ddl_references.py`에서 `Statement.references_column`이 컬럼의 `table` 속성을 문자열과 `==` 비교함을 확인한다.

2. **픽스와 올바른 일반화인 이유**: 중간 변수 `table`을 raw 문자열(`model._meta.db_table`)로 바꾸고, `IndexName`/`Expressions`에 문자열을 넘기며, `Table(table, self.quote_name)` 래핑은 최종 `Statement(table=...)` 인자에서만 한다. 이게 올바른 일반화인 이유: 버그는 "참조 추적용 식별자(문자열)"와 "SQL 출력용 quoting(Table)"이라는 **두 역할이 한 변수에 섞인** 것이라, 두 역할을 변수 수준에서 분리하면 단일 컬럼·복합·표현식·func 제약 등 모든 경로에서 일관되게 옳다. 특정 테스트 입력에 맞춘 미봉이 아니다.

3. **regression 안전**: quoting 보존이 생명. `Statement(table=Table(table, self.quote_name))`로 출력 래퍼를 유지해야 `test_unique_name_quoting`(대문자/특수문자 테이블·제약명 quoting)이 안 깨진다. `Expressions`/func 경로도 동일 문자열을 받게 해야 `test_func_unique_constraint*`, `test_composite_func_unique_constraint`가 통과한다. deferred SQL 참조 추적이 정상화되어야 `test_rename_table_renames_deferred_sql_references`도 안전하다.

4. **함정 회피**: 오라클 없는 에이전트의 최대 실수는 (a) "`Table`이 문제니 전부 문자열로 교체" → 최종 `Statement`에서 quoting이 사라져 P2P quoting 테스트가 깨짐, 또는 (b) `references_column`만 패치하려 ddl_references의 `==` 비교를 건드림 → 다른 참조 추적까지 망가뜨림. 회피법: `references_column`이 **문자열 식별자 동치**를 가정한다는 계약을 먼저 읽고, "참조용은 문자열·출력용만 `Table`"이라는 역할 분리로 호출부에서만 고친다. 헬퍼 계약(`ddl_references.py`)은 건드리지 않는다.
