---
instance_id: sympy__sympy-18763
repo: sympy/sympy
base_commit: 70381f282f2d9d039da860e391fe51649df2779d
version: "1.5"
difficulty: "<15 min fix"
created_at: 2020-03-03T03:40:06Z
fail_to_pass: 1
pass_to_pass: 141
gold_files: [sympy/printing/latex.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 로컬 quanta receipt (2026-06-20)

- **PASS receipt**: durable sidecar `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0c5da49c3a3267012.json`.
- **run**: `agentless-v2`, `gpt-5.4`, official swebench harness, 115 turns, 528B patch, repro 5/5 reproduced, P2P 141/141 clean.
- **patch**: `latex_expr = self.parenthesize(expr, PRECEDENCE['Mul'])` in `LatexPrinter._print_Subs`. Gold의 unconditional `\left(...\right)` 문자열 래핑과는 다르지만 official grader PASS.
- **해석**: 이전 conditional/over-engineering 실패 RCA는 failure-mode calibration으로 유효하다. 현재 상태는 active model ceiling이 아니라 **patch-gen variance / anchoring-risk** 케이스다.

## 문제 요약
`Subs` 객체의 LaTeX 출력이 치환 대상 식(expression)을 괄호로 감싸지 않아, 곱(Mul) 등 더 큰 식 안에 들어갈 때 우선순위가 깨진다. 예: `3*Subs(-x+y, (x,), (1,))`가 `3 \left. - x + y \right|_{...}`로 출력되어 마치 `3`이 `-x`에만 곱해지는 것처럼 모호하게 보인다. 이슈는 원하는 정답(`3 \left. \left(- x + y\right) \right|_{...}`)까지 명시적으로 제시한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문이 "parenthesizing of Subs" + 정확한 before/after LaTeX 문자열을 줌. `_print_Subs` 한 메서드로 grep 한 방에 수렴. 탐색 비용 0.
- **S1 (Direct-Map, +S2)**: 픽스가 사실상 명세됨 — 치환 본문 `latex_expr`를 `\left(...\right)`로 감싸기만 하면 된다. 정형 결함클래스(누락된 괄호/grouping 가드)에 템플릿 매칭. 다만 "무조건 괄호" vs "우선순위 따져 조건부 괄호"의 선택이 미세한 의미추론(S2)을 동반하므로 보조로 표기.
- **K-Domain**: sympy printing 서브시스템(LaTeX 프린터의 `_print_*` 메서드 규약, `\left.|_{\substack{...}}` 관용 출력)을 알아야 정확한 위치/포맷을 맞춘다. 일반 파이썬 추론만으로는 출력 관례를 모름.
- **Primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 기계적 문자열 래핑(S1). 추론·탐색 난점이 거의 없는 전형적 direct-map.

APR 관점: 이슈가 입력→기대출력 페어를 직접 제공하므로 PAR/TBar식 템플릿("missing wrapping" 결함패턴 → wrap-with-delimiter 변환)으로 바로 합성 가능. 후보 다수를 테스트로 거르는 G&V가 아니라, 단일 결정적 변환이라 S1이 dominant.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- **파일 1개 / 함수 1개 / 실질 1줄**: `latex.py`의 `_print_Subs` 단일 return 문자열 포맷 변경. 골드패치는 1줄 -, 1줄 +.
- **localize 직접성 최상(L0)** + **has-repro**(실행 가능한 재현 + 기대출력까지 명시): ORACLE-SWE 기준 repro 신호가 가장 강한 easiness 지표.
- **K-Domain은 얕음**: 도메인 지식이 필요하긴 하나 출력 포맷 한 줄 수준으로, 깊은 call-chain이나 assumptions 추론은 없음.
- **regression-trap 존재**: PASS_TO_PASS가 137개로 넓다. 다만 변경이 `_print_Subs`에만 국한되고 다른 프린터 경로를 안 건드리므로 실제 회귀 위험은 낮음 → T1로 떨어지지 않고 T2에 안착.

공식 라벨 `<15 min fix`와 일치. 한 줄 수정이지만 "괄호를 어디에 무조건/조건부로 넣을지"의 미세판단과 넓은 P2P 때문에 T1(존나쉬움)보다 한 단계 위로 둔다.

## 골드패치 분석
- **파일·함수**: `sympy/printing/latex.py` → `LatexPrinter._print_Subs(self, subs)`.
- **근본원인**: `_print_Subs`가 치환 본문을 `latex_expr = self._print(subs.expr)`로 렌더한 뒤 `\left. %s \right|_{...}` 템플릿에 그대로 끼워 넣는다. `latex_expr`이 합(`-x+y`) 같은 낮은 우선순위 식이어도 grouping 구분자가 없어, 바깥 곱 연산자와 결합될 때 시각적/의미적 모호성이 발생.
- **수정요지**: 포맷 문자열을 `r'\left. %s \right|...'` → `r'\left. \left(%s\right) \right|...'`로 바꿔 본문을 항상 `\left(...\right)`로 감싼다. `latex_expr`을 인자로 넘기는 부분은 그대로.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_latex_subs`** (1개). 기존 단언이 `\left. x y \right|_{...}`를 기대했는데, 골드패치 적용 후엔 `\left. \left(x y\right) \right|_{...}`로 바뀌므로 테스트도 함께 갱신. 추가로 이슈의 정확한 케이스 `latex(3*Subs(-x+y, (x,),(1,))) == r'3 \left. \left(- x + y\right) \right|_{\substack{ x=1 }}'`를 신규 단언으로 박아 회귀를 고정.
- **픽스 증명**: 곱 안의 합(`-x+y`)이 괄호로 묶여 `3`이 식 전체에 적용됨이 출력 문자열로 직접 검증됨.
- **overfit/regression**: 픽스가 "항상 괄호"라 모든 Subs 출력이 바뀜 — 단일 단순항(`x`)까지 괄호가 붙는 약간의 over-parenthesization이 발생하나, test_patch가 기존 `x y` 케이스 단언까지 갱신해 일관성을 인정. PASS_TO_PASS 137개 중 Subs 출력을 가정하는 다른 테스트가 없어 회귀 트랩은 비어 있음. overfit 위험 낮음(변환이 일반적이고 입력공간 전체에 균일 적용).

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 제목 "parenthesizing of Subs" + LaTeX 출력 예시 → `sympy/printing/latex.py`에서 `_print_Subs` grep. 출력 문자열의 `\left.`와 `\substack` 토큰을 코드의 포맷 리터럴과 대조하면 단일 return 라인으로 즉시 수렴.
2. **픽스와 일반화 근거**: `latex_expr`을 `\left(...\right)`로 감싼다. 이게 올바른 일반화인 이유 — Subs 본문은 임의의 식이고 결과는 곱/지수 등 더 큰 표현식에 중첩될 수 있으므로, 본문을 원자(atomic) grouping으로 만드는 것이 우선순위 보존의 안전한 디폴트. 이슈가 제시한 기대출력과도 정확히 일치.
3. **regression 안전**: 변경이 `_print_Subs` return 문자열에만 국한 → 다른 `_print_*` 경로 불변. P2P 137개 어느 것도 Subs LaTeX를 가정하지 않으므로 깨질 테스트 없음. 기존 `test_latex_subs`의 `x y` 단언만 새 포맷으로 갱신하면 됨.
4. **함정 회피**: (a) 본문 우선순위를 따져 "합/곱일 때만 조건부 괄호"식으로 정교화하려는 유혹 — 골드는 무조건 괄호이고 test도 단일항 케이스를 안 다루므로, 오라클 없는 에이전트가 조건부 로직을 넣으면 기대출력(`\left(x y\right)`)과 어긋나 FAIL_TO_PASS 실패. 단순 무조건 래핑이 정답. (b) 괄호를 `(` `)` 평문으로 넣지 말고 LaTeX 관례인 `\left(...\right)`로 넣어야 테스트 문자열과 바이트 일치.
