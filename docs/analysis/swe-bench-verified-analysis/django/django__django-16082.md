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
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-16082

## 문제 요약
MOD(`%`) 연산자로 서로 다른 숫자 타입(예: DecimalField와 IntegerField)을 결합하는 Django 표현식을 쓸 때, ADD/SUB/MUL/DIV 같은 다른 산술 연산자와 달리 결과 `output_field`가 Decimal로 해석되지 않는다. 사용자는 혼합 숫자 타입 MOD도 다른 연산자처럼 자동으로 Decimal로 승격되기를 기대했지만, 그렇지 않아 output_field 추론이 누락되어 명시적 output_field 없이는 타입 추론이 실패한다. 이슈는 "like it does for other mathematical operators"로 비대칭(다른 산술은 되는데 MOD만 안 됨)을 직접 적시한다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈가 파일/심볼을 직접 지목하진 않지만, "MOD operator", "Decimal and Integer", "like it does for other mathematical operators"라는 표현이 강한 키워드 신호다. hints는 PR #15271(`expressions.py`의 `_resolve_combined_type`/`_connector_combinations` 영역)을 명시 링크로 못박는다. 산술 연산자 결합 테이블을 찾으면 단일 파일 단일 블록으로 수렴 → 약간의 탐색만 필요한 L1.
- **S (Repair Strategy) = S1 (Direct-Map) +S2(보조)**: dominant는 S1. 픽스는 기존 산술 연산자 묶음에 누락된 상수 한 줄(`Combinable.MOD`)을 추가하는 기계적 등록이다. "ADD/SUB/MUL/DIV는 있는데 MOD만 없다"는 누락-결함 클래스에 템플릿 매칭된다. 보조 S2가 붙는 이유: 픽스 지점을 결정하려면 "MOD 상수·SQL `%%` 컴파일은 이미 존재하는데 *어느* 테이블에서만 빠졌나"를 추론해야 하기 때문이다. 비트연산 묶음이 아니라 산술 묶음에 넣어야 한다는 판단이 곧 제약 추론(S2)이다.
- **K (Knowledge) = K-Domain**: django ORM 표현식의 output_field 타입 해석 메커니즘(`_connector_combinations` 테이블 → `register_combinable_fields` → `_resolve_combined_type`)을 알아야 "왜 여기에 등록하면 혼합 숫자가 Decimal로 승격되는가"를 이해할 수 있다. 일반 파이썬 추론(K-Gen)으로는 이 등록 테이블의 의미가 보이지 않는다.
- **Primary type = T-DomainBound**: 픽스 자체는 1줄이라 S1처럼 보이지만, 병목은 "django 표현식의 타입 승격이 선언형 조합 테이블로 구동된다"는 프레임워크 내부지식이다. 위치는 비교적 명확하므로 T-DiffuseLoc은 아니고, 픽스가 자명한 가드/상수 변경이 아니라 도메인 테이블 이해를 요구하므로 T-DirectMap보다 T-DomainBound가 dominant.
- **왜 이 strategy인가 (APR 관점)**: TBar/PAR식 템플릿 수리(누락된 enum 멤버를 동종 집합에 추가)가 정확히 맞는 결함 클래스다. 후보 패치를 다수 생성해 테스트로 거르는 G&V가 아니라, "동질 집합의 빠진 원소"를 한 번에 짚는 direct-map이 이상적이다. 단, 어느 집합인지(산술 vs 비트)를 가리는 최소한의 semantic 추론(S2)이 동반된다.

## 난이도 티어
**T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"로 T2~T3 경계다.

이 티어로 미는 구조적 피처:
- **수정 범위는 최소**: 단일 파일(`django/db/models/expressions.py`) 1줄 추가. patch scope만 보면 T1~T2 수준이며 이건 난이도를 낮추는 방향.
- **localize 직접성은 중간(L1)**: 이슈+hints가 강한 키워드와 PR 링크를 주지만, 정확한 코드 심볼(`_connector_combinations`)을 직접 지목하진 않는다.
- **"이미 처리된 것처럼 보이는" 함정**: MOD 상수와 SQL `%%` 컴파일이 코드에 이미 존재한다. grep "MOD"는 여러 곳을 히트하므로 "이미 지원됨"으로 오판하기 쉽다 — hints의 David Wobrock 혼동이 정확히 이 함정이다. 이 misleading signal이 T2가 아닌 T3로 끌어올린다.
- **도메인 지식 요구(K-Domain)**: output_field 타입 승격이 선언형 조합 테이블로 구동된다는 메커니즘 이해가 픽스 지점 결정의 전제.
- **P2P trap은 중간(regression-trap)**: PASS_TO_PASS 170개 중 `ExpressionOperatorTests`의 modulo/division/power/bitwise 등 인접 연산자 동작이 다수 포함되어, 잘못된 묶음(비트연산)에 MOD를 추가하면 회귀가 난다.

공식 라벨(15min-1h, T2급)보다 **T3로 한 칸 올린 이유**: 공식 라벨은 "개발자 구현시간"이고, 정답을 아는 개발자에겐 1줄이라 짧다. 그러나 에이전트 관점에선 (a) "MOD 이미 있음" misleading signal로 인한 오판 위험, (b) 산술 vs 비트 묶음 구별을 위한 도메인 추론이 시간라벨에 안 잡히는 난점이다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/expressions.py` — 모듈 레벨 `_connector_combinations` 리스트의 첫 번째 항목(숫자 타입 간 결합 가능 연산자를 정의하는 "Numeric operations" 딕셔너리). 이 테이블은 `register_combinable_fields` → `_resolve_combined_type`이 소비하여 결합 표현식의 output_field를 추론한다.
- **근본 원인**: 숫자 결합 연산자 집합이 `Combinable.ADD`, `SUB`, `MUL`, `DIV`만 나열하고 `Combinable.MOD`를 누락했다. MOD 상수 정의와 SQL 컴파일(`%%`)은 이미 존재했으나, **타입 승격 등록 테이블에서만** 빠져 있어 MOD만 다른 산술 연산과 동작이 갈렸다. 즉 동질 집합의 한 원소 누락(missing-case) 결함.
- **수정 요지**: 산술 연산자 튜플에 `Combinable.MOD,` 한 줄 추가. 이로써 (Integer,Decimal), (Decimal,Integer), (Integer,Float) 등 혼합 숫자 조합에 대해 MOD도 ADD/SUB/MUL/DIV와 동일하게 `_resolve_combined_type` 결과 필드(Decimal/Float 승격)를 얻는다. **비트연산 묶음(Bitwise operators)은 건드리지 않는다** — MOD는 산술이지 비트가 아니므로.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_resolve_output_field_number (CombinedExpressionTests)` — 혼합 숫자 타입 조합의 결합 output_field 해석.
  - `test_resolve_output_field_with_null (CombinedExpressionTests)` — null 포함 동일 검증.
- **픽스 증명 방식**: test_patch는 `test_resolve_output_field_number`의 `connectors` 리스트를 `[ADD, SUB, MUL, DIV]`에서 `[ADD, SUB, MUL, DIV, MOD]`로 확장한다. 즉 동일한 lhs/rhs/combined 매트릭스((IntegerField, DecimalField, DecimalField), (DecimalField, IntegerField, DecimalField), (IntegerField, FloatField, FloatField) 등)를 MOD 연산자에 대해서도 순회한다. 패치 전: MOD가 `_connector_combinations`에 없어 combined 필드가 기대 타입으로 해석되지 않아 실패. 패치 후: MOD가 다른 4개 연산자와 동일 경로를 타 통과.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇지만, 테스트가 **단일 입력이 아니라 lhs×rhs 타입 매트릭스 전체**를 MOD에 대해 순회하므로 special-case 우회로 통과하기 어렵다. 골드 픽스는 MOD를 산술 집합에 일반 등록하는 것이라 매트릭스 전체를 정직하게 만족한다 → overfit 위험 낮음(그래서 `overfit-risk` 플래그 미부여).
- **regression 관점**: PASS_TO_PASS 170개 중 `ExpressionOperatorTests`의 `test_lefthand_modulo`, `test_lefthand_modulo_null`, `test_right_hand_modulo`, division/multiplication/power/bitwise 군이 다수 포함된다. MOD를 **비트연산 묶음에 잘못 추가**하면 modulo SQL 동작이나 bitwise 타입 추론이 깨질 수 있어 `regression-trap`. 골드는 산술 묶음에만 추가하므로 이들이 모두 보존된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "like it does for other mathematical operators" + "Decimal and Integer"가 핵심 신호. 이는 "다른 산술 연산자의 output_field 해석 테이블에는 MOD가 빠졌다"를 직접 가리킨다. hints의 PR #15271 링크는 `expressions.py`의 `_connector_combinations`/`_resolve_combined_type` 영역을 못박는다. → `expressions.py`에서 `_connector_combinations` 정의를 열어 "Numeric operations" 딕셔너리의 연산자 튜플을 본다.
2. **픽스와 일반화 정당성**: 산술 튜플이 `ADD/SUB/MUL/DIV`만 갖고 `MOD`가 없다는 비대칭을 확인하고 `Combinable.MOD` 한 줄을 추가한다. 이게 올바른 일반화인 이유: MOD는 이미 산술 연산(상수·SQL 컴파일 존재)이며, output_field 타입 승격 규칙도 다른 산술과 동일해야 한다(혼합 숫자 → Decimal/Float). 특정 타입쌍만 하드코딩하는 special-case가 아니라 **동질 집합에 빠진 원소를 채우는** 구조적 일반화라 모든 숫자 타입 조합에 일관되게 적용된다.
3. **regression 안전**: 비트연산 묶음은 절대 건드리지 않는다 — MOD는 산술이지 비트가 아니다. 이로써 `test_lefthand_bitwise_*`, `test_lefthand_modulo(_null)`, `test_right_hand_modulo`, division/power 등 170개 P2P가 모두 보존된다. 추가는 산술 튜플 한 곳에만 국한되어 부작용 표면이 최소.
4. **함정 회피**: 오라클 없는 에이전트의 최대 실패 지점은 **"MOD 이미 있음" 오판**이다. grep "MOD"가 상수 정의·SQL `%%` 컴파일·`Combinable.MOD` 사용처를 여러 개 히트시켜 "이미 지원됨, 문제없음"으로 결론낼 수 있다(hints의 David Wobrock가 정확히 이렇게 혼동). 회피법: grep 카운트가 아니라 **ADD/SUB/MUL/DIV가 모두 등록된 정확한 테이블(`_connector_combinations` 산술 항목)을 지목하고, 그 안에 MOD만 부재**함을 차분 비교로 확인한다. 두 번째 함정은 MOD를 비트연산 묶음에 추가하는 것(연산자 분류 오인) — 산술 vs 비트 구별이 곧 정답성을 가른다.
