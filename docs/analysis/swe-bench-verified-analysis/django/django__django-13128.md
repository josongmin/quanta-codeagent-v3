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
---

# django__django-13128

## 문제 요약
`F('end') - F('start')` 같은 temporal(날짜/시간) 뺄셈을 더 큰 표현식에 합성하면
`FieldError: Expression contains mixed types: DateTimeField, DurationField. You must set output_field.`
가 발생한다. 사용자는 `ExpressionWrapper(..., output_field=DurationField())`로 감싸지 않고도
temporal subtraction이 동작하기를 기대한다. 즉, 뺄셈 결과가 DurationField로 자연스럽게 추론되어
바깥 연산과 섞일 수 있어야 한다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (output_field 추론이 합성 시점에 안 됨)
- 서브시스템: django ORM query expression (`CombinedExpression` / `TemporalSubtraction` / `DurationExpression`)
- 증상 타입: 예외 (FieldError "mixed types … You must set output_field")
- 로컬라이제이션 신호: 에러 메시지가 expression의 output_field 추론에서 나오고,
  "temporal subtraction"이라는 키워드가 `expressions.py`의 `TemporalSubtraction`/`DurationExpression`을 직접 가리킨다.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/expressions.py` : `CombinedExpression.as_sql`, `CombinedExpression.resolve_expression`, `DurationExpression.as_sql`
- 근본 원인: temporal-subtraction → `TemporalSubtraction`/`DurationExpression`으로 치환하는 로직이
  `as_sql`(SQL 컴파일 시점)에만 있었다. 그래서 표현식 트리가 *합성*될 때(resolve_expression 시점)에는
  여전히 일반 `CombinedExpression`이고 output_field가 DurationField로 추론되지 않아,
  바깥 연산과 섞이면 mixed-types FieldError가 났다.
- 수정 요지:
  - 치환 분기(`DurationField` 혼합 → `DurationExpression`, datetime SUB → `TemporalSubtraction`)를
    `as_sql`에서 제거하고 `resolve_expression`으로 이동.
  - `resolve_expression`에서 먼저 lhs/rhs를 resolve한 뒤 그 output_field로 타입을 판정하고,
    이미 `DurationExpression`/`TemporalSubtraction`이면 재진입하지 않도록 `isinstance` 가드를 둠.
  - 타입 조회 예외를 `FieldError`뿐 아니라 `AttributeError`까지 잡도록 확장.
  - `DurationExpression.as_sql`은 `has_native_duration_field`이면 `super().as_sql()`로 폴백
    (native duration DB에서는 특수 처리 불필요).

## 검증 (test_patch)
- FAIL_TO_PASS 7개(`test_date_subtraction`, `test_time_subtraction`, `test_datetime_subtraction_microseconds`,
  `*_subquery_subtraction`, `test_date_case_subtraction` 등)가 모두
  기존 `ExpressionWrapper(F('a') - F('b'), output_field=DurationField())` 래핑을
  벗겨내고 `F('a') - F('b')`만으로 annotate하도록 바뀌었다.
- 즉 테스트는 "wrapper 없이 raw temporal subtraction"이 올바른 timedelta를 돌려주는지를 증명한다.
  재현 입력: `Time.objects.annotate(difference=F('time') - Value(time(11,15,0), output_field=TimeField()))`
  → 기대 출력: `timedelta(hours=1, minutes=15, seconds=15, microseconds=2345)`.
  null 케이스(`Value(None, ...)`)는 `difference`가 None이어야 함도 확인한다.

## 공략 포인트 (뭘 조져야)
- 시작점: `expressions.py`에서 `TemporalSubtraction`/`DurationExpression` 정의와
  `CombinedExpression.as_sql`의 분기 로직. 에러 메시지 "mixed types"를 grep하면 output_field 추론 경로로 연결됨.
- 함정/난이도:
  - 핵심 통찰은 "치환을 SQL 시점이 아니라 resolve 시점으로 옮긴다"는 것. as_sql만 고치면
    output_field 추론이 안 돼 합성 케이스를 못 푼다.
  - resolve_expression에서 `DurationExpression`/`TemporalSubtraction` 재진입을 막는 `isinstance` 가드가 없으면 무한 재귀.
  - lhs/rhs를 resolve한 *뒤*의 output_field로 판정해야 정확함(F는 resolve 전엔 타입 미상).
  - `AttributeError`까지 잡지 않으면 일부 표현식에서 타입 조회가 터짐.
  - 단일 파일이지만 두 메서드(as_sql↔resolve)에 걸친 책임 이동이라 멀티-메서드 일관성이 관건.
- 우리 에이전트 관점: as_sql 안의 분기만 보고 거기서 고치려다 합성 케이스(F('end')-F('start')+Value(...))를
  놓치기 쉽다. "언제 output_field가 결정되는가"라는 lifecycle(resolve vs compile)을 이해해야
  진짜 fix에 도달하므로, 표면적 패치로 빠지는 함정이 큼.
