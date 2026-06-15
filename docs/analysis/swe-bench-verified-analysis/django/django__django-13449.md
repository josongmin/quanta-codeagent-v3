---
instance_id: django__django-13449
repo: django/django
base_commit: 2a55431a5678af52f669ffe7dff3dd0bd21727f8
version: 3.2
difficulty: 1-4 hours
created_at: 2020-09-22T13:04:03Z
fail_to_pass: 1
pass_to_pass: 46
gold_files: [django/db/models/expressions.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-13449

## 문제 요약
SQLite 백엔드에서 `Lag()`(등 윈도우 함수)를 `DecimalField`에 적용하면 `OperationalError: near "OVER": syntax error`로 크래시한다. 생성된 SQL이 `CAST(LAG(...) AS NUMERIC) OVER (...)` 형태로, NUMERIC 캐스팅이 `LAG()`만 감싸고 `OVER (...)` 절 앞에서 닫혀버려 SQLite 문법이 깨진다. 캐스팅은 윈도우 표현식 전체(`... AS "w"`까지)를 감싸야 한다. `FloatField`거나 `Lag(..., output_field=FloatField())`를 명시하면 정상 동작한다. problem_statement에 재현 모델/쿼리/네이티브 스택트레이스/문제 SQL이 모두 들어 있고, hints_text에는 거의 완성된 픽스 초안까지 제시되어 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 `SQLiteNumericMixin`(암시: `CAST(... AS NUMERIC)`), `Window`, `DecimalField`를 직접 지목하고, hints_text는 `django/db/models/expressions.py#L16-L28`의 `SQLiteNumericMixin` 라인과 수정해야 할 `Window` 클래스를 명시한다. grep 한 방 + hint 따라가면 바로 `expressions.py`의 `class Window`로 수렴. 후보 탐색 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor).** 위치는 자명하나, 올바른 픽스는 "윈도우 SQL 구조 + DecimalField 캐스팅 의미론"을 추론으로 합성해야 한다. 핵심 불변식은 *캐스팅은 `OVER (...)` 바깥 = 윈도우 표현식 전체를 감싸야 한다*는 것. 단순히 캐스팅을 끄는(noop) 게 아니라, 내부 source expression의 `output_field`만 `FloatField`로 강등해 안쪽 LAG가 NUMERIC 캐스팅을 받지 않게 하고, 캐스팅 자체는 `super().as_sqlite`로 윈도우 바깥에 다시 입히는 미묘한 균형이 필요 → 단순 가드/상수 변경(S1) 아님. 보조로 S6: `Window`의 클래스 상속(`SQLiteNumericMixin` 추가)과 `as_sqlite` 신규 메서드 도입은 디스패치 lifecycle을 재배치하는 소규모 구조 변경이다.
- **K (Knowledge) = K-Domain.** django ORM의 expression 컴파일 파이프라인(`as_sql`/`as_sqlite` 백엔드 디스패치), `SQLiteNumericMixin`의 NUMERIC 캐스팅 메커니즘, `output_field` 추론, `get/set_source_expressions` 표현식 트리 조작 — 전부 django 내부 지식이다. 일반 파이썬 추론만으로는 `super(Window, copy).as_sqlite(...)`처럼 copy를 self 대신 넘기는 비직관적 패턴을 도출하기 어렵다.
- **Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 진짜 난점이 "올바른 식·조건을 추론으로 합성"하는 데 있어 T-DirectMap(기계적 가드)이 아니라 T-ConstraintReason이 맞다. hints가 정답에 가깝다는 점이 strategy를 S2로 바꾸진 않는다(오라클 없는 에이전트 기준 분류이고, 픽스의 본질은 여전히 의미론 추론).

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 `1-4 hours`로 T4와 일치한다.
- **티어를 끌어올리는 피처:** (1) **S2 constraint-reasoning + S6 소규모 refactor** — 루브릭상 L1/L2 + S2/S3/S6 또는 K-Domain이면 T4. 여기선 L0이지만 strategy(S2+S6)와 knowledge(K-Domain)가 dominant. (2) **K-Domain 병목** — 윈도우 SQL 구조와 SQLite 캐스팅 의미론을 알아야 픽스가 *correct*해진다. (3) **regression-trap** — PASS_TO_PASS 46개가 모두 `expressions_window` 윈도우 함수 동작(rank/lag/lead/first_value/ntile/range frame/subquery 등)이라, `Window.as_sqlite` 디스패치를 잘못 건드리면 non-Decimal 경로가 광범위하게 깨진다. 골드가 `if isinstance(self.output_field, DecimalField)` 가드로 DecimalField 외에는 `self.as_sql` 폴백을 유지하는 이유.
- **티어를 끌어내리는 피처:** (1) **L0 + has-repro** — 네이티브 스택트레이스 + 재현 모델/쿼리 + 잘못된 SQL까지 본문에 있어 localize 비용 거의 0(repro는 가장 강한 easiness 신호, 해결률 ~87%). (2) **단일 파일·~12줄·1 헌크** — 구조적 컷상 1파일 소규모. (3) **hints에 픽스 초안** 거의 그대로 제공.
- **순효과:** localize는 T1~T2급으로 쉽지만, 픽스 correctness가 도메인 의미론 추론을 요구하고 넓은 P2P trap이 있어 **T4**가 방어 가능하다. 공식 difficulty(1-4h)와 일치하므로 재조정 없음.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/models/expressions.py` — `class Window`(상속 변경: `Expression` → `SQLiteNumericMixin, Expression`), `Window.as_sqlite`(신규 메서드).
- **근본 원인:** `DecimalField` 출력 표현식은 SQLite에서 `SQLiteNumericMixin.as_sqlite`가 `CAST(... AS NUMERIC)`로 감싼다. 윈도우 함수의 경우 내부 표현식(`Lag(...)`)이 DecimalField로 추론되어 캐스팅이 `LAG()` 본체만 감싸고 `OVER (...)` 절 앞에서 닫히면서 `CAST(LAG(...) AS NUMERIC) OVER (...)`라는 SQLite 문법 오류 SQL이 생성된다. 캐스팅이 윈도우 표현식 전체 바깥에 와야 유효하다.
- **수정 요지:**
  - `Window`가 `SQLiteNumericMixin`을 상속하게 해 SQLite 캐스팅 경로를 윈도우 표현식 자체(`Window`)가 통제하도록 함 — 캐스팅이 `OVER (...)`를 포함한 윈도우 전체를 감싼다.
  - `Window.as_sqlite`를 신규 추가: `self.output_field`가 `DecimalField`이면 `self.copy()`로 복사본을 만들고, `get_source_expressions()`로 얻은 첫 번째 source expression(`Lag` 등)의 `output_field`를 `fields.FloatField()`로 교체한 뒤 `set_source_expressions()`로 되돌린다. 이렇게 하면 **내부** 표현식은 NUMERIC 캐스팅을 받지 않고, `super(Window, copy).as_sqlite(compiler, connection)`이 캐스팅을 **윈도우 전체**에 한 번만 적용한다.
  - `DecimalField`가 아니면 `return self.as_sql(compiler, connection)`로 폴백 — 비-Decimal 윈도우 함수 경로는 기존 동작 그대로(캐스팅 미적용).

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_lag_decimalfield (expressions_window.tests.WindowFunctionTests)`.
- **동작:** 테스트 모델 `Employee`에 `bonus = models.DecimalField(decimal_places=2, max_digits=15, null=True)`를 추가하고, `setUpTestData`에서 각 직원의 `bonus`를 `Decimal(e[1]) / 400`(= salary/400)로 채운다. 새 테스트는 `Window(expression=Lag(expression='bonus', offset=1), partition_by=F('department'), order_by=[F('bonus').asc(), F('name').asc()])`로 annotate한 쿼리를 부서·bonus·name 순으로 정렬해 실행하고, 부서별 lag 값(예: Accounting Williams=None, Jenson=92.5, Jones=112.5, Adams=112.5 …)을 `assertQuerysetEqual`로 정확히 검증한다.
- **픽스 증명:** 픽스 전에는 SQLite에서 `OperationalError: near "OVER"`로 크래시(쿼리 자체가 실행 불가). 픽스 후에는 캐스팅이 윈도우 전체를 감싸 유효한 SQL이 되고, lag 값이 기대치와 정확히 일치 → SQL 유효성과 값 정합성을 동시에 증명.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만, 골드 픽스는 `isinstance(output_field, DecimalField)` 일반 조건으로 분기하므로 `Lag`뿐 아니라 모든 DecimalField 윈도우 함수에 일반화된다(테스트는 Lag만 커버 → 약한 overfit 여지 존재하나 픽스 자체는 일반적). special-case 하드코딩이 아니다.
- **regression 관점:** PASS_TO_PASS 46개가 윈도우 함수 전반(rank/dense_rank/lag/lead/first_value/last_value/nth/ntile/cume_dist/percent_rank/range·row frame/subquery/partitioning/ordering 및 INSERT/UPDATE 금지·invalid 검증)을 광범위하게 커버한다. 비-Decimal 경로의 `as_sql` 폴백을 유지하므로 이들 동작은 보존된다 — `as_sqlite`가 DecimalField 외에는 무동작이라는 점이 regression 안전의 핵심.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 잘못된 SQL `CAST(LAG(...) AS NUMERIC) OVER (...)`와 "DecimalField일 때만 / FloatField는 정상"이라는 신호 → NUMERIC 캐스팅 책임자인 `SQLiteNumericMixin`(`as_sqlite`에서 `CAST ... AS NUMERIC`)을 grep. hints_text가 `expressions.py`의 `SQLiteNumericMixin`과 `Window`를 직접 지목 → `django/db/models/expressions.py`의 `class Window`로 즉시 수렴. 추가 탐색 불필요(L0).
2. **픽스(왜 올바른 일반화인가):** 문제의 본질은 "캐스팅이 윈도우 표현식 내부에 머물러 `OVER` 앞에서 닫힌다"는 것. 올바른 해법은 캐스팅을 윈도우 *전체* 바깥으로 옮기는 것이다. `Window`가 `SQLiteNumericMixin`을 상속해 캐스팅 책임을 윈도우 노드로 끌어올리고, `as_sqlite`에서 내부 source expression의 `output_field`만 `FloatField`로 강등해 이중 캐스팅(내부 NUMERIC)을 제거한 뒤 `super().as_sqlite`로 바깥 캐스팅을 한 번만 입힌다. `isinstance(output_field, DecimalField)` 조건 분기라 Lag에 국한되지 않고 모든 DecimalField 윈도우 함수에 적용 → overfit 아닌 구조적 일반화. (사용자의 `output_field=FloatField()` workaround를 코드가 자동으로, 그러나 캐스팅은 보존하며 수행하는 셈.)
3. **regression 안전:** 비-DecimalField 윈도우 함수는 반드시 `self.as_sql` 폴백으로 빠져 기존 SQL 생성이 byte 동일해야 한다(P2P 46개 중 rank/lag(int)/lead/first_value/range frame/subquery 전부). `self.copy()`를 써서 원본 표현식 트리를 mutate하지 않는 것이 공유 표현식 오염(다른 쿼리/재사용 시 잘못된 FloatField 누수) 방지에 필수. SQLite 전용 경로(`as_sqlite`)만 건드려 Postgres/Oracle 등 다른 백엔드의 윈도우 SQL에 영향 없음.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) **캐스팅 통째로 noop** 처리: hints의 대안("`SQLiteNumericMixin.as_sqlite`를 window_compatible일 때 noop")로 가면 크래시는 멎지만 DecimalField 정밀도/반환 타입이 어긋날 수 있어 *plausible-but-incorrect* 위험. 골드는 캐스팅을 유지하되 *위치만* 옮긴다. (b) **원본 mutate**: `copy()` 없이 `self`의 source expression을 직접 바꾸면 공유 표현식이 오염된다. (c) **`super(Window, copy).as_sqlite(...)`의 비직관성**: copy를 `self` 자리에 넘겨 mixin의 캐스팅 로직을 복사본 기준으로 실행하는 패턴을 이해해야 함. (d) **분기 누락**: DecimalField 가드 없이 모든 경로에 캐스팅을 입히면 비-Decimal 46개 P2P가 깨진다(regression-trap).
