---
instance_id: django__django-16082
repo: django/django
base_commit: bf47c719719d0e190a99fa2e7f959d5bbb7caf8a
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-09-21T18:49:40Z
fail_to_pass: 2
pass_to_pass: 170
gold_files: [django/db/models/expressions.py]
---

# django__django-16082

## 문제 요약
MOD(`%`) 연산자로 서로 다른 숫자 타입(예: DecimalField와 IntegerField)을 결합하는 Django 표현식을 쓸 때, ADD/SUB/MUL/DIV 같은 다른 산술 연산자와 달리 결과 `output_field`가 Decimal로 해석되지 않는다. 사용자는 혼합 숫자 타입 MOD도 다른 연산자처럼 자동으로 Decimal로 승격되기를 기대했지만, 그렇지 않아 output_field 추론이 누락된다.

## 유형 분류
- 버그 카테고리: 누락처리 (operator 등록 누락) / edge-case
- 서브시스템: django ORM query expressions (`django.db.models.expressions`)
- 증상 타입: silent-wrong (혼합 타입 MOD가 다른 산술 연산과 다르게 output_field를 추론 못 함; 명시 안 하면 "Cannot infer type" 류로 이어짐)
- 로컬라이제이션 신호: problem_statement가 "MOD operator", "Decimal and Integer", "like it does for other mathematical operators"라고 명시 → 다른 산술 연산자(ADD/SUB/MUL/DIV)의 output_field 해석 테이블을 찾으면 됨. hints의 PR #15271 링크와 `_connector_combinations` 영역이 정확한 지점.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` — `_connector_combinations` 리스트 (모듈 레벨, `register_combinable_fields`/`_resolve_combined_type`이 소비하는 연산자 조합 테이블)
- 근본 원인: 숫자 타입 간 결합 가능 연산자를 정의하는 첫 번째 `_connector_combinations` 항목이 `Combinable.ADD`, `SUB`, `MUL`, `DIV`만 나열하고 `Combinable.MOD`를 빠뜨렸다. MOD 상수와 SQL 컴파일 자체는 이미 존재했으나, output_field 타입 승격(혼합 숫자 → Decimal 등) 등록에서만 누락되어 다른 연산자와 동작이 갈렸다.
- 수정 요지: 산술 연산자 묶음에 `Combinable.MOD` 한 줄을 추가. 이로써 (Integer,Decimal), (Decimal,Integer) 등 혼합 숫자 조합에 대해 MOD도 ADD/SUB/MUL/DIV와 동일한 `_resolve_combined_type` 결과 필드를 얻는다. 비트연산 묶음은 건드리지 않음.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_resolve_output_field_number (CombinedExpressionTests)` — 혼합 숫자 타입 조합의 결합 output_field 해석.
  - `test_resolve_output_field_with_null (CombinedExpressionTests)` — null 포함 동일 검증.
- 테스트가 증명하는 방식: `test_resolve_output_field_number`의 `connectors` 리스트에 `Combinable.MOD`를 추가하여, (IntegerField, DecimalField, DecimalField), (DecimalField, IntegerField, DecimalField), (IntegerField, FloatField, FloatField) 등 lhs/rhs/combined 매트릭스를 MOD 연산자에 대해서도 돈다. 패치 전에는 MOD가 `_connector_combinations`에 없어 combined 필드가 기대 타입으로 해석되지 않아 실패하고, MOD 등록 후 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `expressions.py`에서 `_connector_combinations` 정의를 찾고, 그 안의 산술 연산자 묶음(`Combinable.ADD/SUB/MUL/DIV`)을 식별. 다른 연산자는 다 있는데 MOD만 없다는 비대칭이 핵심 단서.
- 함정/난이도 메모: 단일 파일·단일 라인 추가지만, MOD가 "전혀 없는" 게 아니라는 점이 헷갈린다. MOD 상수 정의와 SQL `%%` 컴파일은 이미 있어서 grep만으로는 "이미 처리됨"으로 오판하기 쉽다(hints의 David Wobrock 혼동이 바로 이것). 핵심은 output_field 타입 해석 테이블에서만 빠졌다는 것. 비트연산 묶음에 잘못 추가하면 안 됨.
- 우리 에이전트 관점: 막힐 지점은 "정상으로 보이는 MOD 경로"에 속아 산술 결합 테이블의 누락을 못 잡는 것. ADD~DIV가 모두 등록된 곳을 정확히 짚고 MOD 부재를 비교로 확인하는 차이 추론이 필요. 수정 자체는 1줄로 매우 작아 ROI 높음.
