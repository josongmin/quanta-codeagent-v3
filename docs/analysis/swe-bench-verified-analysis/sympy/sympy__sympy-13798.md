---
instance_id: sympy__sympy-13798
repo: sympy/sympy
base_commit: 7121bdf1facdd90d05b6994b4c2e5b2865a4638a
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-12-26T18:12:43Z
fail_to_pass: 1
pass_to_pass: 102
gold_files: [sympy/printing/latex.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`latex()` 프린터의 `mul_symbol` kwarg은 4개 고정 선택지(`None`/`ldot`/`dot`/`times`)만 받는다. 사용자는 thin space(`\,`)처럼 목록에 없는 곱셈기호를 직접 지정하고 싶어 한다(예: `latex(3*x**2*y, mul_symbol='\\,')`). 이슈는 하위호환을 유지하면서 임의 `mul_symbol`을 허용하는 PR을 제안하고, 메인테이너가 "매핑이라 제한됐을 뿐, unknown 인자를 곧 LaTeX로 쓰면 된다"고 승인한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 `latex()`의 `mul_symbol`을 직접 지목. `latex.py`의 `mul_symbol_table` lookup 한 곳으로 grep 한 방에 수렴. 탐색 비용 사실상 0.
- **S2 (Constraint-Reasoning) +S5**: 고칠 지점은 자명하나, "올바른 조건식"을 추론 합성해야 한다. 단순히 dict에 없으면 raw 문자열을 쓰는 게 끝이 아니라, **숫자 사이 곱셈**(`mul_symbol_latex_numbers`)에서는 빈/공백류 기호가 `3 1.5`처럼 모호해지므로 `dot`로 폴백해야 한다는 의미적 제약을 끌어내야 한다. 이 분기는 코드만으론 결정 불가 → 정수×float 인접 시 가독성 계약을 스펙으로 재구성(S5)해야 함.
- **K-Domain**: LaTeX 조판 관례(thin space의 의미, 숫자 인접 시 dot 필요)와 sympy 프린터 내부(`mul_symbol_latex` vs `mul_symbol_latex_numbers` 이원 구조)를 알아야 함.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 난점이 "어디"가 아니라 KeyError를 raw 패스스루로 바꾸되 숫자 경로의 엣지조건을 따져 합성하는 데 있음. 단순 None-guard(S1)였다면 T-DirectMap이지만, 두 번째 try의 분기 조건이 진짜 추론을 요구하므로 ConstraintReason.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1메서드(`LatexPrinter.__init__`)·약 11줄 추가, localize는 L0로 매우 직접적, has-repro(이슈에 입출력 예시 명시). 그러나 T2를 넘어 T3인 이유는 (1) 두 lookup(`mul_symbol_latex`, `mul_symbol_latex_numbers`)을 **각각** try/except로 분리하고 숫자 경로에만 추가 폴백 분기를 두는 비대칭 추론이 필요하고, (2) P2P가 105개로 넓어 기존 4개 기호 동작을 byte-identical로 보존해야 하는 regression-trap이 있기 때문. 공식 라벨 "15분-1시간"과 일치 — localize는 쉽지만 숫자 폴백 조건을 빠뜨리면 plausible-but-wrong이 되어 단순 한 줄짜리보다 한 단계 위.

## 골드패치 분석
- **파일·함수**: `sympy/printing/latex.py`, `LatexPrinter.__init__`.
- **근본원인**: `mul_symbol_table[self._settings['mul_symbol']]` 직접 인덱싱이 4개 키만 허용. 키에 없는 값을 주면 `KeyError`로 죽어, 임의 기호를 막는 구조적 제약이 된다.
- **수정요지**: 두 lookup을 각각 `try/except KeyError`로 감싼다.
  - `mul_symbol_latex`: KeyError 시 사용자가 준 `self._settings['mul_symbol']` raw 문자열을 그대로 사용 → 임의 기호 허용.
  - `mul_symbol_latex_numbers`: KeyError 시, 기호가 strip 후 공백류(`['', ' ', '\\', '\\,', '\\:', '\\;', '\\quad']`)이면 `mul_symbol_table['dot']`로 폴백, 아니면 raw 사용. 숫자끼리 곱(`1.5*3`)이 thin space로 분리되면 `1.5 3`처럼 단일 수처럼 보이는 모호성을 `\cdot`으로 방지하는 게 핵심.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_latex_basic`** (1개)에 2개 단언 추가:
  - `latex(3*x**2*y, mul_symbol='\\,') == r"3\,x^{2}\,y"` — 임의 기호가 심볼 곱에 그대로 적용됨(첫 try의 raw 패스스루 증명).
  - `latex(1.5*3**x, mul_symbol='\\,') == r"1.5 \cdot 3^{x}"` — 숫자(`1.5`)와 밑(`3`) 사이는 thin space가 아니라 `\cdot`. 두 번째 except의 공백류 폴백 분기를 정확히 겨냥 → 두 코드경로 모두 covered.
- **overfit 관점**: FAIL_TO_PASS가 1테스트로 얇지만, 두 단언이 raw-passthrough와 dot-fallback을 **각각** 찍어 special-case 통과를 막는다. 다만 공백류 화이트리스트(`\\:`/`\\;`/`\\quad` 등)는 테스트가 `\\,`만 검증해 미커버 — 화이트리스트 멤버십 자체는 overfit 여지가 있으나 동작 분기는 검증됨.
- **regression 관점**: 4개 기존 키(`None`/`ldot`/`dot`/`times`)는 여전히 try 본문에서 성공해 except를 안 타므로 동작 불변. P2P 105개(특히 `test_latex_mul_symbol`, `test_latex_integrals`의 `\,dx`)가 이를 보증.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`mul_symbol` must be one of four choices" + thin space 예시 → `latex.py`에서 `mul_symbol` grep → `LatexPrinter.__init__`의 `mul_symbol_table` dict와 두 줄의 직접 인덱싱이 유일 제약 지점임을 즉시 확정(L0).
2. **픽스와 일반화**: 직접 인덱싱을 try/except KeyError로 바꿔 unknown을 raw LaTeX로 통과시킨다 — 이게 "4 choices=historical artifact"라는 이슈 진단에 정합. 단, `mul_symbol_latex_numbers`는 따로 처리해 공백류일 때 `dot` 폴백. 이건 overfit이 아니라 숫자 인접 모호성이라는 일반 조판 불변식을 반영한 올바른 일반화(`1.5 3` 방지).
3. **regression 안전**: 4개 표준 키는 except를 안 타게 try 본문을 그대로 유지해야 함. `test_latex_integrals`의 `\,dx`처럼 내부적으로 thin space를 쓰는 출력은 `mul_symbol` 경로와 무관하므로 깨지면 안 됨 — P2P 105개로 보호.
4. **함정 회피**: (a) 첫 try만 고치고 숫자 경로를 잊으면 `1.5*3**x`가 `1.5\,3^{x}`로 모호해져 두 번째 단언 fail. **반드시 두 lookup을 분리 처리**. (b) 전체를 `mul_symbol_table.get(key, key)`로 뭉뚱그리면 숫자 폴백 분기가 사라져 동일 실패. (c) `mul_symbol`이 None일 때 두 번째 except의 `.strip()`이 호출되지 않도록(None은 `or 'dot'`로 try 본문에서 성공) 분기 순서를 지켜야 AttributeError 회피.
