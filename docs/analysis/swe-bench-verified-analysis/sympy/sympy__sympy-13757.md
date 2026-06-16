---
instance_id: sympy__sympy-13757
repo: sympy/sympy
base_commit: a5e6a101869e027e7930e694f8b1cfb082603453
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-12-17T11:08:44Z
fail_to_pass: 1
pass_to_pass: 166
gold_files: [sympy/polys/polytools.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`Poly`를 표현식과 곱할 때, `Poly`가 곱셈의 **왼쪽**이면(`Poly(x)*x`) 정상적으로 `Poly(x**2, ...)`로 평가되지만, **오른쪽**이면(`x*Poly(x)`) `x*Poly(x, x, domain='ZZ')`로 평가되지 않고 비대칭이 발생한다. 마찬가지로 `S(-2)*Poly(x)`도 평가 안 됨. 좌우 피연산자 순서에 따라 결과가 갈리는 교환법칙 위반 버그다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `Poly`/`Mul` 디스패치를 직접 지목하진 않지만, "왼쪽은 되고 오른쪽은 안 됨"이라는 신호가 곧장 `__mul__`/`__rmul__` 우선순위 디스패치(`_op_priority`)로 수렴한다. grep 한 방은 아니고 sympy의 연산자 디스패치 관례를 알아야 한다.
- **S2 (+S1)**: 고칠 지점은 좁지만, 픽스 자체는 "왜 좌우가 갈리는가"의 불변식 추론이 본질이다. `Expr._op_priority = 10.0`이라, `x.__mul__(Poly)`가 먼저 잡혀 `Poly`를 `Mul` 인자로 흡수해버린다. `Poly.__rmul__`이 먼저 불리게 하려면 `Poly._op_priority`를 10.0보다 **미세하게** 크게 줘야 한다는 도메인 불변식 합성이 핵심(S2). 결과 코드는 상수 한 줄 추가라 형태는 S1처럼 보이지만, 그 상수값과 위치의 정당성은 추론에서 나온다.
- **K-Domain**: sympy core의 `call_highest_priority` 데코레이터 + `_op_priority` 디스패치 규약을 모르면 1줄을 못 짚는다. 일반 파이썬 추론으로 도달 불가.
- **primary = T-DomainBound**: 진짜 병목이 "프레임워크 내부 연산자 디스패치 메커니즘 지식"이라, K-Domain이 dominant.

## 난이도 티어 — T3 (중간)
- 파일 1개(`polytools.py`), 실효 변경 **1줄**(클래스 속성 추가) — scope만 보면 T1~T2.
- 그러나 localize 직접성이 L1이고, 픽스 정당화가 sympy `_op_priority` 디스패치 규약이라는 **도메인 지식**에 의존 → 시간라벨("15분-1시간")과 일치하면서도 에이전트 입장에선 메커니즘 이해가 게이트.
- `has-repro`(이슈에 정확한 REPL 트레이스)로 재현은 자명 → easiness 신호.
- `regression-trap`: P2P 161개(거의 전부 polytools 연산 + match), `_op_priority`를 잘못 올리면 `Poly` 우선순위가 다른 `Expr` 서브클래스와의 디스패치를 깨뜨릴 수 있어 인접동작 보존이 빡세다. 이 trap이 T2가 아닌 T3로 미는 핵심.
- 공식 라벨 "15분-1시간"과 정합. 멀티파일/refactor 없으므로 T4+는 과대.

## 골드패치 분석
- **파일/심볼**: `sympy/polys/polytools.py`, `class Poly(Expr)` 클래스 본문.
- **수정요지**: 클래스 속성 `_op_priority = 10.001` 한 줄 추가(`is_commutative`/`is_Poly` 플래그 옆).
- **근본원인**: `Expr._op_priority = 10.0`(`sympy/core/expr.py:225`). 이항 연산자가 `call_highest_priority` 데코레이터로 감싸져 있어, `x * Poly(x)` 평가 시 `x.__mul__(Poly)`에서 `other._op_priority > self._op_priority` 비교(`decorators.py:114`)가 일어난다. `Poly`가 `_op_priority`를 따로 정의 안 했으니 상속값 10.0으로 동률 → 우선순위 역전이 일어나지 않아 `Poly.__rmul__`로 위임되지 않고, `Symbol.__mul__`이 그대로 `Mul(x, Poly(x))`를 만들어 미평가 상태로 남는다. `Poly(x)*x`(좌측)는 애초에 `Poly.__mul__`이 먼저 잡혀 정상이었음 → 비대칭.
- **수정 메커니즘**: `Poly._op_priority`를 10.001로 올리면, `x.__mul__` 안의 비교에서 `Poly._op_priority(10.001) > Expr._op_priority(10.0)`가 참이 되어 `Poly.__rmul__(x)`로 디스패치 → `Poly`가 곱셈을 흡수해 `Poly(x**2, ...)`로 평가된다. 좌·우 양쪽 모두 `Poly`가 핸들링하게 되어 교환법칙 복원.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_13079`** (신규, `test_polytools.py`): `Poly(x)*x`, `x*Poly(x)`, `-2*Poly(x)`, `S(-2)*Poly(x)`, `Poly(x)*S(-2)` 다섯 케이스가 전부 `Poly(..., domain='ZZ')`로 평가됨을 단언. 좌/우 양변 + sympy 정수형(`S(-2)`)까지 커버해 비대칭과 우선순위 경로를 모두 찌른다.
- **회귀 단언 변경**: `test_match.py::test_mul`에서 `(I*Poly(x,x)).match(I*p)` 기대값이 `{p: Poly(x,x)}` → `{p: x}`로 바뀜. 이건 버그가 아니라 **올바른 부수효과**: 이제 `I*Poly(x)`가 `Poly`로 평가되므로 매칭이 `Poly`가 아닌 일반항 `x`를 잡는다. 픽스가 의미적으로 전파됨을 증명하는 oracle.
- **overfit 관점**: FAIL_TO_PASS는 1개지만 5개 단언이 좌/우/음수상수/sympy-Integer를 교차 검증해 special-case 통과가 어렵다. 단, 다른 `Expr` 서브클래스(MatrixExpr 등)와의 디스패치는 미검증 → 잠재 overfit-risk는 낮지만 0은 아님.
- **regression 관점**: P2P 161개(`test_Poly_mul`, `test_Poly_add`, `test_match_*` 등)가 전부 통과해야 함 → `_op_priority` 상향이 기존 `Poly` 연산/매칭을 깨지 않음을 광범위 보장.

## 모범답안 (오라클 기반)
1. **localize 경로**: "왼쪽은 평가, 오른쪽은 미평가"라는 비대칭 신호 → 파이썬 이항연산자 `__mul__`/`__rmul__` 디스패치를 의심. sympy에서 좌우 피연산자 우선순위를 가르는 건 `Expr._op_priority` + `call_highest_priority`(`sympy/core/decorators.py`)임을 안다. `Poly(Expr)`가 `_op_priority`를 오버라이드 안 했다는 걸 확인 → `polytools.py`의 `Poly` 클래스 본문이 수정지점.
2. **픽스와 일반화 정당성**: `Poly._op_priority = 10.001`. `Expr` 기본 10.0보다 **미세하게만** 높여, `x*Poly`에서 `Poly.__rmul__`이 우선 호출되게 함. 좌측 `Poly*x`는 이미 동작했으므로 이 변경은 우측 경로만 교정 → 교환법칙이라는 **일반 불변식**을 만족시키는 최소·정확 수정(특정 입력 하드코딩 아님).
3. **regression 안전**: P2P 161개 중 `test_Poly_mul`/`test_Poly_add`/`test_Poly_sub` 등 `Poly`-`Poly` 연산과 `test_match_*` 매칭군을 안 깨야 한다. 우선순위를 10.001로 **최소 증분**만 줘서, `Poly`보다 높은 우선순위를 가진 클래스(있다면)와의 기존 디스패치 서열을 보존하는 게 핵심. 1.0 같은 큰 값으로 올리면 다른 디스패치를 의도치 않게 뒤집을 수 있음.
4. **함정 회피**: (a) 증상만 보고 `Poly.__rmul__`/`Mul.flatten`에 특수 케이스 분기를 추가하려는 유혹 — 디스패치 자체가 위임되지 않아 그 코드가 안 불리므로 무효. 근본은 우선순위. (b) `_op_priority`를 과하게(예: 11.0, 100.0) 올려 다른 `Expr` 서브클래스와의 상대 서열을 깨는 regression. (c) `test_match.py`의 기대값 변경을 "내 픽스가 매칭을 깬다"로 오해해 픽스를 되돌리는 것 — 실제론 올바른 평가 전파의 결과이므로 테스트 기대값을 따라가야 한다.
