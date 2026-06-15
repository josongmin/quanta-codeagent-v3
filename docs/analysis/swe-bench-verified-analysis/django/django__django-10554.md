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
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-10554

## 문제 요약
`union()`으로 합친 QuerySet에 `values_list()`와 `order_by()`를 조합하면 SQL 실행이 깨진다. combined query에서 ORDER BY 항은 SELECT 컬럼의 **정수 위치(position)** 로 컴파일되는데, ORDER BY가 가리키는 컬럼(예: `pk`)이 `values_list('order')`로 인해 select 목록에서 빠져 있으면 존재하지 않는 위치 `(4)`가 생성되어 `django.db.utils.ProgrammingError: ORDER BY position 4 is not in select list`가 발생한다. 사용자는 `qs.order_by('-pk').values_list('order', flat=True)` 같은 파생 쿼리가 정상 동작하길 기대했지만 깨진다. 이슈에는 완전한 재현 코드와 native 트레이스백이 포함되어 있다.

## 유형 (정형화)
- **L = L3 (Multi-site).** localize *발견* 자체는 쉽다 — 에러 문자열 "ORDER BY position N is not in select list" + 트레이스백 말단 `sql/compiler.py:execute_sql`로 grep하면 `get_order_by()`의 ORDER BY→정수위치 매핑 루프와 그 `for/else` 분기가 핀포인트된다(그 점만 보면 L1). 그러나 올바른 *수정*은 `compiler.py:get_order_by`(분기 로직)와 `query.py:Query.add_select_col`(신규 헬퍼)을 **함께 조율**해서 바꿔야만 정합적이다 — select와 values_select를 동시에 갱신하지 않으면 SQL은 고쳐져도 values_list 결과가 어긋난다. 패치가 2 파일에 걸쳐 함께 변해야 하므로 L3.
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor).** 단순히 에러를 안 던지게만 하면(템플릿 가드, S1) 틀린다. 올바른 식을 **추론으로 합성**해야 한다: (a) alias 유무로 분기(alias 있으면 여전히 raise, 없으면 select에 추가), (b) 추가 후 ORDER BY 위치를 `len(self.query.select)`로 재바인딩, (c) `values_select`까지 `output_field.name`으로 동기화. 이 불변식(select 위치 ↔ values_select ↔ ORDER BY position)을 따져 푸는 것이 S2다. 동시에 select/values_select 결합을 다루는 작은 헬퍼 메서드를 **도입**하는 구조 변경이 있어 S6 보조. 힌트가 "copy() 누락"이라는 잘못된 방향을 제시하고 원 PR도 "전략을 아직 못 맞췄다"고 한 점이 G&V(시도반복)가 아닌 의미추론 문제임을 뒷받침한다.
- **K = K-Domain.** combined query compilation, ORDER BY가 union에서 ordinal로 컴파일되는 이유, `select`/`values_select`/`default_cols`의 역할 — django SQL 컴파일러 내부 지식이 병목.
- **primary type = T-DomainBound.** 진짜 어려움은 "어디냐"(쉽다)도 "테스트 반복"(overfit)도 아니라, **django query-compiler 도메인 지식**으로 ordinal-position 매핑의 의미를 이해해야 올바른 분기·동기화를 만들 수 있다는 점이다. K-Domain이 dominant.

## 난이도 티어
**T5 (어려움).** 공식 라벨은 `1-4 hours`(대략 T4 prior). 그러나 구조적 피처가 T5로 민다:
- **L3 조율 멀티파일**(compiler 분기 + Query 헬퍼 신규)이 함께 바뀌어야 함.
- **S2+S6** — 정수 위치 매핑·alias 분기·values_select 동기화라는 비자명 불변식 추론.
- **K-Domain 깊이** — union의 ordinal ORDER BY는 django 컴파일러 내부를 알아야 의미가 잡힌다.
- **강한 P2P trap** — `test_order_raises_on_non_selected_column`이 PASS_TO_PASS에 있어 "alias 있는 컬럼은 여전히 raise"를 강제한다. 에러를 전부 없애는 naive 픽스는 이 테스트를 깬다. 광범위 23개 P2P가 union/intersection/difference 인접 동작을 보호.

공식 라벨(개발자 구현시간)은 localize 난이도·overfit 위험·잘못된 힌트로 인한 오방향 비용을 반영하지 못한다. 원 PR이 여러 번 전략을 틀린 점이 에이전트 난이도가 시간라벨보다 높음을 시사하므로 T4가 아닌 T5로 둔다.

## 골드패치 분석
- **건드린 파일·함수:**
  - `django/db/models/sql/compiler.py:SQLCompiler.get_order_by` — ORDER BY를 정수 위치로 매핑하는 `for/else`의 `else` 분기.
  - `django/db/models/sql/query.py:Query.add_select_col` — 신규 메서드(`clear_select_fields` 인접에 추가).
- **근본 원인:** combined query(union 등)에서 ORDER BY 표현식은 SELECT 컬럼의 **위치 인덱스**로 컴파일된다(`RawSQL('%d' % (idx + 1))`). 기존 코드는 ORDER BY 컬럼이 select 목록과 매칭되지 않으면 무조건 `DatabaseError('ORDER BY term does not match any column in the result set.')`를 던졌다. `values_list('order')`가 select를 `order`만으로 좁히면 `pk` 같은 ORDER BY 컬럼이 select에서 빠지고, 위치 매핑이 select 길이를 초과하는 `(4)`를 생성해 DB가 거부한다.
- **수정 요지:** `else` 분기를 `col_alias` 유무로 분기한다. **alias가 있으면** 기존대로 에러를 던진다(명시적으로 select되지 않은 alias 컬럼 정렬은 여전히 금지). **alias가 없으면** 그 컬럼을 select에 추가하고 그 위치로 ORDER BY를 재바인딩한다:
  ```python
  if col_alias:
      raise DatabaseError('ORDER BY term does not match any column in the result set.')
  self.query.add_select_col(src)
  resolved.set_source_expressions([RawSQL('%d' % len(self.query.select), ())])
  ```
  신규 `add_select_col`은 `self.select`와 `self.values_select` **둘 다에 컬럼을 append**한다(`self.values_select += col.output_field.name,`). `values_select`까지 갱신해야 하는 진짜 이유는 "새 컬럼 비노출"이 아니라 **combined subquery의 SELECT 목록 전파**다: `compiler.py`의 union 컴파일 경로(`if not compiler.query.values_select and self.query.values_select: ... set_values((*extra_select, *values_select, *annotation_select))`)에서 각 union 분기가 부모의 `values_select`로부터 SELECT 컬럼을 받는다. pk를 `values_select`에 넣지 않으면 분기 쿼리들이 pk를 SELECT하지 않아 외부 ORDER BY ordinal(`len(select)`)이 다시 select 범위를 벗어난다 — 즉 select만 바꾸고 values_select를 안 바꾸면 SQL 정합(ordinal↔subquery select)이 다시 깨진다. (참고: pk가 `values_select`에 append되어도 `values_list('order', flat=True)`가 여전히 `order`만 돌려주는 건 pk가 인덱스 0이 아닌 **끝 위치**에 append되고 `FlatValuesListIterable`가 `row[0]`만 yield하기 때문이지, values_select가 pk를 배제해서가 아니다.)

## 검증 (test_patch)
- **FAIL_TO_PASS (2):**
  - `test_union_with_values_list_and_order` — `ReservedName` 4건 bulk_create 후 `qs1.union(qs2)`에 대해 `order_by`/`values_list` 호출 순서를 바꿔가며(`order_by` 먼저 vs `values_list` 먼저), 단일 컬럼·다중 컬럼 정렬 **6개 조합**을 `subTest`로 독립 검증. 예: `order_by('-pk').values_list('order', flat=True) == [-1, 6, 5, 7]` — `pk`로 정렬되지만 select되지 않은 `order` 값을 반환.
  - `test_union_with_values_list_on_annotated_and_unannotated` — base_commit에 **이미 존재**하던 테스트(test_patch는 `test_union_with_values_list_and_order`만 신규 추가). 회귀 보호용으로 새로 등록된 게 아니라, base에서 **실제로 실패**하던(annotate `Exists` + union + values_list가 동일한 select-list 불일치를 유발) 두 번째 케이스를 골드패치가 **같은 근본원인으로 함께 고치는** 것이다 — 그래서 FAIL_TO_PASS에 올라 있다.
- **픽스 증명:** 픽스 전에는 ORDER BY가 가리키는 `pk`가 select에 없어 ordinal `(4)`가 select 길이를 초과 → SQL 에러로 깨진다. 픽스 후에는 `pk`가 `select`와 `values_select` **둘 다에 append**되어 (a) 위치가 유효해지고 (b) union 각 분기가 `values_select`를 통해 pk를 SELECT하므로 ordinal↔subquery select 정합이 유지된다. `values_list('order', flat=True)`가 그래도 `order`만 반환하는 건 pk가 끝 위치에 붙고 `FlatValuesListIterable`가 `row[0]`만 yield하는 **위치 기반** 동작 때문이지, `values_select`가 pk를 배제해서가 아니다.
- **overfit 관점:** 6개 조합 × 두 호출순서 × 단일/다중 컬럼으로 입력공간을 넓게 커버해 special-case 통과를 어렵게 한다(overfit-risk 낮음 → 플래그 미부여). 다만 sqlite 외 백엔드별 ordinal ORDER BY 동작은 직접 검증하지 않는다.
- **regression 관점:** `test_order_raises_on_non_selected_column`(PASS_TO_PASS)이 **alias 있는 컬럼 정렬은 여전히 raise**임을 강제 → 에러를 전부 없애는 픽스는 즉시 적발된다. 추가로 union/intersection/difference·values·distinct·limits 등 23개 P2P가 인접 동작을 보호.

## 모범답안 (오라클 기반)
1. **localize 경로.** 트레이스백 말단 `sql/compiler.py:execute_sql`와 DB 에러 문자열 "ORDER BY position N is not in select list"를 신호로 잡는다. 이 에러는 ordinal ORDER BY가 select 범위를 벗어났다는 뜻 → `get_order_by()`에서 ORDER BY를 정수 위치로 매핑하는 루프(`resolved.set_source_expressions([RawSQL('%d' % (idx + 1), ())])`)와 매칭 실패를 처리하는 `for/else`의 `else` 분기로 직결. 이슈의 "copy() 누락" 힌트는 **무시**한다(틀린 방향).
2. **픽스와 일반화 근거.** `else`에서 무조건 raise하던 것을 `col_alias` 유무로 분기한다. alias 없는(즉 사용자가 명시적으로 select하지 않았지만 정렬에 필요한) 컬럼은 select에 추가하고 새 ordinal로 재바인딩한다. 이것이 overfit이 아닌 올바른 일반화인 이유: 문제의 근본은 "정렬에 쓰인 컬럼이 select에서 빠짐"이라는 일반 조건이고, alias 유무 분기는 "명시 select 컬럼 정렬 금지"라는 기존 계약을 보존하면서 그 일반 조건만 정확히 메운다. `add_select_col`이 `select`와 `values_select`를 함께 갱신하는 것이 핵심 — `values_select`를 빼먹으면 union 컴파일 경로(`compiler.py`)가 각 분기에 pk를 SELECT시키지 못해 ordinal↔subquery select 정합, 즉 **SQL 자체가 다시 깨진다**(결과 형태만 깨지는 게 아니다).
3. **regression 안전.** `test_order_raises_on_non_selected_column`을 깨지 않으려면 alias 있는 컬럼은 반드시 계속 raise해야 한다(분기 보존). union/intersection/difference·values·values_list·distinct·limits 23개 P2P가 안 깨지려면 `add_select_col`이 combined query 외 일반 경로의 select 의미를 바꾸지 않아야 한다 — 그래서 신규 메서드는 호출 지점이 `else` 분기 하나로 국한된다.
4. **함정 회피.** 오라클 없는 에이전트의 전형 실패: (a) 트레이스백 표면만 보고 `execute_sql`/`copy()` 근처를 고치려 함(힌트 유도) — 실제 핫스팟은 ordinal 매핑 로직. (b) `else`에서 에러만 제거 → `test_order_raises_on_non_selected_column` P2P 회귀. (c) select에 컬럼만 추가하고 `values_select` 동기화를 빠뜨림 → union 분기들이 pk를 SELECT하지 못해 외부 ORDER BY ordinal이 다시 select 범위를 벗어나 **SQL이 다시 깨짐**(결과 노출 문제가 아니라 정합 깨짐). (d) 위치를 `idx+1`류로 잘못 바인딩 → `len(self.query.select)`(추가 직후의 새 위치)여야 함. alias 분기·values_select 동기화·새 ordinal 세 가지를 모두 맞춰야 통과한다.
