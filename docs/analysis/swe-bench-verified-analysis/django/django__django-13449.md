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
---

# django__django-13449

## 문제 요약
SQLite 백엔드에서 `Lag()`(등 윈도우 함수)를 `DecimalField`에 적용하면 `OperationalError: near "OVER": syntax error`로 크래시한다. 생성된 SQL이 `CAST(LAG(...) AS NUMERIC) OVER (...)` 형태로, NUMERIC 캐스팅이 `LAG()`만 감싸고 `OVER (...)` 절 앞에서 닫혀버려 문법이 깨진다. 사용자는 캐스팅이 윈도우 표현식 전체(`...AS "w"`까지)를 감싸기를 기대했다. `FloatField`나 `output_field=FloatField()` 명시 시에는 정상 동작한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (Window + DecimalField + SQLite 조합의 SQL 생성 누락)
- 서브시스템: django ORM query expressions (윈도우 함수 SQL 컴파일, SQLite 백엔드)
- 증상 타입: 예외 / 크래시 (OperationalError, SQL 문법 오류)
- 로컬라이제이션 신호: problem_statement가 `SQLiteNumericMixin`/`CAST(... AS NUMERIC)`/`Window`/`DecimalField`를 직접 지목, hints_text는 `expressions.py`의 `SQLiteNumericMixin` 라인과 수정 코드 초안까지 제시 → `django/db/models/expressions.py`의 `Window` 클래스로 직결.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` — `class Window`(상속 추가), `Window.as_sqlite`(신규 메서드)
- 근본 원인: `DecimalField` 출력 표현식은 SQLite에서 `SQLiteNumericMixin.as_sqlite`가 `CAST(... AS NUMERIC)`로 감싼다. 윈도우 함수에서는 캐스팅이 내부 expression만 감싸 `OVER` 절과 분리되면서 `CAST(LAG(...) AS NUMERIC) OVER (...)`라는 잘못된 SQL이 만들어진다. 캐스팅은 윈도우 표현식 바깥에 와야 한다.
- 수정 요지:
  - `Window(Expression)` → `Window(SQLiteNumericMixin, Expression)`로 변경해 SQLite 캐스팅 경로를 윈도우 표현식 자체가 통제하게 함.
  - `Window.as_sqlite`를 신규 추가: `output_field`가 `DecimalField`이면 `self.copy()` 후 첫 번째 source expression의 `output_field`를 `FloatField()`로 교체(`get_source_expressions`/`set_source_expressions`)해 내부 LAG가 NUMERIC 캐스팅을 받지 않게 하고, `super(Window, copy).as_sqlite(...)`로 캐스팅을 윈도우 전체에 적용.
  - `DecimalField`가 아니면 그냥 `self.as_sql(...)`로 폴백.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_lag_decimalfield (expressions_window.tests.WindowFunctionTests)`
- 테스트 모델 `Employee`에 `bonus = DecimalField(decimal_places=2, max_digits=15, null=True)` 필드를 추가하고, `setUpTestData`에서 각 직원의 bonus를 `Decimal(salary) / 400`으로 채운다.
- `Window(expression=Lag('bonus', offset=1), partition_by=F('department'), order_by=[...])`로 annotate한 쿼리를 실행 → 픽스 전이면 SQLite에서 `OperationalError`로 크래시. 픽스 후에는 정상 실행되어 부서별로 정렬된 lag 값(예: Accounting의 Williams=None, Jenson=92.5, Jones=112.5 …)이 `assertQuerysetEqual`로 정확히 일치하는지 검증. 즉 캐스팅이 윈도우 전체를 감싸 SQL이 유효해지고 값도 맞음을 증명.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `django/db/models/expressions.py`에서 `SQLiteNumericMixin`과 `class Window` 정의. `as_sqlite` vs `as_sql` 디스패치, `output_field`가 `DecimalField`로 추론되는 흐름 추적이 핵심.
- 함정/난이도 메모:
  - 단순히 캐스팅을 끄면(noop) DecimalField 값의 정밀도/타입 처리가 어긋날 수 있음 — 골드는 내부 expression의 output_field만 FloatField로 바꿔 캐스팅 대상에서 빼고, 캐스팅 자체는 윈도우 바깥에서 유지하는 미묘한 처리.
  - `self.copy()`를 써서 원본 표현식을 mutate하지 않는 점이 중요(공유 표현식 오염 방지).
  - 단일 파일 수정이지만 SQLite 전용 경로라, 다른 백엔드(Postgres 등)에 영향 없도록 `as_sqlite`만 건드려야 함.
- 우리 에이전트 관점: hints_text에 거의 정답 코드가 있어 로컬라이제이션은 쉬움. 막힐 만한 지점은 (1) `super(Window, copy).as_sqlite` 호출 패턴(복사본을 self 대신 넘기는 비직관적 형태), (2) `source_expressions[0].output_field` 교체가 왜 충분한지(Lag의 내부 expression만 캐스팅 빠지면 됨)를 이해하는 부분.
