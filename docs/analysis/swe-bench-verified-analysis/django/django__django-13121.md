---
instance_id: django__django-13121
repo: django/django
base_commit: ec5aa2161d8015a3fe57dcbbfe14200cd18f0a16
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-06-29T09:04:15Z
fail_to_pass: 1
pass_to_pass: 168
gold_files: [django/db/backends/base/operations.py, django/db/backends/mysql/operations.py, django/db/backends/sqlite3/operations.py, django/db/models/expressions.py]
---

# django__django-13121

## 문제 요약
`DurationField`만 들어간 expression(예: `F('estimated_time') + timedelta(1)`)을 SQLite/MySQL에서 평가하면 결과를 fetch하는 단계에서 `decimal.InvalidOperation`이 발생한다. 사용자는 duration끼리 더한 값이 정상적으로 `timedelta`로 반환되길 기대했지만, native duration 타입이 없는 백엔드에서는 SQL이 `INTERVAL ... MICROSECOND`/raw 마이크로초 문자열로 잘못 만들어져 `convert_durationfield_value`의 `decimal.Decimal(value)` 변환이 깨졌다.

## 유형 분류
- 버그 카테고리: logic (edge-case — duration-only 조합 경로)
- 서브시스템: django ORM query expressions / DB backend operations
- 증상 타입: 예외 (`decimal.InvalidOperation` / `ConversionSyntax`)
- 로컬라이제이션 신호: traceback이 `convert_durationfield_value`(operations.py)와 `apply_converters`를 가리키고, 키워드 `DurationField`/`date_interval_sql`/`DurationValue`가 `expressions.py`와 backend `operations.py`로 직결된다.

## 골드패치 분석
- 건드린 파일/함수:
  - `db/models/expressions.py`: `Combinable._combine`, `CombinedExpression.as_sql`, `DurationExpression.compile`, `DurationValue`(삭제)
  - `db/backends/base/operations.py`: `date_interval_sql`(삭제)
  - `db/backends/{mysql,sqlite3}/operations.py`: `date_interval_sql`(삭제)
- 근본 원인: `_combine`은 timedelta를 특수 클래스 `DurationValue`로 감쌌고, `DurationValue.as_sql`이 native duration이 없는 백엔드에서 `date_interval_sql`로 마이크로초 raw 문자열을 직접 내보냈다. 그 결과 fetch 시 converter가 받는 값 형식이 깨져 Decimal 변환에서 폭발했다. 또한 `CombinedExpression.as_sql`은 한쪽만 DurationField여도 `DurationExpression` 경로를 타지 않아 duration+duration 케이스가 일반 산술로 처리됐다.
- 수정 요지:
  - `DurationValue`와 모든 `date_interval_sql`을 전부 제거 — 특수 SQL 생성 경로 폐기.
  - `_combine`에서 timedelta를 그냥 `Value(other, output_field=DurationField())`로 감싸도록 단순화.
  - `CombinedExpression.as_sql`을 `get_internal_type()` 기반으로 리팩터해, `'DurationField' in {lhs_type, rhs_type} and lhs_type != rhs_type`(한쪽만 duration)일 때만 `DurationExpression`을 쓰도록 조건을 정교화.
  - `DurationExpression.compile`에서 `DurationValue` isinstance 분기를 없애고 output_field가 DurationField면 `format_for_duration_arithmetic`을 적용하도록 일반화.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_duration_expressions (expressions.tests.FTimeDeltaTests)` — 각 `delta`에 대해 `Experiment.objects.annotate(duration=F('estimated_time') + delta)`를 돌려 모든 row에서 `obj.duration == obj.estimated_time + delta`인지 확인한다.
- 증명 방식: 픽스 전에는 이 annotate가 fetch 시 `decimal.InvalidOperation`으로 죽었고, 픽스 후에는 duration-only 산술이 올바른 `format_for_duration_arithmetic` 경로를 타 값이 Python `timedelta` 합과 정확히 일치한다. 또 `base/test_operations.py`에서 `test_date_interval_sql`(이제 존재하지 않는 메서드의 NotImplementedError 검사)을 함께 삭제한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback의 `convert_durationfield_value`에서 거꾸로 "어떤 SQL이 들어왔길래 Decimal이 깨지나"를 추적 → `DurationValue.as_sql` → `date_interval_sql`로 도달. 동시에 `expressions.py`의 `CombinedExpression.as_sql` duration 분기 로직을 읽어야 한다.
- 함정/난이도: 멀티파일(4개) + "코드 삭제가 정답"인 케이스라 패치를 추가하려는 본능과 반대다. `as_sql`의 새 조건 `lhs_type != rhs_type`(서로 다른 타입일 때만 DurationExpression)이 핵심인데, 직관적이지 않아 잘못 추가하면 duration-duration 합이 다시 깨진다. `get_internal_type()` 호출을 `FieldError`로 감싸는 try 구조도 유지해야 한다.
- 우리 에이전트 관점: 백엔드별 `date_interval_sql` 3곳과 base 추상 메서드, 그리고 `DurationValue` 클래스 참조를 빠짐없이 지우지 못하면 dangling reference나 dead path가 남는다. "왜 기존 특수 클래스를 없애야 하나"라는 설계 의도를 못 잡으면 증상만 가리는 패치를 만들 위험이 크다.
