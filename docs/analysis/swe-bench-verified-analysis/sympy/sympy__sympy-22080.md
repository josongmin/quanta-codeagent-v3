---
instance_id: sympy__sympy-22080
repo: sympy/sympy
base_commit: 3f8c8c2377cb8e0daaf8073e8d03ac7d87580813
version: "1.10"
difficulty: "15 min - 1 hour"
created_at: 2021-09-12T07:11:33Z
fail_to_pass: 3
pass_to_pass: 91
gold_files: [sympy/printing/codeprinter.py, sympy/printing/precedence.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`lambdify(..., modules=[])`로 `-Mod(x, y)` 같은 식을 코드 생성하면 `-x % y`가 나와, `%`가 `-`보다 먼저 묶여 `-(x % y)`가 아닌 `(-x) % y`로 평가된다. 즉 단항 마이너스와 모듈로의 연산자 우선순위가 어긋나 결과가 틀린다(`f(3,7)`이 `-3`이어야 하는데 `4`). 근본 원인은 `Mod`가 `Function` 서브클래스라 `precedence(Mod)`가 `PRECEDENCE_VALUES["Function"]→PRECEDENCE["Func"]=70`을 반환한 것이다 — 즉 "가중치 없음/약함"이 아니라 `Pow(60)`·`Mul(50)`보다 높은 **가장 강한** 우선순위였다. 이 `prec=70`이 너무 높아 `Mod`가 `Mul`의 자식(`-Mod(x,y)=Mul(-1, Mod(x,y))`)으로 들어갈 때 괄호가 안 씌워져 `-x % y`가 나온 것이고, 동시에 단항 마이너스 경로가 자식을 적절한 prec로 괄호화하지 않은 것이 합쳐졌다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈와 힌트가 "printer has precedence order wrong for - and %"로 좁혀줌. `pycode(-Mod(x,y)) == '-x % y'` 재현이 `printing/precedence.py`와 코드 프린터의 `parenthesize`로 바로 수렴. 단 정확한 두 수정 지점(Mod 가중치 + 단항 마이너스 분기)을 짚으려면 약간의 탐색 필요 → L0 아님.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 명확하나, "올바른 우선순위 값"을 추론으로 합성해야 함. 단항 마이너스는 SymPy 클래스가 없어 고정 PRECEDENCE 항이 없고, Python 단항 `-`가 `*`와 `**` 사이 우선순위라는 사실에서 `0.5*(PRECEDENCE["Pow"]+PRECEDENCE["Mul"])` 가중치를 도출. G&V로 때려맞추는 게 아니라 불변식 추론. K 힌트들이 "Mod를 Mul보다 작게(45? 49?)" 식으로 단순 매핑을 시도했다가 `-Mod` 회귀로 실패한 것이 S2 성격을 입증.
- **K-Domain (sympy printing 내부)**: PRECEDENCE/PRECEDENCE_VALUES 매핑 체계, `_print_Mul`의 a/b 분리, `parenthesize` 계약 등 프린터 도메인 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 잡히지만 핵심 난점이 "단항 마이너스의 올바른 weight를 의미적으로 합성"이라서.

## 난이도 티어
**T4 (약간 어려움)**. 구조 피처: 2파일/2헌크, 총 ~10줄로 작지만 두 변경이 **함께** 맞아야 함(`Mod` 가중치 + `_print_Mul` 단항분기) → cross-file-dep. has-repro로 localize는 쉬우나, 올바른 weight 추론(S2)과 넓은 P2P trap(90개, 프린터/lambdify 전반 출력 문자열에 민감)이 난이도를 끌어올림. 단순 "Mod 우선순위만 낮추기"는 `-Mod` 케이스에서 깨지는 함정이 있어 T2~T3을 넘는다. 공식 라벨 "15분-1시간"과 정합(작은 패치지만 우선순위 추론·회귀 주의 필요).

## 골드패치 분석
- **`sympy/printing/precedence.py`**: `PRECEDENCE_VALUES`에 `"Mod": PRECEDENCE["Mul"]` 추가 → `precedence(Mod)`를 `Func=70`에서 `Mul=50`으로 **하향**. 효과 대상은 `-Mod(x,y)` 즉 "`Mod`가 `Mul`의 자식"인 경우다: 이때만 codeprinter 단항분기의 `parenthesize(Mod, 55)`가 `50<=55=True`로 `Mod`를 괄호화할 수 있게 된다(`prec=70`이면 `70<=55=False`라 안 됨). 즉 이 변경은 codeprinter 단항분기의 **전제조건(prerequisite)**이다. (반면 `Mod(-x, y) → (-x) % y`는 패치 전에도 정상 — 자식 `-x`의 괄호화는 `Mod` 자체 precedence와 무관하게 `precedence_Mul(-x)=Add=40`이라 항상 괄호됨.)
- **`sympy/printing/codeprinter.py`**: import에 `PRECEDENCE` 추가. `_print_Mul`에서 단항 마이너스(`len(a) == 1 and sign == "-"`)일 때, 인자를 `self.parenthesize(a[0], 0.5*(PRECEDENCE["Pow"]+PRECEDENCE["Mul"]))`로 출력하도록 분기. 단항 `-`에는 SymPy 클래스가 없어 고정 precedence가 없으므로, Python 단항 마이너스가 `*`와 `**` 사이라는 점을 weight 55로 근사.
- **근본원인**: (1) `Mod`는 `Function` 서브클래스라 명시 항이 없어 `precedence(Mod)=PRECEDENCE["Func"]=70`이 되었다 — "약함"이 아니라 `Pow(60)`·`Mul(50)`보다 **높은 가장 강한** 우선순위. 이 70이 너무 높아 `Mod`가 `Mul`의 자식(`-Mod(x,y)=Mul(-1,Mod)`)일 때 괄호가 안 씌워졌다. 골드패치는 `Mod`를 50(=Mul)으로 **낮춰** 자식일 때 괄호가 씌워지게 한다. (2) 단항 마이너스 경로가 자식을 적절한 prec로 괄호화하지 않아 `-(x % y)` 대신 `-x % y`를 생성. 두 결함이 합쳐져 우선순위 역전.

## 검증 (test_patch)
- **`test_PythonCodePrinter`**: `prntr.doprint(-Mod(x, y)) == '-(x % y)'`, `prntr.doprint(Mod(-x, y)) == '(-x) % y'` — 두 방향(부호가 밖/안)을 모두 고정해 단순 우선순위 하향으로 over-correct 못하게 막음.
- **`test_empty_modules`**: `expr = -(x % y)`에 대해 `lambdify(modules=[])`와 `no_modules`가 동일(`-3`)인지 — 이슈의 원래 증상을 직접 검증.
- **`test_create_expand_pow_optimization`**: `cc(-x**4) == '-(x*x*x*x)'`, `cc(x**4 - x**2) == '-(x*x) + x*x*x*x'`, `cc(x**i - x**2) == 'pow(x, i) - (x*x)'` — 단항 마이너스 분기가 Pow 전개 출력에도 괄호를 넣게 되어 기존 기대값이 갱신됨(부수효과를 명시적으로 oracle화).
- **overfit/regression**: FAIL_TO_PASS 3개가 두 부호방향 + lambdify 의미 + Pow전개를 모두 커버해 special-case 통과 어려움. 다만 weight `55` 자체의 경계값은 미검증 → 약한 overfit-risk. P2P 90개(프린터/lambdify 출력 문자열)가 회귀 트랩이라 괄호 추가가 인접 출력을 깨지 않아야 함이 핵심 안전조건.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈의 `pycode(-Mod(x, y)) == '-x % y'` 재현 + 힌트 "precedence order wrong for - and %"에서 `sympy/printing/precedence.py`(PRECEDENCE_VALUES)와 코드 프린터의 곱셈/단항 출력 경로(`codeprinter._print_Mul`)로 직행.
2. **픽스와 일반화**: `Mod`의 precedence를 `Func=70`에서 `PRECEDENCE["Mul"]=50`으로 **낮춰**(약한 % 를 끌어올리는 게 아니라, 너무 강했던 70을 Mul급으로 하향) `Mod`가 부모 `Mul`의 자식으로서 괄호 대상이 되게 하고, 단항 마이너스 분기에서 자식을 `0.5*(Pow+Mul)=55` weight로 괄호화. 이는 "Python 단항 `-`가 `*`와 `**` 사이"라는 언어 명세를 코드화한 것이라 임의 상수가 아닌 올바른 일반화 — `-(x % y)`와 `(-x) % y` 두 방향을 동시에 옳게 만든다.
3. **Regression 안전**: P2P 90개(NumPy/SciPy/Mpmath 프린터, lambdify 전반, Pow 전개)의 출력 문자열을 깨면 안 됨. 단항 분기를 `len(a)==1 and sign=="-"`로만 좁게 적용하고, `Mod` weight를 Mul과 **동일**하게 둠으로써 비-Mod 곱셈 출력은 그대로 유지.
4. **함정 회피**: 힌트들이 보여준 오답 경로 두 가지를 피해야 한다 — (a) "Mod precedence를 Mul보다 작게(45/49)" 단순 하향은 `-Mod(x,y)` 같은 음계수 케이스에서 다시 깨짐(coeff 음수 시 Mul precedence가 40으로 떨어지는 규칙과 충돌). (b) lambdify.py의 `modules is None` vs `len(modules)==0` 분기를 손대는 것은 증상의 트리거일 뿐 근본원인이 아니라 프린터 우선순위를 안 고치면 `pycode` 자체가 여전히 틀림. 정답은 프린터 우선순위 두 지점을 함께 고치는 것.
