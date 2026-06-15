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
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-13121

## 문제 요약
`DurationField`만 들어간 expression(예: `F('estimated_time') + timedelta(1)`)을 native duration 타입이 없는 백엔드(SQLite/MySQL)에서 평가하면, 결과를 fetch하는 단계에서 `decimal.InvalidOperation` (`ConversionSyntax`)이 발생한다. 사용자는 duration끼리 더한 값이 정상 `timedelta`로 반환되길 기대했지만, 특수 클래스 `DurationValue`가 `date_interval_sql`을 통해 `INTERVAL ... MICROSECOND` / raw 마이크로초 문자열을 SQL에 박았고, fetch 시 `convert_durationfield_value`의 `decimal.Decimal(value)` 변환이 그 형식을 받아 깨졌다. 즉 duration-only 산술 경로가 백엔드에서 잘못된 SQL을 생성하는 구조적 결함이다. 이슈에 native Python 트레이스백이 그대로 첨부되어 있다.

## 유형 (정형화)
- **L (Localization) = L3 (Multi-site).** 트레이스백이 `convert_durationfield_value`(base/operations.py)와 `apply_converters`를 직접 가리켜 시작점은 명확하지만, 정답 패치는 4개 파일(`expressions.py` + base/mysql/sqlite3 `operations.py`)을 **함께** 바꿔야 한다. `DurationValue` 클래스 삭제와 `date_interval_sql` 3곳 삭제가 일관되게 조율되지 않으면 dangling reference가 남는다. 단일파일로 끝나지 않으므로 L2가 아니라 L3.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).** 정답은 "체크 추가"(S1)가 아니라 특수 SQL 생성 메커니즘 자체를 폐기하는 **구조 변경**이다: `DurationValue`(Value 서브클래스) 제거, base/mysql/sqlite3의 `date_interval_sql` 메서드 제거, `_combine`을 `Value(other, output_field=DurationField())`로 단순화, `DurationExpression.compile`에서 `isinstance(side, DurationValue)` 분기 제거. 더해 `CombinedExpression.as_sql`의 분기를 `output_field` 객체 비교에서 `get_internal_type()` 기반으로 갈아끼우고 `'DurationField' in {lhs_type, rhs_type} and lhs_type != rhs_type`(한쪽만 duration일 때만 `DurationExpression` 경로)이라는 새 불변식을 합성해야 한다 — 이 조건 도출이 S2(constraint-reasoning) 성격. dominant는 "기존 설계를 걷어내고 재배치"라서 S6.
- **K (Knowledge) = K-Domain.** django ORM expression compiler 내부(`Combinable`/`CombinedExpression`/`DurationExpression`), `has_native_duration_field` feature flag, `convert_durationfield_value` converter, `format_for_duration_arithmetic` 백엔드 hook 등 프레임워크 깊은 곳의 계약을 알아야 "왜 특수 클래스를 없애는 게 정답인가"를 판단할 수 있다.
- **Primary type = T-DesignRefactor.** L3가 T-DiffuseLoc도 후보지만, 트레이스백이 위치를 충분히 좁혀줘 진짜 난점은 "어디인가"가 아니라 "특수 케이스 메커니즘을 통째로 걷어내고 타입 기반 라우팅으로 재구성"하는 조율된 구조 변경에 있다. 따라서 S6 기반 T-DesignRefactor가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"이지만, 그 라벨은 정답을 아는 코어 개발자의 **구현 시간**(삭제 위주라 짧음)을 반영한 것이고 에이전트 난이도와는 다르다. 구조적 피처는 다음과 같이 T5로 민다:
- **파일수 4 / L3 멀티사이트** — gold patch ≥3파일이면 solve <10% 구간(ICLR 2024). 단순 라인 추가가 아니라 4파일에 걸친 일관된 삭제+리팩터.
- **S6 design-refactor "삭제가 정답"** — 패치를 추가하려는 에이전트 본능과 반대 방향. 증상만 가리는 가드를 넣기 쉬워 overfit이 아니라 wrong-fix 위험이 크다.
- **넓은 P2P trap (168)** — `FTimeDeltaTests` 전체(date/datetime/time subtraction, delta add/subtract, microseconds 등)와 `CombinableTests`, `ExpressionOperatorTests`가 P2P에 포함. `_combine`/`as_sql`/`compile`을 건드리면서 이 인접 동작(특히 한쪽만 duration인 date-minus-duration, duration subtraction)을 깨면 즉시 회귀. 이 광범위한 regression-trap이 T4가 아니라 T5로 올린다.
- **K-Domain 깊은 콜체인** — expression resolve → as_sql → compiler converter까지 추적해야 근본원인 파악 가능.
has-repro(트레이스백 존재)는 easiness 신호지만 localize만 도와줄 뿐 구조 변경 난이도는 낮추지 못한다.

## 골드패치 분석
- **건드린 파일 / 함수**
  - `django/db/models/expressions.py`: `Combinable._combine`(timedelta 래핑 단순화), `CombinedExpression.as_sql`(타입 기반 분기 재작성), `DurationExpression.compile`(`DurationValue` 분기 제거), `DurationValue` 클래스 **삭제**.
  - `django/db/backends/base/operations.py`: `date_interval_sql` 추상 메서드 **삭제**.
  - `django/db/backends/mysql/operations.py`: `date_interval_sql` 구현 + `from django.utils.duration import duration_microseconds` import **삭제**.
  - `django/db/backends/sqlite3/operations.py`: `date_interval_sql` 구현 + 동일 import **삭제**.
- **근본 원인**: `_combine`이 timedelta를 특수 클래스 `DurationValue`로 감쌌고, `DurationValue.as_sql`이 `has_native_duration_field`가 없는 백엔드에서 `connection.ops.date_interval_sql(self.value)`로 마이크로초 raw 문자열/`INTERVAL` SQL을 직접 내보냈다. 이 값이 fetch 시 `convert_durationfield_value`의 `decimal.Decimal(value)`에 들어가면서 변환 폭발. 또 `CombinedExpression.as_sql`이 `output_field` 객체를 비교하며 "한쪽이라도 DurationField면" 식의 느슨한 조건이라, duration+duration 케이스가 `DurationExpression` 특수 경로를 제대로 타지 못하고 일반 산술로 처리됐다.
- **수정 요지**: 특수 SQL 생성 경로(`DurationValue` + `date_interval_sql`)를 전부 제거하고, duration 산술을 일반 `Value(output_field=DurationField())` + `DurationExpression`/`format_for_duration_arithmetic` 경로로 통일. `as_sql`은 `get_internal_type()`을 `FieldError` try로 감싸 `lhs_type`/`rhs_type`을 얻은 뒤, `'DurationField' in {lhs_type, rhs_type} and lhs_type != rhs_type`(혼합 타입일 때만 `DurationExpression`)로 정교화하고, datetime 빼기 조건도 `self.connector == self.SUB and lhs_type in datetime_fields and lhs_type == rhs_type`로 가독·정확화.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_duration_expressions (expressions.tests.FTimeDeltaTests)` — 각 `delta`에 대해 `Experiment.objects.annotate(duration=F('estimated_time') + delta)`를 실행하고 모든 row에서 `obj.duration == obj.estimated_time + delta`를 단언한다. 픽스 전엔 fetch 시 `decimal.InvalidOperation`으로 죽고, 픽스 후엔 duration-only 산술이 올바른 `format_for_duration_arithmetic` 경로를 타 Python `timedelta` 합과 정확히 일치한다.
- **삭제된 테스트**: `tests/backends/base/test_operations.py::test_date_interval_sql` — 더 이상 존재하지 않는 추상 메서드의 `NotImplementedError`를 검사하던 테스트라 함께 제거.
- **overfit 관점**: FAIL_TO_PASS는 1개지만 `self.deltas` 전체를 루프하며 실제 DB round-trip 값을 Python 계산과 비교하므로 special-case 통과가 어렵다 — 단, FAIL_TO_PASS 단독으로 보면 얇아 보일 수 있어 `overfit-risk`보다는 P2P가 진짜 안전망이다.
- **regression 관점**: 168개 P2P가 핵심 방어선. `_combine`/`as_sql`/`compile`을 건드리면서 `test_date_subtraction`, `test_datetime_subtraction(_microseconds)`, `test_time_subtraction`, `test_date_minus_duration`, `test_delta_add/subtract`, `test_durationfield_add`, `test_duration_with_datetime` 등 혼합·동일 타입 시간연산 전 범위를 깨지 않아야 한다. `lhs_type != rhs_type` 조건과 datetime 빼기 조건(`lhs_type == rhs_type`)을 동시에 정확히 잡아야 둘 다 green.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 트레이스백의 끝 프레임 `convert_durationfield_value`에서 `decimal.Decimal(value)`가 깨진 점 → "어떤 SQL 값이 들어왔길래 Decimal 파싱이 실패하나"를 역추적. `git grep DurationField`/`duration` 으로 `expressions.py`의 `DurationValue.as_sql` → `connection.ops.date_interval_sql`로 도달하고, 거기서 `INTERVAL ... MICROSECOND`/raw 문자열이 SQL에 박힌다는 걸 확인. 동시에 `CombinedExpression.as_sql`의 duration 분기와 `_combine`의 timedelta 래핑을 읽어 데이터플로우 전체를 파악.
2. **픽스와 왜 올바른 일반화인가**: 증상(잘못된 SQL 문자열)을 가리는 대신, 특수 케이스 메커니즘(`DurationValue` + 백엔드별 `date_interval_sql`) 자체를 제거하고 duration 산술을 표준 `Value(output_field=DurationField())` + `DurationExpression`/`format_for_duration_arithmetic` 경로로 통일한다. 이것이 올바른 일반화인 이유: `format_for_duration_arithmetic`은 이미 SQLite custom 함수로 duration 산술을 처리하는 정식 hook이라, 별도 raw-microsecond SQL을 만들 필요 자체가 없었다. `as_sql`의 새 조건 `lhs_type != rhs_type`은 "한쪽만 duration(=date+duration 같은 혼합)"일 때만 `DurationExpression`을 태우고, duration+duration은 일반 경로로 보내는 것이 의미상 정확 — 특정 테스트를 통과시키려는 자의적 분기가 아니라 타입 의미론에서 도출된 불변식이다.
3. **regression 안전**: 168 P2P 중 시간연산 군이 위험. `lhs_type == rhs_type`인 datetime/date/time 빼기는 여전히 `TemporalSubtraction` 경로를 타야 하고(`test_date/datetime/time_subtraction`), date-minus-duration처럼 혼합 타입은 `DurationExpression`을 타야 한다(`test_date_minus_duration`, `test_duration_with_datetime`). `get_internal_type()` 호출을 기존처럼 `FieldError` try로 감싸 output_field 없는 expression에서 죽지 않게 유지해야 `BasicExpressionsTests` 다수가 green. 백엔드 import(`duration_microseconds`) 삭제 시 다른 사용처가 없는지 확인.
4. **함정 회피**: (a) 오라클 없는 에이전트가 가장 흔히 빠지는 함정 — `convert_durationfield_value`에 `try/except`나 값 정규화를 넣어 증상만 봉합. 이러면 근본 SQL 생성 결함이 남고 다른 백엔드/케이스에서 재발. (b) "삭제가 정답"임을 못 잡고 `DurationValue.as_sql`만 패치 → 설계 부채 잔존. (c) `date_interval_sql`을 base/mysql/sqlite3 3곳 + 추상 메서드까지 빠짐없이 지우지 못하면 dead path/dangling reference. (d) `as_sql` 조건에서 `lhs_type != rhs_type`를 빠뜨리면 duration+duration이 다시 일반 산술로 새서 `test_duration_expressions`가 깨지거나, 반대로 datetime 빼기 조건의 `==`를 흐트러뜨리면 `TemporalSubtraction` 회귀. 피하는 법: 트레이스백을 표면 증상이 아니라 "잘못된 SQL이 어디서 만들어지나"의 원천으로 끝까지 따라가고, P2P의 시간연산 테스트 전 범위를 회귀 기준으로 삼아 타입 분기 조건 두 개(혼합=`!=`, 동일=`==`)를 동시에 만족시키는지 검증.
