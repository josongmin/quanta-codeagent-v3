---
instance_id: django__django-15375
repo: django/django
base_commit: beb7ddbcee03270e833b2f74927ccfc8027aa693
version: "4.1"
difficulty: 15 min - 1 hour
created_at: 2022-01-28T14:48:03Z
fail_to_pass: 1
pass_to_pass: 95
gold_files: [django/db/models/aggregates.py]
---

# django__django-15375

## 문제 요약
`annotate()` 뒤에 `aggregate()`를 호출하면서 집계(aggregate) 함수에 `default` 인자(4.0 신규)를 주면 크래시가 난다. 예: `Book.objects.annotate(idx=F("id")).aggregate(Sum("id", default=0))`가 `OperationalError: near "FROM": syntax error`를 낸다. 생성된 SQL이 `SELECT FROM (SELECT ... ) subquery`처럼 바깥 SELECT의 컬럼 목록이 비어 버린 형태다. `default` 없는 동일 쿼리나, 수동 `Coalesce(Sum("id"), 0)`는 정상 동작한다. 즉 `default`가 내부적으로 만드는 Coalesce 래핑 경로에서만 깨진다.

## 유형 분류
- 버그 카테고리: logic / regression (4.0에서 추가된 `default` 기능의 회귀)
- 서브시스템: django ORM / aggregation expression resolution (`db/models/aggregates.py`)
- 증상 타입: 크래시 (DB 레벨 OperationalError, 잘못된 SQL 생성)
- 로컬라이제이션 신호: problem_statement에 "Aggregate.default generates a Coalesce internally"라는 힌트가 있고, 잘못된 SQL이 outer SELECT의 컬럼이 누락된 형태 → 집계가 summary로 인식되지 않아 outer query 컬럼 목록에서 빠진 것. `default`/`Coalesce` 키워드가 곧장 `aggregates.py`의 `resolve_expression`을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/aggregates.py` : `Aggregate.resolve_expression`
- 근본 원인: `default`가 설정되면 `resolve_expression`이 집계를 `Coalesce(c, default, ...)`로 다시 감싸 새 표현식을 반환한다. 그런데 새로 만든 `Coalesce` 인스턴스에는 원래 집계 `c`의 `is_summary` 플래그가 전파되지 않는다. `is_summary`는 해당 표현식이 "전체 행 요약 집계"임을 표시하는데, annotate가 있어 쿼리가 서브쿼리로 감싸질 때 outer SELECT의 컬럼 목록은 summary 표현식만 끌어온다. Coalesce가 summary로 표시되지 않으니 outer SELECT에 포함되지 않아 `SELECT FROM (...)`라는 빈 컬럼 SQL이 생성된다.
- 수정 요지: `Coalesce(...)`를 만든 뒤 `coalesce.is_summary = c.is_summary`로 원래 집계의 summary 여부를 래핑된 표현식에 그대로 복사하고 그 인스턴스를 반환하도록 변경. 한 줄 반환을 3줄(변수 추출 → 플래그 복사 → 반환)로 풀었다. (힌트 패치는 `is_summary = True` 하드코딩이었으나 골드는 `c.is_summary`로 일반화해 non-summary 경로도 보존.)

## 검증 (test_patch)
- FAIL_TO_PASS: `test_aggregation_default_after_annotation` — `Publisher.objects.annotate(double_num_awards=F('num_awards')*2).aggregate(value=Sum('double_num_awards', default=0))`가 크래시 없이 `40`을 반환하는지 확인.
- 추가로 PASS_TO_PASS에 들어간 `test_aggregation_default_not_in_aggregate`는 annotate에 `default`가 붙고(집계엔 안 붙음) `aggregate(Sum('num_awards'))`가 `20`을 내는 케이스로, 힌트에서 언급된 "집계가 annotated 필드를 쓰든 안 쓰든 깨진다"를 커버한다.
- 증명 방식: 픽스 전에는 outer SELECT 컬럼 누락으로 OperationalError가 나서 `aggregate()` 자체가 실패. 픽스 후 Coalesce가 summary로 표시되어 outer SELECT에 정상 포함 → 올바른 SQL이 생성되고 기대 정수값을 반환.

## 공략 포인트 (뭘 조져야)
- localization 전략: 증상이 "잘못된 SQL"이므로 SQL 생성 경로가 아니라 expression resolution 단계를 의심해야 한다. `default` + `Coalesce` 키워드 두 개가 곧장 `Aggregate.resolve_expression`을 지목한다. 거기서 새로 만든 표현식이 원본 집계의 메타 플래그를 잃는지 비교하는 게 핵심.
- 함정/난이도: SQL 텍스트(`SELECT FROM`)만 보고 compiler/backend(sqlite3/base.py)를 파다가 헤매기 쉽다(reporter의 `%debug` 트레이스가 base.py를 가리켜 미끼가 된다). 실제 원인은 `is_summary` 플래그 누락이라는 비가시적 상태 전파 문제. 또 annotate 없이는 재현이 안 되므로(summary 추출 경로가 안 탐) "default 단독" 케이스로만 테스트하면 버그를 못 본다.
- 우리 에이전트 관점: `is_summary`가 outer-SELECT 컬럼 선택에 어떻게 쓰이는지 모르면 한 줄 수정의 정당성을 못 세운다. 또 힌트의 `is_summary = True` 하드코딩을 그대로 베끼면 non-summary 경로를 망가뜨릴 위험이 있어, `c.is_summary` 복사가 더 안전하다는 판단까지 가야 진짜 골드 품질. 멀티파일 아님 — 단일 함수 3줄.
