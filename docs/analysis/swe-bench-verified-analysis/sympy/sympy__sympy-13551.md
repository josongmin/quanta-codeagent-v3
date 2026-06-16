---
instance_id: sympy__sympy-13551
repo: sympy/sympy
base_commit: 9476425b9e34363c2d9ac38e9f04aa75ae54a775
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-10-29T20:51:01Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [sympy/concrete/products.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`Product(n + 1/2**k, (k, 0, n-1)).doit()`가 잘못된 닫힌형을 반환한다. 예컨대 `n=2`면 실제 곱은 `(2+2^0)*(2+2^(-1)) = 15/2`인데 sympy는 `9/2`를 준다. 근본은 `_eval_product`의 `is_Add` 가지가 "합의 곱 = 곱들의 합"이라는 거짓 항등식을 적용하는 것(코드 위 주석이 직접 경고하는 케이스). 분자 `p`가 `is_Number`가 아닌 분모를 못 만나는 경로에서 `p.as_coeff_Add()` 항들을 각각 곱한 뒤 더해버려 분배법칙을 망가뜨린다.

## 유형 (정형화)
- **L (Localization) = L0**: hints가 `products.py` line 286을 정확히 지목하고, 위 주석이 바로 그 버그 클래스를 묘사한다. 함수 `_eval_product`의 `is_Add` 분기 단 한 곳. grep 한 방.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 위치는 자명하나, 올바른 대체식을 *수학적 추론으로 합성*해야 한다. 단순 가드 추가가 아니라 "합의 곱은 분배되지 않는다 → 로그-합으로 변환 후 지수화" (`exp(Sum(log(p), (k,a,n)))`)라는 항등식을 떠올려야 한다. 후보를 여러 개 던져 테스트로 고르는 G&V가 아니라 한 번에 옳은 변환을 추론하는 SemFix류.
- **K (Knowledge) = K-Domain**: sympy concrete(곱/합) 내부와 `Product↔Sum` rewrite 관례(`exp(Sum(log(...)))`)를 알아야 한다. 일반 파이썬 지식만으론 안 됨.
- **Primary = T-ConstraintReason**: L0로 위치는 거의 공짜인데 난점이 전적으로 "올바른 식 합성"에 있다. T-DirectMap(기계적 가드)이 아닌 이유는 픽스가 상수/None가드가 아니라 의미적 항등식 교체이기 때문.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일 / 2줄 / localize 직접성 최상(L0, 라인번호 명시) / has-repro 강함(이슈에 실행 가능한 반례 + 기대값). 그러나 픽스 도출이 비자명한 수학적 추론(S2)이라 T2(쉬움, 가벼운 엣지추론)보다 한 단계 위. P2P 17개로 곱셈 평가 전반(`test_rational_products`, `test_special_products`, `test__eval_product`, `test_issue_9983`)을 안 깨야 해 regression-trap이 약하지 않다. 공식 라벨 "15분-1시간"과 정합. L0+has-repro라 T4까지 밀 근거는 없음(멀티사이트·도메인 깊이·overfit 고위험 부재).

## 골드패치 분석
- **파일·함수**: `sympy/concrete/products.py`의 `Product._eval_product`, `term.is_Add` 가지 내부.
- **근본원인**: `q = as_numer_denom()` 분모가 `is_Number`인 경로에서 분자 `p`를 `p = sum([self._eval_product(i, (k,a,n)) for i in p.as_coeff_Add()])`로 처리. 이는 `∏(a+b) = ∏a + ∏b`를 가정 — 곱은 덧셈에 분배되지 않으므로 수학적으로 틀림. 위 주석조차 "We have to catch this case"라며 이 분해를 부정확한 임시처리로 인정하고 있었다.
- **수정요지**: 그 두 줄을 `from sympy.concrete.summations import Sum; p = exp(Sum(log(p), (k, a, n)))`로 교체. 즉 `∏ p = exp(Σ log p)`라는 항상 성립하는 항등식으로 분자를 평가. `Sum`이 닫힌형을 못 찾으면 symbolic하게 남아 잘못된 답 대신 미평가(정확한) 형태를 유지한다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_13546`** (1개): `Product(n + 1/2**k, (k, 0, n-1)).doit()`을 만든 뒤 `p.subs(n, 2).doit() == S(15)/2`를 단언. 픽스 전엔 `9/2`(분배오류) → fail, 픽스 후엔 로그-합 경로가 정확한 곱을 산출 → pass. 픽스가 버그의 인과(거짓 분배)를 직접 제거함이 증명된다.
- **overfit 관점**: `exp(Σ log)`는 special-case가 아닌 곱→합 보편 변환이라 `n=2` 한 점에 끼워맞춘 게 아니다. FAIL_TO_PASS가 1개로 얇지만 픽스가 일반 항등식이라 overfit 위험 낮음.
- **regression 관점**: 기존 `is_Number 분모` 경로를 타던 `is_Add` 합표현 전부가 새 경로로 흐른다. P2P의 `test_rational_products`, `test__eval_product`, `test_issue_9983`(역시 `as_numer_denom` 경유 `n**(2/3)` 케이스)가 그대로 통과해야 회귀 없음을 보장 — 실제 17개 P2P 유지.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `concrete/products.py` line 286과 "product of a sum = sum of products" 가정을 명시 → `_eval_product`의 `elif term.is_Add:` 블록, 특히 `p = sum([... p.as_coeff_Add()])` 라인으로 즉시 수렴. 위 주석이 이미 자기 고백을 하고 있어 확정.
2. **픽스와 일반화 정당성**: 잘못된 분배 합산을 `exp(Sum(log(p), (k, a, n)))`로 교체. 이는 임의의 항에 대해 `∏ p = exp(Σ log p)`로 항상 참인 변환이므로 단일 입력에 맞춘 hack이 아니다. closed-form이 없으면 미평가 `Sum`으로 남아 "틀린 값"보다 "정직한 symbolic"을 택하는 점이 핵심.
3. **regression 안전**: 같은 `is_Add` 경로의 다른 입력(`test_issue_9983`의 `1 + 1/n**(2/3)`, 유리식 곱들)이 새 경로에서도 올바른 결과를 내야 한다. `Sum`/`log`/`exp` import 순환을 피하려 함수 내부 지연 import를 쓴 점까지 그대로 따라야 P2P 17개가 산다.
4. **함정 회피**: (a) 오라클 없는 에이전트는 `is_Number` 가드를 더 엄격히 다는 식의 *증상 봉합*에 빠지기 쉽지만, 그건 거짓 항등식을 그대로 두는 것 → 다른 합표현에서 재발. 반드시 합산식 자체를 로그-합으로 교체해야 한다. (b) 모듈 최상단에 `from sympy.concrete.summations import Sum`를 두면 순환 import 위험 → 골드처럼 함수 로컬 import로 회피. (c) FAIL_TO_PASS가 단 1개라 `n=2`만 통과시키는 특수분기 유혹이 있으나, 이는 overfit이며 P2P 회귀로 드러난다.
