---
instance_id: sympy__sympy-20428
repo: sympy/sympy
base_commit: c0e85160406f9bf2bcaa2992138587668a1cd0bc
version: "1.8"
difficulty: "15 min - 1 hour"
created_at: 2020-11-14T05:56:31Z
fail_to_pass: 1
pass_to_pass: 154
gold_files: [sympy/polys/domains/expressiondomain.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L2
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`clear_denoms()`가 복잡한 상수 poly(실제로는 0)에 대해 `Poly(0, x, domain='EX')`처럼 출력되지만 `is_zero`는 `False`, 내부 `rep`은 strip 안 된 `DMP([EX(0)], EX, None)` 상태로 남는다(정상은 `DMP([])`). 이 unstripped leading-zero 때문에 `terms_gcd()`는 `IndexError`, 구버전 `primitive()`는 `ZeroDivisionError`(#17990의 직접 원인)를 던진다. 근본은 DMP strip이 계수가 0인지 판정할 때 EX 계수의 0 판정이 잘못된 것.

## 유형 (정형화)
- **L = L2 (Diffuse)**: 이슈는 증상을 `polytools`/`densebasic`/`monomials` 스택트레이스로 보여주지만, 진짜 결함은 그 어디도 아닌 `expressiondomain.py`의 `Expression.__bool__`에 있다. 증상 스택과 수정 지점이 분리되어 cross-module 데이터플로우(DMP strip이 `__bool__`/`!=`로 zero를 판정 → EX의 `!= 0`이 미평가식에 잘못된 truthy를 반환) 추적이 필요. grep 한 방이 아님.
- **S = S2 (Constraint-Reasoning)**: 후보 패치를 마구 시도하는 게 아니라, "`f.ex != 0`이 미단순화 expression에서 왜 잘못된가 → 구조적 부등식이 아니라 SymPy의 수학적 zero 판정(`is_zero`)을 써야 strip이 올바르게 동작한다"는 불변식 추론으로 정확한 조건을 합성. 한 줄이지만 의미적 합성.
- **K = K-Domain**: sympy polys 도메인 시스템(DMP strip 규약, EX 도메인의 `Expression` 래퍼, `Basic.is_zero` 3치 논리 vs `!= 0` 구조비교)을 알아야 옳은 식을 찾는다.
- **primary = T-ConstraintReason**: 위치는 결국 한 줄이지만 핵심 난점이 "올바른 zero-판정 식을 도메인 의미론으로부터 추론 합성"하는 데 있다.

## 난이도 티어
**T4 (약간 어려움).** 구조 피처: 수정 파일 1개·실질 1줄 변경이라 patch scope는 T1~T2급이지만, 두 가지가 티어를 위로 민다. (1) **localize 직접성 낮음(L2)** — 이슈의 모든 스택트레이스(`terms_gcd`, `primitive`, `monomial_min`)는 *증상* 코드를 가리키고 실제 결함은 EX 도메인의 boolean 변환이라, 후보를 따라가면 엉뚱한 곳을 고치게 된다. (2) **regression-trap 강함** — `__bool__`은 EX 계수의 truthiness가 쓰이는 모든 경로(DMP strip 전반)에 영향을 줘 PASS_TO_PASS 154개가 안 깨져야 한다. has-repro(이슈에 완전한 재현 입력과 기대 `rep` 형태까지 명시)는 easiness 신호라 T5까지는 안 가고 T4. 공식 라벨 "15분~1시간"과 일치 — 구현은 한 줄이나 진단(왜 strip이 실패하는가)에 시간이 든다.

## 골드패치 분석
- **파일/심볼**: `sympy/polys/domains/expressiondomain.py`, `ExpressionDomain.Expression.__bool__(f)`.
- **근본원인**: `Expression.__bool__`이 `return f.ex != 0`. EX 도메인의 계수 `f.ex`는 SymPy 식이고, 위의 재현 입력처럼 자동 단순화되지 않은 복잡한 식(실제로는 0이지만 구문상 0이 아님)에서는 `f.ex != 0`이 *구조적 부등식 비교*로 truthy를 반환한다. DMP strip 루틴은 계수가 falsy면 leading-zero를 떼는데, 이 잘못된 truthy 때문에 `DMP([EX(0)])`가 strip되지 않고 `DMP([])`로 정규화되지 못한다 → unstripped zero poly.
- **수정요지**: `return not f.ex.is_zero`. SymPy의 수학적 zero 판정(`Basic.is_zero`, 단순화/assumptions 기반)을 써서 "실제로 0인 식"을 falsy로 만든다. 그러면 strip이 leading-zero를 제거하고 zero poly가 canonical `DMP([])`로 정규화 → `is_zero`, `terms_gcd`, `primitive` 모두 정상.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_20427`**: 이슈의 그 복잡한 상수식을 `Poly(..., x)`로 만든 `f`에 대해 `assert f == Poly(0, x, domain='EX')`. 패치 전에는 `f.rep`이 `DMP([EX(0)])`라 canonical zero와 동치가 아니어서(또는 비교 경로에서 inconsistency) 실패하고, 패치 후 strip이 동작해 `DMP([])`로 정규화되어 동치 성립.
- **픽스 증명**: `==`는 정규화된 rep 비교에 의존하므로, `__bool__`이 올바른 zero 판정을 하면 zero poly가 유일한 canonical 형태로 수렴해 테스트가 통과한다.
- **overfit/regression 관점**: 패치가 단일 테스트에 special-case가 아니라 도메인 전체의 zero 판정 의미론을 고친 일반화라 overfit 위험 낮음. 대신 `not f.ex.is_zero`는 `is_zero`가 `None`(미결정)을 반환할 수 있는 식에서 `not None == True`로 falsy처럼 처리될 위험이 있으나, EX 계수 맥락에서 결정 가능한 식이 지배적이라 154개 P2P(특히 `test_Poly_clear_denoms`, `test_terms_gcd`, `test_primitive`, `test_Poly_nonzero`)가 모두 green인 것으로 안전성이 입증된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 준 결정적 신호는 스택트레이스가 아니라 마지막의 `bad_poly.rep == DMP([EX(0)])` vs `Poly(0,x,domain="EX").rep == DMP([])` 대비다. 여기서 "strip이 안 됐다"를 읽고, strip이 계수 falsy를 어떻게 판정하는지로 거슬러 올라가면 EX 도메인 계수의 boolean 변환 = `ExpressionDomain.Expression.__bool__`에 도달. 스택트레이스(`terms_gcd`/`primitive`)를 따라가면 *증상*만 패치하게 되는 함정.
2. **픽스와 일반화 근거**: `f.ex != 0`(구문적 부등식)을 `not f.ex.is_zero`(수학적 zero)로 교체. 미단순화 식의 0 여부는 구조비교가 아니라 SymPy assumptions로 판정해야 옳다 — 이게 한 테스트가 아닌 EX zero 판정 전반에 맞는 일반화.
3. **regression 안전**: `__bool__`은 EX 계수 truthiness가 쓰이는 모든 곳에 영향. 정상(비-zero) 계수는 `is_zero=False`라 `not False=True`로 기존과 동일 truthy를 유지해야 하고, `test_Poly_nonzero`/`test_Poly_clear_denoms`/`test_terms_gcd`/`test_primitive` 등 154 P2P가 그 보존을 강제한다.
4. **함정 회피**: (a) 스택트레이스 표면(`monomial_min` IndexError)을 고치려 `densebasic`/`monomials`에 가드를 넣으면 증상만 가리고 근본 unstripped-zero는 남음 — 다른 메서드에서 재발. (b) `clear_denoms` 자체에 strip을 강제하는 국소 패치도 overfit. (c) `is_zero`가 `None`을 줄 수 있는 식에서 `not None`이 zero로 오판되는 코너를 의식해야 하나, 도메인 의미상 EX 계수 0 판정이 본질이므로 `is_zero`가 정답 — 오라클이 이를 확인.
