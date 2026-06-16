---
instance_id: sympy__sympy-14248
repo: sympy/sympy
base_commit: 9986b38181cdd556a3f3411e553864f11912244e
version: "1.1"
difficulty: "1-4 hours"
created_at: "2018-02-17T10:38:44Z"
fail_to_pass: 2
pass_to_pass: 433
gold_files: [sympy/printing/latex.py, sympy/printing/pretty/pretty.py, sympy/printing/str.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`A - A*B - B` 같은 행렬 표현식은 내부적으로 `(-1)*B + (-1)*A*B + A` 형태의 `MatAdd`로 표현되는데, 세 프린터(str/pretty/latex) 모두 음의 계수를 그대로 노출해 `(-1)*B + (-1)*A*B + A`(또는 latex `'-1 B + -1 A B + A'`)처럼 출력된다. 스칼라 `Add`는 이미 `a - b`로 예쁘게 찍는데 `MatAdd`/`MatMul` 경로만 이 부호 정리를 안 한다. 기대 출력은 `-B - A*B + A`처럼 음항을 빼기로 표기하는 것이다.

## 유형 (정형화)
- **L (Localization) = L3**: 이슈가 "str·pretty·latex 세 프린터"를 직접 지목하긴 하나, 픽스가 `printing/str.py`, `printing/latex.py`, `printing/pretty/pretty.py` **3개 파일의 `_print_MatAdd`/`_print_MatMul`을 함께** 일관 수정해야 한다(각 프린터가 독립 구현). 단일 지점 픽스가 아니라 조율된 멀티사이트.
- **S (Strategy) = S2 (+S6)**: 고칠 함수는 명확하나, "각 항을 프린트한 뒤 선두 부호를 검사해 `+`/`-` 토큰으로 재조립" 하는 **올바른 부호 합성 로직**을 추론으로 만들어야 한다(단순 상수 변경 아님). 항 단위로 부호를 추출·재배열하는 작은 구조 변경이 동반되어 보조로 S6.
- **K (Knowledge) = K-Domain**: `MatAdd`/`MatMul` 인자 구조, `as_coeff_mmul()`, `_keep_coeff`, `prettyForm`/`stringPict` 등 sympy 프린팅·행렬식 내부 계약을 알아야 한다.
- **primary_type = T-ConstraintReason**: 위치는 알지만 부호 정리 식을 의미적으로 합성해야 하는 게 본질. L3이라 T-DiffuseLoc도 후보지만, "어디"보다 "어떻게 올바른 부호식을 만드나"가 진짜 난점이라 ConstraintReason이 dominant.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일수 3 / 함수 5(str의 MatMul·MatAdd, latex의 MatAdd·MatMul, pretty의 MatAdd) — 멀티사이트 조율(L3).
- localize 직접성: 중간. 이슈가 프린터 3종을 명시하고 `has-repro`(실행가능 재현 + 정확한 잘못된 출력)가 있어 진입은 쉽지만, 각 프린터의 부호 처리가 미묘하게 달라 동형 수정이 아니다.
- regression: `regression-trap` 강함 — P2P 433개 중 다수가 프린팅 테스트(`test_pretty_*`, `test_latex_*`, `test_ccode_*`, `test_str` 등 전 코드젠 프린터)라 MatAdd/MatMul 출력 한 글자만 바뀌어도 광범위하게 깨진다.
- 도메인: K-Domain.
- 공식 라벨 `1-4 hours`와 일치. 개념은 단순하나 3파일×부호 엣지케이스×넓은 P2P가 시간을 끄는 전형적 T4.

## 골드패치 분석
건드린 파일·함수:
- `str.py::_print_MatMul`: `expr.as_coeff_mmul()`로 계수 분리, `c.is_number and c < 0`이면 `_keep_coeff(-c, m)`로 양수화하고 `sign = "-"` 선두 부착.
- `str.py::_print_MatAdd`: 각 항을 parenthesize한 뒤 `t.startswith('-')`로 부호 추출, `[sign, t]` 토큰 리스트로 재조립. 선두 `+`는 제거.
- `latex.py::_print_MatAdd`: 동일한 `startswith('-')` 기반 토큰 재조립.
- `latex.py::_print_MatMul`: `expr.args[0].is_Number and expr.args[0] < 0`이면 `Mul(-1*coeff, MatMul(*rest))`로 재구성 후 선두 `-` 부착.
- `pretty.py::_print_MatAdd`: `_print_seq(..., ' + ')` 대신 항을 순회하며 `S(item.args[0]).is_negative`면 `+` 없이 공백으로 이어 붙이도록 `prettyForm`/`stringPict.next` 누적.

근본원인: `MatAdd`의 음항은 계수 `(-1)`을 가진 `MatMul`인데, 프린터들이 이를 단순히 `' + '.join`/`_print_seq`로 이어붙여 `(-1)` 계수가 그대로 노출됨. 스칼라 `Add`/`Mul`에 있는 부호 추출이 행렬 경로엔 없었다. 수정요지: (1) `MatMul` 출력에서 음의 선두 계수를 `-` 부호로 흡수하고, (2) `MatAdd`에서 각 항의 선두 부호를 검사해 `+`/`-` 결합자를 선택.

## 검증 (test_patch)
FAIL_TO_PASS는 `test_MatrixElement_printing`(기존 assert 갱신: `((-1)*B + A)` → `(-B + A)`)과 신규 `test_MatrixSymbol_printing` 2개이며, str/pretty/latex 3개 테스트파일과 codegen(ccode/fcode/jscode/julia/octave/rcode) 테스트의 `MatrixElement` 기대값이 일괄 갱신된다. 픽스 증명: `pretty(A*B*C - A*B - B*C) == "-A*B -B*C + A*B*C"`, `latex(A - A*B - B) == r"-B - A B + A"`, `str(A*B - (A+B)) == "-(A + B) + A*B"` 등이 음항 빼기 표기와 괄호·순서를 함께 검증.
- overfit 관점: 단일 special-case가 아니라 단항(`-A`), 다항 혼합, `MatMul` 음계수, 괄호 필요(`-(A+B)`) 케이스를 교차로 덮어 부호 로직의 일반성을 강제 — overfit 위험 낮음.
- regression 관점: codegen 프린터들이 `_print_MatElement`를 통해 str/MatAdd 출력에 의존하므로 그 기대값도 함께 갱신됨. 이는 픽스가 코어 표현(부호 정규화)을 바꾼다는 증거이자, P2P 433개를 안 깨야 하는 trap의 핵심.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `print/pprint/latex` 3종 + `(-1)*B` 출력이라는 신호 → `printing/str.py`, `printing/pretty/pretty.py`, `printing/latex.py`의 `_print_MatAdd`/`_print_MatMul`을 찾는다. 스칼라 `_print_Add`/`_print_Mul`이 이미 부호를 어떻게 빼는지 대조하면 누락 지점이 드러난다.
2. **픽스와 일반화**: `MatAdd` 항 각각을 프린트한 문자열의 선두 `-`(또는 `item.args[0]`의 음수 여부)를 검사해 `+`/`-` 결합자를 고르고, `MatMul`은 음의 선두 계수를 부호로 흡수한다. 이는 "음수=빼기"라는 표기 규칙을 표현식 단위로 적용하므로 임의 케이스가 아닌 올바른 일반화.
3. **regression 안전**: P2P 433개 중 프린팅·codegen 전반(`test_latex_*`, `test_pretty_*`, `test_ccode_*` ...)이 MatAdd/MatMul 출력에 직간접 의존. 양항만 있는 합/곱은 기존과 byte-동일해야 하고(선두 `+` 제거 로직이 이를 보장), `_print_MatElement` 경유 codegen 출력도 갱신값과 정확히 맞아야 한다.
4. **함정 회피**: (a) 세 프린터를 동형으로 베껴 쓰지 말 것 — str는 `as_coeff_mmul`/`_keep_coeff`, latex는 `Mul/MatMul` 재구성, pretty는 `prettyForm/stringPict.next`로 메커니즘이 다르다. (b) 첫 항이 음수면 선두에 `-`를 남기되 `+`는 지워야 함(`l.pop(0)` 후 `+`→`""`). (c) `-(A+B)` 같은 괄호 필요 항에서 precedence를 유지해야 함. (d) 한 프린터만 고치고 끝내면 FAIL_TO_PASS의 나머지 프린터 테스트가 실패한다.
