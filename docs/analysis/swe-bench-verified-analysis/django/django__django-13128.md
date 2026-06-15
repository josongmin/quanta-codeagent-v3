---
instance_id: django__django-13128
repo: django/django
base_commit: 2d67222472f80f251607ae1b720527afceba06ad
version: "3.2"
difficulty: 1-4 hours
created_at: 2020-06-30T18:06:56Z
fail_to_pass: 7
pass_to_pass: 134
gold_files: [django/db/models/expressions.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-13128

## 문제 요약
`F('end') - F('start') + Value(datetime.timedelta(), output_field=DurationField())` 처럼
temporal(날짜/시간) 뺄셈을 더 큰 표현식에 합성하면
`FieldError: Expression contains mixed types: DateTimeField, DurationField. You must set output_field.`
가 발생한다. 사용자는 `ExpressionWrapper(..., output_field=DurationField())`로 명시적으로 감싸지 않고도
temporal subtraction이 동작하기를 기대한다. 즉 뺄셈 결과가 DurationField로 자연스럽게 추론되어
바깥 연산과 섞일 수 있어야 한다. 근본 문제는 "결과 타입이 DurationField"라는 판정이 **SQL 컴파일 시점**
(`as_sql`)에만 일어나서, 표현식 트리가 **합성·resolve되는 시점**에는 그 타입 정보가 없다는 lifecycle 미스매치다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable).** 에러 메시지 "mixed types … You must set output_field"와
  이슈의 "temporal subtraction" 키워드가 `django/db/models/expressions.py`의
  `TemporalSubtraction`/`DurationExpression`/`CombinedExpression`으로 좁게 수렴한다. 단일 파일이지만
  "어디가 실제 결함인가"는 grep 한 방으로 안 나옴 — 분기가 있는 `as_sql`이 아니라, 분기가 **없는**
  `resolve_expression`이 진짜 결함 지점이라 "정상 코드를 보고 빠진 책임을 발견"해야 해서 L0이 아님.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드 추가가 아니라
  **책임을 한 lifecycle 단계(as_sql)에서 다른 단계(resolve_expression)로 옮기는 구조 변경**이다.
  치환 분기를 통째로 이동하고, lhs/rhs를 먼저 resolve한 결과로 타입을 판정하도록 데이터 흐름을 재배치해야 한다(S6).
  여기에 무한 재귀를 막는 `isinstance` 가드와 예외 집합(`FieldError`→`(AttributeError, FieldError)`)을
  올바르게 합성하는 추론(S2)이 보조로 필요하다. 테스트를 돌려가며 후보를 고르는 G&V로는 수렴하기 어렵다 —
  "언제 output_field가 결정되는가"를 이해해야 풀리는 인과적 문제라 S3/S4가 아님.
- **K (Knowledge) = K-Domain.** Django ORM expression 파이프라인의 핵심 도메인 지식 —
  `resolve_expression`(트리 합성/output_field 추론 시점) vs `as_sql`(SQL 생성 시점)의 분리, `output_field`
  추론 규칙, `DurationExpression`/`TemporalSubtraction` 특수화의 의미 — 이 없으면 결함 위치 자체를 오판한다.
  일반 파이썬 추론(K-Gen)으로는 도달 불가.
- **Primary type = T-DesignRefactor.** dominant 신호는 "조율된 구조 변경"이다. 위치는 비교적 좁지만(L1),
  난점의 본질이 분기 한 개를 고치는 게 아니라 **연산 치환 책임을 compile-time에서 resolve-time으로 재배치**하고
  두 메서드(`as_sql`↔`resolve_expression`)의 일관성을 맞추는 데 있어 T-DirectMap/T-ConstraintReason보다
  T-DesignRefactor가 정확하다.

## 난이도 티어
**T5 (어려움).** 공식 difficulty 라벨은 `1-4 hours`(개발자 구현시간 기준 T4 prior)지만, 에이전트 난이도로는
한 단계 위인 T5로 재조정한다. 근거가 되는 구조적 피처:

- **결함 위치의 역설(localize misdirection):** 버그를 일으키는 코드는 `as_sql`에 *있지만*, 올바른 픽스는
  `as_sql`의 분기를 **삭제**하고 분기가 **없는** `resolve_expression`에 **새로 추가**하는 것이다. 에러가 나는
  곳과 고쳐야 하는 곳이 어긋나서, 순진한 에이전트는 `as_sql` 분기를 만지작거리다 합성 케이스를 영영 못 푼다.
- **lifecycle 추론 요구:** "output_field 추론이 resolve 시점에 끝나야 바깥 연산과 섞일 수 있다"는 Django ORM
  내부 동작을 이해해야만 진짜 fix에 도달 — 표면 패치로 빠지는 함정이 큼(K-Domain).
- **재귀/예외 등 합성 디테일:** `isinstance(self, (DurationExpression, TemporalSubtraction))` 가드가 없으면
  무한 재귀, `AttributeError` 미포함이면 일부 표현식에서 타입 조회가 터짐 — 정답 식이 여러 제약을 동시에 만족해야 함.
- **넓은 P2P trap:** PASS_TO_PASS 134개 중 `FTimeDeltaTests` 다수(`test_datetime_subtraction`,
  `test_durationfield_add`, `test_duration_with_datetime`, `test_delta_*` 등)와 expression 산술 전반이
  걸려 있어 regression 표면이 매우 넓다. as_sql 책임을 옮기면서 기존 SQL 경로를 깨면 대량 회귀.

L1(단일 파일·좁은 후보)이라 T6는 아니지만, S6 design-refactor + K-Domain + 넓은 P2P + localize misdirection의
조합이 T4를 넘겨 T5로 민다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/models/expressions.py`
  - `CombinedExpression.as_sql` — temporal 치환 분기 **제거**
  - `CombinedExpression.resolve_expression` — temporal 치환 분기 **신규 추가**
  - `DurationExpression.as_sql` — native duration DB 폴백 추가
- **근본 원인:** temporal subtraction을 `TemporalSubtraction`/`DurationExpression`으로 치환하는 로직이
  `as_sql`(SQL 컴파일 시점)에만 존재했다. 그래서 표현식 트리가 *합성·resolve*되는 시점에는 여전히 일반
  `CombinedExpression`이고 output_field가 DurationField로 추론되지 않아, 바깥 연산과 섞이면
  mixed-types FieldError가 발생했다.
- **수정 요지:**
  1. `as_sql`에서 치환 분기(`'DurationField' in {lhs_type, rhs_type}` → `DurationExpression`,
     `connector == SUB and lhs_type in datetime_fields and lhs_type == rhs_type` → `TemporalSubtraction`)를
     통째로 **삭제**.
  2. `resolve_expression`에서 lhs/rhs를 먼저 resolve한 **뒤** 그 `output_field.get_internal_type()`으로 타입을
     판정하고, 조건 충족 시 `DurationExpression`/`TemporalSubtraction`을 만들어 `.resolve_expression(...)`을
     호출(SQL이 아니라 resolved 트리를 반환). 이로써 합성 시점에 올바른 output_field가 확정된다.
  3. `isinstance(self, (DurationExpression, TemporalSubtraction))` 가드로 재진입(무한 재귀) 차단.
  4. 타입 조회 예외를 `FieldError` → `(AttributeError, FieldError)`로 확장.
  5. `DurationExpression.as_sql`은 `connection.features.has_native_duration_field`이면
     `super().as_sql()`로 폴백 — native duration을 지원하는 DB에선 특수 마이크로초 처리가 불필요.

## 검증 (test_patch)
- **FAIL_TO_PASS 7개** — `test_date_subtraction`, `test_date_case_subtraction`,
  `test_date_subquery_subtraction`, `test_datetime_subquery_subtraction`,
  `test_datetime_subtraction_microseconds`, `test_time_subtraction`, `test_time_subquery_subtraction`
  (모두 `expressions.tests.FTimeDeltaTests`).
- **픽스 증명:** test_patch는 기존 `ExpressionWrapper(F('a') - F('b'), output_field=DurationField())` 래핑을
  벗겨내고 `F('a') - F('b')`(및 subquery/Value 변형)만으로 annotate하도록 바꾼다. 즉 "wrapper 없이 raw temporal
  subtraction"이 올바른 timedelta를 반환하는지를 직접 검증한다. 예:
  `Time.objects.annotate(difference=F('time') - Value(time(11,15,0), output_field=TimeField()))`
  → `timedelta(hours=1, minutes=15, seconds=15, microseconds=2345)`. null 케이스(`Value(None, ...)`)는
  `difference`가 None이어야 함도 확인.
- **overfit 관점:** 위험 낮음. 테스트가 date/time/datetime × 직접/subquery/Case × null의 여러 축을 커버하고,
  결과 값(timedelta)을 정확히 단언하므로 special-case 픽스로는 통과 불가. 픽스는 타입쌍 전반을 다루는
  일반 규칙이라 테스트 너머 입력으로도 일반화된다.
- **regression 관점:** 위험 높음(`regression-trap`). PASS_TO_PASS 134개가 expression 산술·FTimeDeltaTests
  잔여 케이스를 광범위하게 묶고 있어, `as_sql`→`resolve_expression` 책임 이동이 기존 SQL 생성 경로(특히 native
  duration DB의 `DurationExpression.as_sql` 폴백)나 비-temporal 연산을 깨면 대량 회귀. 골드패치의
  `has_native_duration_field` 폴백과 `isinstance` 가드가 이 회귀를 막는 장치다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 에러 메시지 "mixed types … You must set output_field"를 grep → output_field
   추론 경로. "temporal subtraction" 키워드 → `expressions.py`의 `TemporalSubtraction`/`DurationExpression`
   정의와 `CombinedExpression.as_sql`의 치환 분기. 여기서 멈추지 말고 **`resolve_expression`을 읽어** "치환이
   왜 컴파일 시점에만 일어나는가, output_field는 언제 확정되는가"를 확인하는 것이 핵심 단계.
2. **픽스와 올바른 일반화:** 치환 분기를 `as_sql`에서 제거하고 `resolve_expression`으로 옮긴다. lhs/rhs를 먼저
   resolve한 후의 output_field로 타입을 판정해 `DurationExpression`/`TemporalSubtraction`으로 치환하면, 합성
   시점에 결과가 DurationField로 확정되어 바깥 연산과 섞일 때 mixed-types가 안 난다. 이는 special-case가 아니라
   "temporal 결과 타입을 트리 합성 시점에 확정한다"는 근본 원인 교정이라 모든 date/time/datetime/subquery 조합으로
   일반화된다(overfit 아님).
3. **regression 안전:** PASS_TO_PASS의 `test_datetime_subtraction`, `test_durationfield_add`,
   `test_duration_with_datetime(_microseconds)`, `test_delta_add/subtract/update`,
   `test_date_minus_duration` 등 기존 temporal/duration 경로와 expression 산술 전반을 깨면 안 된다.
   `isinstance` 가드로 무한 재귀를, `DurationExpression.as_sql`의 `has_native_duration_field` 폴백으로
   native DB의 기존 SQL 동작을 보존해야 이들이 그대로 통과한다.
4. **함정 회피:** 오라클 없는 에이전트가 빠지기 쉬운 곳 —
   (a) `as_sql` 분기만 보고 거기서 고치려다 합성 케이스(`F('end')-F('start')+Value(...)`)를 영영 못 푼다.
   "결함이 난 곳 ≠ 고칠 곳"임을 인식하고 resolve-time으로 책임을 옮겨야 한다.
   (b) `resolve_expression`에서 치환 후 재진입을 막는 `isinstance(self, (DurationExpression, TemporalSubtraction))`
   가드를 빼면 무한 재귀.
   (c) lhs/rhs를 resolve하기 **전**의 타입으로 판정하면 F는 아직 타입 미상이라 오판 — resolve **후** output_field로
   판정해야 함.
   (d) 예외를 `FieldError`만 잡으면 일부 표현식에서 `AttributeError`로 터짐 → `(AttributeError, FieldError)`로 확장.
