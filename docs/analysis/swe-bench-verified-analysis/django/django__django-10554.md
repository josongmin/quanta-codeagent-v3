---
instance_id: django__django-10554
repo: django/django
base_commit: 14d026cccb144c6877294ba4cd4e03ebf0842498
version: 3.0
difficulty: 1-4 hours
created_at: 2018-10-24T14:24:45Z
fail_to_pass: 2
pass_to_pass: 23
gold_files: [django/db/models/sql/compiler.py, django/db/models/sql/query.py]
---

# django__django-10554

## 문제 요약
`union()`으로 합친 QuerySet에 `values_list()`와 `order_by()`를 조합하면, ORDER BY 절이 SELECT 목록에 없는 컬럼을 위치(position)로 참조하면서 SQL 실행이 깨진다. 사용자는 `qs.order_by('-pk').values_list('order', flat=True)` 같은 파생 쿼리가 정상 동작하길 기대했지만, 실제로는 `ProgrammingError: ORDER BY position 4 is not in select list`가 발생한다. 즉 ORDER BY가 SELECT에 없는 컬럼을 `(4)` 같은 정수 위치로 가리켜 DB가 거부한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (combined query + values_list에서 비-select ORDER BY 컬럼 미처리)
- 서브시스템: django ORM query compilation (SQL compiler / Query)
- 증상 타입: 예외 (DatabaseError / ProgrammingError, SQL 실행 실패)
- 로컬라이제이션 신호: traceback 마지막이 `sql/compiler.py`의 `execute_sql`, 그리고 에러 메시지 "ORDER BY position N is not in select list" → ORDER BY를 정수 위치로 변환하는 코드, 즉 `compiler.py`의 `get_order_by()`로 직결된다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py:get_order_by`, `django/db/models/sql/query.py:Query.add_select_col` (신규)
- 근본 원인: combined query(union 등)에서 ORDER BY 표현식은 SELECT 컬럼의 위치 인덱스로 컴파일된다. ORDER BY 컬럼이 select 목록에서 매칭되지 않으면 기존 코드는 무조건 `DatabaseError`를 던지거나, alias 없는 경우에도 select에 추가하지 않아 존재하지 않는 위치 `(4)`를 생성했다.
- 수정 요지: `get_order_by()`의 `for/else` 분기에서 매칭 실패 시, 컬럼에 alias가 있으면 기존대로 에러를 던지지만 alias가 없으면(`col_alias`가 falsy) 그 컬럼을 select 목록에 새로 추가한다. `self.query.add_select_col(src)`로 컬럼을 추가하고, 그 위치를 `RawSQL('%d' % len(self.query.select))`로 ORDER BY에 바인딩한다. `add_select_col`은 `self.select`에 컬럼을 append하고 `values_select`에는 `col.output_field.name`을 함께 추가해 values_list 결과 정합성을 유지한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_union_with_values_list_and_order` — `ReservedName`을 union한 뒤 `order_by`/`values_list` 순서를 바꿔가며(`order_by` 먼저 vs `values_list` 먼저), 단일 컬럼/다중 컬럼 정렬 6가지 조합을 검증. 또 `test_union_with_values_list_on_annotated_and_unannotated`도 회귀 방지로 포함.
- 테스트 증명 방식: `qs1.union(qs2)`에 대해 `order_by('-pk').values_list('order', flat=True)` → `[-1, 6, 5, 7]` 처럼 pk 기준 정렬되었지만 select되지 않은 `order` 값을 반환하도록 기대한다. 픽스 전에는 `pk`가 select list에 없어 SQL 에러로 깨지고, 픽스 후에는 `pk`가 select에 자동 추가되어 ORDER BY 위치가 유효해지며 기대 정렬 결과를 반환한다. `subTest`로 6개 조합 각각을 독립 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: 에러 메시지 "ORDER BY position N is not in select list"로 grep → `compiler.py get_order_by()`의 ORDER BY를 정수 위치로 매핑하는 루프(`for idx, ... resolved.set_source_expressions([RawSQL('%d' % (idx + 1), ())])`)와 그 `else` 분기가 정확한 핫스팟.
- 함정/난이도 메모: 멀티파일(컴파일러 분기 + Query에 헬퍼 메서드 신규). 단순히 에러를 안 던지게만 하면 안 되고, alias 유무로 분기해야 함(`col_alias` 있으면 여전히 에러 — `test_order_raises_on_non_selected_column`이 PASS_TO_PASS로 이 동작 보존을 강제). select에 컬럼만 추가하면 `values_select` 불일치로 values_list가 깨질 수 있어 `add_select_col`이 둘 다 갱신해야 한다.
- 우리 에이전트 관점: hint가 "copy() 누락" 같은 잘못된 방향을 암시하고 PR도 여러 번 전략이 틀렸으므로, traceback 표면이 아니라 ORDER BY 위치-매핑 로직의 의미를 이해해야 한다. alias 분기 보존(PASS_TO_PASS 회귀)과 `values_select` 동기화를 놓치기 쉬운 지점.
