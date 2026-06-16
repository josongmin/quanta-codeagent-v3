---
instance_id: sympy__sympy-18698
repo: sympy/sympy
base_commit: 3dff1b98a78f28c953ae2140b69356b8391e399c
version: "1.6"
difficulty: "15 min - 1 hour"
created_at: 2020-02-21T05:46:56Z
fail_to_pass: 1
pass_to_pass: 147
gold_files: [sympy/polys/polytools.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [overfit-risk, regression-trap, has-repro]
---

## 문제 요약
`sqf_list`(square-free factorization)가 동일 중복도(multiplicity)를 갖는 서로 다른 인수를 하나로 합치지 않고 분리해서 반환한다. 예: `(x**2+1)*(x-1)**2*(x-2)**3*(x-3)**3`에 대해 `(x-2, 3)`과 `(x-3, 3)`을 따로 내놓지만, 같은 `Poly.sqf_list()`는 이 둘을 `(x**2-5*x+6, 3)` 하나로 묶는다. square-free 분해의 정의상 같은 거듭제곱 차수는 단일 곱으로 표현되어야 하므로 표현식 레벨 `sqf_list`가 일관성을 위반한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `_symbolic_factor_list` 헬퍼와 정확한 GitHub permalink(polytools.py L6218)까지 지목한다. 다만 "어떤 줄에 어떤 코드를 넣느냐"는 직접 안 적혀 있어 함수 내부 데이터플로우(누적되는 `factors` 리스트)를 읽어야 한다 → L0는 아님.
- **S2 (+S6)**: 고칠 위치는 명확하나, "같은 multiplicity끼리 곱으로 묶는다"는 **불변식을 후처리 합성식으로 구현**해야 한다. 골드는 `factors`를 multiplicity별로 그룹핑·`reduce(mul, ...)`로 재축약하는 작은 구조적 후처리(collect-then-combine)를 추가하므로 S6 보조.
- **K-Domain**: square-free factorization의 수학적 계약(같은 차수=단일 인수)을 알아야 올바른 출력 형태를 판별할 수 있다. 일반 파이썬 추론만으로는 "왜 합쳐야 하는가"가 안 나온다.
- **primary = T-ConstraintReason**: 위치는 잡히나 픽스의 핵심은 "multiplicity 동치류로 partition 후 곱"이라는 조건/식을 추론으로 만들어내는 데 있다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개·실질 수정 ~10줄로 scope는 작다(여기까지는 T2~T3).
- 그러나 픽스가 단순 가드/상수 변경이 아니라 **누적 결과를 사후 재구조화하는 후처리 식**이고(S2+S6), square-free의 도메인 계약을 알아야 정답 형태가 결정된다(K-Domain).
- `overfit-risk`: FAIL_TO_PASS가 `test_factor_terms` 1개뿐이고, 여기서 직접 검증하는 변경 단언은 `sqf_list(x*(x+y))`의 출력 형태뿐이다. multiplicity 합치기 자체를 잘못 구현해도 좁은 입력만 통과할 여지가 있다.
- `regression-trap`: PASS_TO_PASS 147개(`test_sqf`, `test_factor`, `test_factor_large` 등 다인수 분해 경로 다수)를 안 깨야 한다.
공식 라벨 "15분~1시간"과 일치(T3~T4 경계). 도메인 계약+후처리 합성 때문에 T3보다 T4로 둔다.

## 골드패치 분석
- **파일/함수**: `sympy/polys/polytools.py`의 `_symbolic_factor_list` (모든 `sqf*`/`factor*` 표현식 API의 공통 헬퍼).
- **근본원인**: 함수가 각 인수에서 얻은 `_factors`를 그대로 누적만 하고, `sqf` 메서드에 요구되는 "같은 multiplicity는 단일 곱" 불변식을 강제하지 않았다. 그 결과 같은 차수의 별개 인수가 분리 채로 남았다.
- **수정요지**:
  1. `if arg.is_Mul: args.extend(arg.args); continue` 분기를 통째로 삭제하고, 뒤따르던 `if arg.is_Pow:`를 `elif arg.is_Pow:`로 바꾼다. 베이스에서 `is_Pow`는 (별개의 `if`로) 이미 도달 가능했으므로 이는 '도달성 수정'이 아니다. 실효과는 Mul 인수의 평탄화(`args.extend`)를 없애 Mul 전체를 `else` 분기 → `_poly_from_expr`로 보내 단일 다항식으로 재인수분해하는 것이다. 단, 이 분기 변경은 본 인스턴스의 두 테스트(`test_factor_terms`, `test_issue_8695`) 통과와 무관하다 — 실행 검증: is_Mul 삭제만 적용 시 `sqf_list(x*(x+y))`는 `(1,[(x,1),(x+y,1)])`로 불변(두 테스트 모두 실패), reduce 후처리만 적용(is_Mul 유지) 시 두 테스트 모두 정답 산출.
  2. 함수 반환 직전, `method == 'sqf'`일 때만 후처리:
     ```python
     factors = [(reduce(mul, (f for f, _ in factors if _ == k)), k)
                for k in set(i for _, i in factors)]
     ```
     즉 multiplicity `k`별로 동치류를 모아 `reduce(mul, ...)`로 곱해 단일 인수로 축약한다. `from functools import reduce`, `from operator import mul` import 추가.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_factor_terms`: 기존 `sqf_list(x*(x+y)) == (1, [(x, 1), (x+y, 1)])` 단언이 `== (1, [(x**2+x*y, 1)])`로 변경된다. multiplicity 1인 `x`와 `x+y`가 곱 `x**2+x*y`로 합쳐진 새 계약을 검증한다.
- 추가된 `test_issue_8695`는 이슈 본문 예제(`(x**2+1)*(x-1)**2*(x-2)**3*(x-3)**3`)가 `(x**2-5*x+6, 3)`로 묶이는지 검증 — 단 이 테스트가 어느 PASS 집합에 속하는지와 무관하게 픽스의 핵심 동작(차수 3 두 인수 결합)을 직접 증명한다.
- **overfit 관점**: FAIL_TO_PASS 1개라 얇다. 그러나 골드는 multiplicity별 그룹핑이라는 **일반 연산**으로 풀어 특정 입력 하드코딩이 아니다(어떤 차수 분포든 동작). 함정은 "정렬만 맞춰 통과시키기"식 special-case.
- **regression 관점**: `method != 'sqf'`(즉 `factor`)일 때는 후처리를 건너뛰어 `factor_list` 동작은 byte-identical 유지 → `test_factor*` 다수가 보호된다. is_Mul 분기 삭제는 평탄화를 '보존'하는 게 아니라 '제거'한다 — 다인수 경로가 안 깨지는 실제 이유는 삭제된 Mul이 `else` 분기에서 `_poly_from_expr`로 재인수분해되어 동일 인수가 다시 나오기 때문이다. 이 분기 변경이 기존 다인수 경로를 깨지 않는지가 147개 P2P로 검증된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `_symbolic_factor_list`와 정확한 L6218 permalink, 그리고 "generic factor list를 스캔해 같은 multiplicity 인수를 합쳐라"는 처방까지 제공 → polytools.py 헬퍼 함수의 `return coeff, factors` 직전 지점으로 곧장 수렴.
2. **픽스**: 반환 직전 `factors`를 multiplicity 동치류로 partition한 뒤 각 류를 곱으로 축약한다. `sqf`에만 적용해야 하는 이유는 square-free 계약이 그 메서드에만 해당하기 때문(`factor`는 기약 인수를 분리 유지해야 함). 특정 예제가 아니라 multiplicity set 전체를 순회하므로 올바른 일반화.
3. **regression 안전**: `method == 'sqf'` 게이트로 `factor_list` 경로를 완전 보존 — `test_factor`, `test_factor_large`, `test_factor_noeval` 등을 안 깬다. is_Mul 분기 삭제는 다인수 평탄화를 '제거'하지만, 삭제된 Mul이 `else` 분기에서 `_poly_from_expr`로 재인수분해되므로 `test_sqf` 등 다인수 경로의 결과는 동일하게 유지된다(평탄화 보존이 아니라 재인수분해 덕분).
4. **함정 회피**: (a) 후처리를 `sqf`/`factor` 양쪽에 무차별 적용하면 `factor_list`가 기약 인수를 잘못 합쳐 대량 P2P 회귀. (b) `coeff` 처리를 건드리면 부호/상수 인수가 깨짐 — 골드는 `coeff`를 손대지 않는다. (c) FAIL_TO_PASS 1개만 보고 좁은 입력에 맞춘 특수처리를 하면 multivariate/고차 분포에서 실패 — multiplicity별 일반 그룹핑이 정답.
