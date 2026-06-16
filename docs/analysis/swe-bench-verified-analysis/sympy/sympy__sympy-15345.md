---
instance_id: sympy__sympy-15345
repo: sympy/sympy
base_commit: 9ef28fba5b4d6d0168237c9c005a550e6dc27d81
version: "1.4"
difficulty: "<15 min fix"
created_at: 2018-10-05T06:00:31Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [sympy/printing/mathematica.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`mathematica_code(Max(x, 2))`가 유효한 Mathematica 코드 `Max[x, 2]`가 아니라 `Max(2, x)`(소괄호 + 인자 재정렬)를 출력한다. `Max`/`Min`은 Wolfram에 동명 함수가 존재하므로 `Max[...]`/`Min[...]` 대괄호 호출로 인쇄돼야 한다. 이슈는 출력이 사실상 SymPy의 기본 `str` 표현(unevaluated expression)으로 떨어지고 있음을 정확히 지목한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `mathematica.py`라는 파일을 명시하고 잘못된 출력 문자열도 준다. 다만 "왜 `_print_Function`을 안 타는가"는 `Max`의 클래스 계층(`MinMaxBase`)을 추적해야 드러나므로 L0(grep 한 방)보다 한 단계 위. has-repro라 후보 수렴은 빠름.
- **S2 (+S1)**: 핵심은 "왜 폴백되는가"를 추론하는 것 — `Max`는 `Function`이 아니라 `MinMaxBase(Expr, LatticeOp)` 서브클래스라 `_print_Function` 디스패치가 안 걸린다는 의미적 진단(S2). 진단만 끝나면 픽스 자체(테이블 등록 + 메서드 alias)는 기존 패턴 복제라 기계적(S1).
- **K-Domain**: SymPy printer 디스패치 규칙(`_print_<ClassName>` MRO 탐색)과 `Max`/`Min`이 `Function` 트리 밖이라는 도메인 사실을 알아야 올바른 hook 지점을 찾는다.
- **primary = T-ConstraintReason**: 위치는 거의 주어졌으나, 올바른 픽스를 도출하려면 "기존 known_functions 경로가 왜 안 잡았나 → printer 메서드 이름 규칙"이라는 제약 추론이 본질. S1 템플릿만으로는(테이블에 `Max`만 추가) 디스패치가 여전히 안 걸려 미완성.

## 난이도 티어
**T3 (중간)** — 공식 라벨은 `<15 min fix`(T1~T2 prior)이지만 한 칸 상향.
- 파일 1개, 골드 패치 4줄 추가 → 구조 컷은 명백히 쉬움 쪽(48% solve 구간).
- has-repro로 재현·검증이 즉시 가능(강한 easiness 신호).
- 그러나 **naive 픽스 함정**이 있다: 테이블(`known_functions`)에 `"Max"`만 등록하는 직관적 시도는 `Max`가 `_print_Function`을 전혀 타지 않아 효과가 없다. `_print_MinMaxBase = _print_Function` alias라는 디스패치 지식이 추가로 필요. 이 "테이블만 고치면 될 것 같은데 안 됨" 비자명성이 T1/T2가 아닌 T3로 미는 요인. P2P 8개(인접 printer 동작)를 안 깨야 하는 regression 경계도 약하게 존재.

## 골드패치 분석
- **파일**: `sympy/printing/mathematica.py`
- **건드린 지점**:
  1. 모듈 상단 `known_functions` 딕셔너리에 `"Max": [(lambda *x: True, "Max")]`, `"Min": [(lambda *x: True, "Min")]` 등록. 가변 인자(`lambda *x`)인 점이 핵심 — `Max`/`Min`은 n-항이므로 단항 `lambda x`로는 조건 호출 `cond(*expr.args)`에서 터진다.
  2. `MCodePrinter._print_Function` 정의 직후 `_print_MinMaxBase = _print_Function` 클래스 속성 추가.
- **근본원인**: SymPy printer는 `_print_<클래스명>`을 MRO를 따라 찾는다. `Max`/`Min`의 베이스는 `MinMaxBase`(→ `Expr`, `LatticeOp`)이고 `Function`이 아니므로 `_print_Function`이 호출되지 않는다. 매핑 메서드가 없어 `StrPrinter`의 일반 표현으로 폴백 → 소괄호와 정렬된 인자(`Max(2, x)`)가 나온다.
- **수정요지**: `_print_MinMaxBase`를 `_print_Function`으로 alias 걸어 디스패치를 라우팅하고, `known_functions`에 `Max`/`Min`을 등록해 `_print_Function`이 대괄호 매핑명을 찾도록 해 `Max[x, y, z]` 형태를 출력. 두 변경은 짝 — alias만 있으면 테이블 미등록이라 클래스명 폴백(`Max[...]`은 우연히 맞지만 조건/매핑 일관성 없음), 테이블만 있으면 디스패치 자체가 안 걸린다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_Function` 한 개. 기존 함수 인쇄 단언들에 다음 한 줄 추가:
  `assert mcode(Max(x,y,z)*Min(y,z)) == "Max[x, y, z]*Min[y, z]"`.
  픽스 전엔 `Max`가 소괄호+재정렬로 떨어져 실패, 픽스 후엔 `_print_MinMaxBase` 라우팅으로 `Max[x, y, z]`·`Min[y, z]`가 대괄호로 인쇄돼 통과.
- **픽스 증명**: 단언이 (a) 대괄호 사용, (b) 인자 순서·공백 보존, (c) 곱(`*`) 컨텍스트에서의 결합까지 동시에 확인 — n-항(`x,y,z`)을 써서 가변 인자 lambda가 필요함도 간접 검증.
- **overfit 관점**: 테스트는 얇지만(F2P=1, 단일 단언) 픽스가 `Max`/`Min` 특수케이스가 아니라 `MinMaxBase` 계층 전체를 라우팅하므로 일반화가 패치 자체에 내장 — special-case overfit 위험 낮음. `flags`에 overfit-risk 미부여.
- **regression 관점**: P2P 8개(`test_Pow`/`test_Mul`/`test_Integral`/`test_Derivative` 등)는 다른 printer 메서드 경로라 신규 alias·테이블 항목이 간섭하지 않음. `known_functions`는 기존 키와 충돌 없는 신규 키 2개만 추가.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `mathematica_code`/`mathematica.py`와 잘못된 출력 `Max(2, x)`를 직접 준다 → `sympy/printing/mathematica.py`의 `MCodePrinter` 진입. `Max[...]`가 안 나오는 이유를 디버그 → `_print_Function`에 브레이크 → `Max` 인스턴스가 이 메서드를 안 탐을 확인 → `Max`의 MRO가 `MinMaxBase`이지 `Function`이 아님을 발견.
2. **픽스와 일반화 근거**: `_print_MinMaxBase = _print_Function`으로 디스패치를 잇고 `known_functions`에 `Max`/`Min`을 가변 인자 조건으로 등록. `Max`/`Min` 두 함수만 손대는 게 아니라 `MinMaxBase` 베이스 레벨에서 라우팅하므로 같은 계층의 변형(중첩 `Max(Min(...))`, n-항)까지 자연히 커버 — 이게 올바른 일반화.
3. **regression 안전**: 기존 known_functions 키, 기존 `_print_*` 메서드를 건드리지 않고 신규 키·신규 alias만 추가하므로 P2P 8개의 `Pow`/`Mul`/`Integral`/`Derivative`/`constants`/`containers` 인쇄 경로가 그대로 유지됨. lambda를 `*x` 가변으로 둬 n-항 `cond(*expr.args)` 호출이 인자 수와 무관히 안전.
4. **함정 회피**: 오라클 없는 에이전트의 1순위 실수는 `known_functions`에 `"Max"`만 추가하고 끝내는 것 — `Max`가 `_print_Function`을 안 타므로 **무효**다(테스트 여전히 실패). 두 번째 실수는 단항 `lambda x: True`로 등록해 다항 `Max(x,y,z)`에서 `cond(*expr.args)`가 `TypeError`를 내는 것. printer 디스패치가 클래스명(MRO) 기반임을 이해하고, 베이스 클래스(`MinMaxBase`) 레벨에 alias를 걸며, lambda를 가변 인자로 두는 세 가지를 모두 충족해야 정답.
