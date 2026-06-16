---
instance_id: sympy__sympy-21612
repo: sympy/sympy
base_commit: b4777fdcef467b7132c055f8ac2c9a5059e6a145
version: "1.9"
difficulty: "15 min - 1 hour"
created_at: 2021-06-14T04:31:24Z
fail_to_pass: 1
pass_to_pass: 98
gold_files: [sympy/printing/str.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`parse_latex("\\frac{\\frac{a^3+b}{c}}{\\frac{1}{c^2}}")` 가 `((a**3 + b)/c)/1/(c**2)` 로 출력되어, 분모 `1/c**2` 가 괄호 없이 풀려 수식 의미가 깨진다. 이슈 본문은 파싱 버그처럼 보이지만, hints에서 `args` 가 `(a, 1/(1/b))` 로 올바름이 확인되어 **str printer(`StrPrinter._print_Mul`)의 괄호 누락**이 진짜 원인임이 밝혀졌다. 즉 `x/(1/y)` 형태를 `x/1/y` 로 출력하는 분모 괄호화 결함.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈는 "parsing" 을 지목하나, hints가 `str()` 출력 결함으로 재지목해 `sympy/printing/str.py` 의 `_print_Mul` 단일 함수로 좁혀진다. grep 한 방은 아니고 `args` 점검이라는 1단계 추론이 필요 → L1.
- **S2 (Constraint-Reasoning)**: 고칠 지점(`pow_paren` 수집 조건)은 명확하지만, "분모로 들어가는 `Pow(base, -1)` 의 base가 `Mul` 일 때만 괄호" 라는 기존 불변식이 **base가 `Pow`(예: `1/y`)인 경우를 빠뜨린다**는 점을 추론해 조건을 일반화해야 한다. 후보를 마구 던지는 G&V가 아니라 "왜 괄호가 필요한가"를 따지는 의미 추론.
- **K-Domain**: SymPy expr 트리(`as_base_exp`, `Pow`/`Mul` 구분, `evaluate=False` 비정규형)와 str printer의 분자/분모 분리 로직 이해 필요.
- **primary = T-ConstraintReason**: 위치는 잡혔으나 핵심은 "어떤 base 타입이 괄호 보호를 받아야 하는가"라는 조건식의 올바른 일반화. 한 줄 픽스지만 기계적 가드가 아니라 정확한 술어 합성이라 S2.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개 / 함수 1개 / 실효 1줄 변경 → scope는 T1~T2 급.
- 그러나 **localize 직접성이 낮음**: 이슈가 잘못된 축("parsing")을 가리켜 printer로 재귀착하는 도메인 추론이 필요. has-repro는 있으나 재현 출력이 오답을 가리키는 방향이라 오도 위험.
- P2P 100개가 전부 printing 테스트(`test_Pow`, `test_Rational`, `test_sqrt`, `test_Mul` 자기 자신 등)라 **regression-trap**: 괄호 조건을 넓히면 정상 케이스에 군더더기 괄호가 생길 수 있어 정밀해야 함.
- 공식 라벨 "15분~1시간"과 일치하나, 실제 난점은 코드량이 아니라 "parsing이 아니다"를 깨닫는 재지목 + 조건 일반화의 정밀성. T2가 아니라 T3로 미는 건 이 misdirection과 P2P trap.

## 골드패치 분석
- **파일·함수**: `sympy/printing/str.py`, `StrPrinter._print_Mul` 내부 분모 처리 분기.
- **근본원인**: 분모 인자가 `Pow(base, -1)`(exp가 `S.NegativeOne`)일 때, 그 base를 `b` 리스트에 넣고 나중에 `pow_paren` 목록을 통해 괄호로 감싼다. 그런데 괄호 대상 수집 조건이 `isinstance(item.base, Mul)` 로 **`Mul` base만** 보호했다. base가 `Pow`(예: `1/y = Pow(y,-1)`)인 경우는 누락되어, `x * (1/y)**-1` 가 `x/1/y` 로 출력 — `1/y` 가 단일 항이 아닌데도 괄호를 못 받음.
- **수정요지**: 수집 조건을 `isinstance(item.base, (Mul, Pow))` 로 확장. `len(item.args[0].args) != 1` 가드(복합 항만)는 그대로 두어, base가 단순 심볼인 경우엔 여전히 괄호를 추가하지 않는다. 이렇게 `pow_paren` 에 들어간 항만 후처리 루프에서 `b_str[...] = "(%s)"` 로 감싸진다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_Mul`** (1개). 추가 단언: `str(Mul(x, Pow(1/y, -1, evaluate=False), evaluate=False)) == 'x/(1/y)'`. 패치 전엔 `x/1/y`(오답), 후엔 `x/(1/y)`. `1/y` 의 base가 `Pow` 라서 새 조건에서 `pow_paren` 에 수집되어 괄호가 붙는다 → 픽스 증명.
- **overfit 관점**: FAIL_TO_PASS가 단 1 단언이라 얇지만, 픽스가 "Pow base 추가"라는 타입 일반화여서 special-case 하드코딩이 아님. `Mul` 직전 케이스(`-2*x/(y*y)`)도 같은 루프에서 회귀 없이 유지됨이 인접 단언으로 보장.
- **regression 관점**: P2P 100개 중 `test_Pow`/`test_sqrt`/`test_Rational`/`test_Mul` 가 분모·거듭제곱 출력을 폭넓게 커버. `len(...args) != 1` 가드가 살아 있어 단일 base(예: `1/x` 단독)엔 괄호가 안 붙어 군더더기 괄호 회귀를 막는다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 "parsing" 이라 주장하지만, 먼저 `parse_latex(...).args` 를 찍어 표현식 트리가 `(a, 1/(1/b))` 로 **정확함**을 확인 → 결함을 파서가 아닌 `str()` 출력으로 재지목. `StrPrinter._print_Mul` 의 분모(`b`)·`pow_paren` 괄호화 로직으로 수렴.
2. **픽스와 일반화 근거**: 괄호 보호가 필요한 건 "분모로 가는 `Pow(base,-1)` 의 base가 그 자체로 나눗셈/곱 우선순위를 갖는 복합식"일 때. `Mul` 만 보던 술어를 `(Mul, Pow)` 로 넓히는 게 올바른 일반화 — `1/y`(=`Pow`)도 괄호 없이는 `/1/y` 로 결합법칙이 깨지기 때문. special-case 문자열 매칭이 아니라 타입 술어 확장이라 overfit 아님.
3. **regression 안전**: `test_Pow`, `test_sqrt`, `test_Rational`, 기존 `test_Mul`(`-2*x/(y*y)`) 등 printing P2P를 안 깨야 함. `len(item.args[0].args) != 1` 다중-항 가드를 유지해 단순 base에 괄호가 새지 않게 하는 것이 핵심.
4. **함정 회피**: 오라클 없는 에이전트는 (a) 이슈 문구를 곧이곧대로 믿고 `sympy/parsing/latex` 를 뒤지다 헛수고하거나, (b) `_print_Mul` 을 찾아도 마지막 `len(b)==1`/`else` 출력 분기에 즉흥 괄호를 박아 `x/(1/y)` 외 케이스에 과도 괄호 회귀를 내기 쉽다. 정답은 `pow_paren` **수집 조건** 한 곳만 타입 확장하는 것 — 후처리 괄호 루프가 이미 존재하므로 출력 분기는 건드릴 필요가 없다.
