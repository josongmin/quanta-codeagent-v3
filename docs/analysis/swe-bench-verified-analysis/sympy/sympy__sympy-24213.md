---
instance_id: sympy__sympy-24213
repo: sympy/sympy
base_commit: e8c22f6eac7314be8d92590bfff92ced79ee03e2
version: "1.12"
difficulty: "15 min - 1 hour"
created_at: 2022-11-03T14:00:09Z
fail_to_pass: 1
pass_to_pass: 31
gold_files: [sympy/physics/units/unitsystem.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`UnitSystem._collect_factor_and_dimension`가 덧셈(`Add`) 항들의 차원을 비교할 때, **차원 객체의 단순 동일성**(`dim != addend_dim`)으로 검사한다. 그래서 `acceleration*time`과 `velocity`처럼 **물리적으로 동등하지만 표현이 다른** 차원이 더해지면 거짓 `ValueError`를 던진다. 이슈 본문에 `a1*t1 + v1` 재현코드와 네이티브 스택트레이스(파일/라인 179)가 그대로 첨부돼 있다.

## 유형 (정형화)

- **L1 (Traceable)**: 스택트레이스가 `unitsystem.py`의 `_collect_factor_and_dimension`와 `raise ValueError` 라인을 직접 가리킨다. 파일·함수·정확한 비교문까지 좁혀짐. grep 한 방은 아니지만 탐색 거의 없음 → L1 상단.
- **S2 (Constraint-Reasoning)**: 고칠 지점(`if dim != addend_dim`)은 자명하나, 올바른 교체식이 무엇인지가 핵심. "두 차원이 같은가"를 syntactic 동일성이 아니라 **차원 시스템 상 동등성**으로 재정의해야 한다. 단순 None가드/상수변경(S1)이 아니라 도메인 불변식(차원 동치관계)을 추론해 올바른 술어를 합성하는 문제.
- **K-Domain**: sympy units의 `DimensionSystem`이 `equivalent_dims`라는 동치 판정 API를 제공한다는 내부지식이 병목. 일반 파이썬 추론만으론 "==를 무엇으로 바꿔야 정답인지"를 못 짚는다.
- **primary = T-ConstraintReason**: 위치는 명확(L1)하나 픽스가 기계적이지 않고, 올바른 동등성 술어를 도메인 불변식에서 합성해야 한다. APR 관점에서 SemFix/Angelix식 "조건식 합성"에 해당 — 후보를 마구 던져 테스트로 거르는 G&V가 아니라, 차원 동치라는 의미적 제약으로 단 하나의 올바른 술어를 도출한다.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 단일 파일 1줄 수정, has-repro(스택트레이스로 localize 거의 공짜), 그러나 픽스가 S2 추론이고 K-Domain(차원 동치 API 인지)이 실질 병목. P2P 31개로 regression 표면은 있으나(인접 `test_factor_and_dimension`, `test_check_unit_consistency`) 대부분 차원이 syntactic하게 일치하는 정상 케이스라 `equivalent_dims`로 바꿔도 안 깨진다. 공식 라벨 `15min-1h`와 정합: localize는 쉽고 시간은 "올바른 API를 찾는 추론"에서 소비된다. L0+S1이 아니라(== → 자명교체가 아님) T1/T2로 내리지 않고, 멀티파일/overfit 고위험이 없어 T4로 올리지도 않음.

## 골드패치 분석

- **파일·함수**: `sympy/physics/units/unitsystem.py` → `UnitSystem._collect_factor_and_dimension`의 `Add` 분기.
- **근본원인**: `Add` 항들의 차원 일치 검사가 `dim != addend_dim`, 즉 `Dimension` 객체의 구조적 부등호. `Dimension(acceleration*time)`와 `Dimension(velocity)`는 SI 기저 차원으로 환산하면 동일(둘 다 length/time)이지만 심볼릭 표현이 달라 `!=`가 True → 잘못된 `ValueError`.
- **수정요지**: 단 한 줄, `if dim != addend_dim:` → `if not self.get_dimension_system().equivalent_dims(dim, addend_dim):`. 비교를 `DimensionSystem.equivalent_dims`로 위임해, 기저 차원 지수가 같으면 동등으로 인정. `get_dimension_system()`은 같은 함수 내 `Pow`/`Function` 분기에서 이미 쓰이는 기존 접근자라 새 의존성 없음.

## 검증 (test_patch)

`test_quantities.py`에 **`test_issue_24211`** 추가(FAIL_TO_PASS=1). velocity/acceleration/time 양자를 정의하고 `expr = A1*T1 + V1`에 대해 `SI._collect_factor_and_dimension(expr)`가 "ValueError를 던지지 않아야" 함을 검증한다. 픽스 전: `acceleration*time != velocity`라 raise → 실패. 픽스 후: `equivalent_dims`가 동등 판정 → 통과.

- **overfit 관점**: 테스트가 반환값을 단정하지 않고 "throw 안 함"만 본다는 점에서 얇지만(`has-repro`로 보완), 픽스가 special-case 분기가 아닌 **일반 동치판정 API 호출**이라 overfit-risk 낮음. acceleration*time 외 임의의 동등 차원 쌍에도 일반화됨.
- **regression 관점**: P2P 31개 중 차원이 실제로 불일치하는 케이스(예: 길이+시간)는 `equivalent_dims`가 여전히 False를 반환해 정당한 `ValueError`를 보존한다. 정상 동일차원 덧셈은 `equivalent_dims`가 True라 무변화. 따라서 `regression-trap`은 존재하나 픽스 방향상 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 스택트레이스가 `unitsystem.py:179`의 `raise ValueError`를 직접 지목 → `_collect_factor_and_dimension`의 `Add` 분기로 직행. 거짓 에러를 만드는 가드가 `if dim != addend_dim`임을 즉시 식별.
2. **픽스와 일반화 근거**: 버그의 본질은 "차원 같음"을 **객체 동일성**으로 본 것. 올바른 추상화는 "차원 시스템 상 동등". 같은 모듈 생태계에 이미 존재하는 `DimensionSystem.equivalent_dims`(기저 차원 지수 벡터 비교)로 위임하는 것이 정답. special-case(`acceleration*time`만 예외처리)가 아니라 **모든 동등 차원 쌍**을 포괄하므로 올바른 일반화.
3. **regression 안전**: 진짜 차원 불일치(length + time 등)에는 여전히 raise해야 한다 — `equivalent_dims`는 이 경우 False라 기존 `ValueError`와 메시지가 그대로 유지된다. `test_check_unit_consistency`, `test_factor_and_dimension` 등 P2P가 이를 보증.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) `equivalent_dims` 존재를 모르고 직접 `get_dimensional_dependencies`로 지수 dict를 비교하는 장황한 재구현(중복·버그 위험), (b) 동등 차원을 통과시키려고 검사를 **삭제**해버려 정당한 ValueError까지 잃는 과교정(regression), (c) `Quantity` 표현 정규화로 우회 시도. 정답은 도메인이 이미 제공하는 동치 API를 한 줄로 호출하는 것이며, 이를 위해선 `DimensionSystem`의 공개 메서드를 먼저 확인(K-Domain)해야 한다.
