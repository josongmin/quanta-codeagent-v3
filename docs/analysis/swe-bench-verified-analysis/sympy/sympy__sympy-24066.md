---
instance_id: sympy__sympy-24066
repo: sympy/sympy
base_commit: 514579c655bf22e2af14f0743376ae1d7befe345
version: "1.12"
difficulty: "15 min - 1 hour"
created_at: 2022-09-16T22:58:15Z
fail_to_pass: 1
pass_to_pass: 30
gold_files: [sympy/physics/units/unitsystem.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`SI._collect_factor_and_dimension()`가 `exp(...)` 같은 `Function` 인자의 차원을 검사할 때, 인자가 실질적으로 무차원(dimensionless)인데도 그 사실을 정규화하지 못한다. 예컨대 `second/(ohm*farad)`는 `time/(capacitance*impedance)`라는 합성차원으로 표현되지만 차원시스템상 무차원이다. 이 표현을 `exp()`에 넣고 `100 + exp(expr)`처럼 더하면, `Add` 가지의 차원 일치 검사가 `Dimension(time/(capacitance*impedance)) != Dimension(1)`로 보고 `ValueError`를 던진다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문이 `SI._collect_factor_and_dimension()`를 직접 지목하고 네이티브 `ValueError` 메시지까지 제공한다. 단일 메서드로 즉시 수렴하나, 정확한 결함 가지(`Function` branch)는 8개 `elif` 분기 중 어디인지 짧게 읽어야 하므로 L0가 아닌 L1.
- **S2 (Constraint-Reasoning)**: 고칠 위치는 자명하나, 올바른 픽스는 "`Function` 인자의 차원도 `Pow`/`Add` 가지와 동일하게 `is_dimensionless`로 정규화해야 한다"는 불변식을 추론해야 도출된다. 단순 None가드/상수변경(S1)이 아니라 차원 동치성(canonicalization) 의미론을 맞추는 일.
- **K-Domain**: sympy units/dimension system 내부 지식(합성차원이 무차원과 동치일 수 있다, `get_dimension_system().is_dimensionless()`가 그 판정자)이 병목.
- **primary = T-ConstraintReason**: 위치는 명확하나 픽스가 "기계적 템플릿"이 아니라 무차원 정규화라는 의미적 불변식 합성이라서. 같은 함수 안 `Pow` 가지(line 170 부근)가 이미 `is_dimensionless`로 무차원을 1로 접는 선례를 가져다 `Function` 가지에 일반화하는 것이 핵심.

## 난이도 티어
**T3 (중간).** 구조적 피처: 파일 1개·함수 1개·실효 수정 ~3줄, `has-repro`(완전 재현코드 + 정확한 에러문구) → 강한 easiness 신호. 그러나 픽스가 상수/가드가 아니라 차원 동치 정규화라는 추론을 요구(S2)하고, 같은 메서드의 다른 가지 동작을 망가뜨리면 안 되는 약한 regression-trap(P2P 30개, 그중 `test_factor_and_dimension`·`test_get_dimensional_expr_with_function`·`test_issue_20288`이 같은 경로를 밟음)이 있어 T2보다 위. cross-file 조율·overfit 고위험은 없어 T4까지는 아니다. 공식 라벨 "15 min - 1 hour"와 정합(T3).

## 골드패치 분석
- **파일·함수**: `sympy/physics/units/unitsystem.py` → `UnitSystem._collect_factor_and_dimension()`의 `elif isinstance(expr, Function):` 가지.
- **근본원인**: `Function` 가지는 각 인자를 재귀 계산한 뒤 `*(d[1] for d in fds)`로 인자 차원을 **그대로** 반환한다. 그래서 `time/(capacitance*impedance)`처럼 무차원과 동치인 합성차원이 `Dimension(1)`로 접히지 않고 그대로 상위로 전파되고, 바깥 `Add` 가지의 `if dim != addend_dim` 검사에서 `Dimension(1)`과 불일치하여 `ValueError`로 터진다.
- **수정요지**: 인자 차원을 반환하기 전에 무차원이면 `Dimension(1)`로 정규화한다.
  ```python
  dims = [Dimension(1) if self.get_dimension_system().is_dimensionless(d[1]) else d[1] for d in fds]
  return (expr.func(*(f[0] for f in fds)), *dims)
  ```
  이는 `Pow` 가지가 이미 `if self.get_dimension_system().is_dimensionless(exp_dim): exp_dim = 1`로 하던 정규화를 `Function` 가지에 일관 적용한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_24062`** (1개): `R(impedance)/C(capacitance)/T(time)` 양들로 `expr = T/(R*C)`를 만들어 `is_dimensionless(dim)`이 참임을 먼저 확인하고, `1 + exp(expr) == (1 + E, Dimension(1))`을 단언한다. 패치 전에는 마지막 단언이 `ValueError`로 죽고, 패치 후 `exp(expr)`의 차원이 `Dimension(1)`로 정규화되어 `Add` 검사를 통과한다.
- **픽스 증명**: 테스트가 (1) 무차원 판정 경로와 (2) `Function`+`Add` 결합 경로를 모두 밟으므로, 정규화가 실제로 적용됐는지를 직접 관찰한다.
- **overfit/regression 관점**: 픽스가 `is_dimensionless`라는 도메인 정규 판정자에 위임하므로 `exp` 한 케이스가 아니라 모든 무차원-동치 인자에 일반화된다(특정 입력 하드코딩 아님 → overfit 낮음). regression은 `test_get_dimensional_expr_with_function`/`test_factor_and_dimension` 등 `Function` 경로를 쓰는 P2P가 가드. 단, FAIL_TO_PASS가 1개뿐이라 진짜 무차원이 아닌 함수 인자의 차원이 보존되는지는 P2P에 의존.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 메서드명과 `ValueError: Dimension of "exp(...)" is Dimension(time/(capacitance*impedance)), but it should be Dimension(1)`을 그대로 준다 → `unitsystem.py`에서 그 에러 문자열(`Add` 가지의 일치 검사)을 grep하고, 실제 잘못된 차원의 출처를 역추적하면 `exp` = `Function`이므로 `elif isinstance(expr, Function):` 가지가 무차원 정규화를 빠뜨림을 확인.
2. **픽스**: `Pow` 가지가 이미 `is_dimensionless` → `1` 정규화를 한다는 선례를 같은 함수에서 발견하고, 동일 불변식을 `Function` 인자 차원에 적용. `is_dimensionless`에 위임하므로 합성차원 표기에 무관하게 무차원이면 접힌다 — 이것이 `exp`만 특수처리하는 것보다 올바른 일반화.
3. **regression 안전**: `Function` 가지를 밟는 `test_get_dimensional_expr_with_function`, 같은 메서드의 `test_factor_and_dimension`, 그리고 인접 이슈회귀 `test_issue_20288`을 깨면 안 된다. 무차원이 아닌 인자는 `else d[1]`로 원래 차원을 그대로 두므로 기존 동작 보존.
4. **함정 회피**: (a) 바깥 `Add` 가지에 특수처리를 넣고 싶은 유혹 — 거기서 고치면 무차원 동치 판정이 `Add` 밖(다른 연산)에서 또 새는 좁은 패치가 된다. 결함의 진원지는 차원을 **전파**하는 `Function` 가지. (b) `exp` 함수 이름을 하드코딩하면 overfit. (c) 인자 차원을 무조건 `Dimension(1)`로 덮으면 진짜 차원 있는 함수 인자(예: 차원 보존이 필요한 케이스)를 깨뜨림 — 반드시 `is_dimensionless` 가드로 조건화해야 한다.
