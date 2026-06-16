---
instance_id: sphinx-doc__sphinx-10435
repo: sphinx-doc/sphinx
base_commit: f1061c012e214f16fd8790dec3c283d787e3daa8
version: "5.0"
difficulty: "<15 min fix"
created_at: 2022-05-08T09:37:06Z
fail_to_pass: 1
pass_to_pass: 74
gold_files: [sphinx/writers/latex.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
#10251에서 Docutils `code` role에 구문 강조를 켠 뒤로, LaTeX/PDF 출력에서 인라인 코드의 앞·뒤에 공백 한 칸이 삽입된다. 원인은 Pygments가 생성한 `\begin{Verbatim}...\end{Verbatim}` 블록을 인라인 `\sphinxcode{\sphinxupquote{...}}`로 바꿀 때, `\begin{Verbatim}[...]` 뒤에 오는 줄바꿈과 `\end{Verbatim}` 앞의 줄바꿈이 LaTeX에서 공백으로 렌더링되기 때문이다. 기대 출력은 그 줄바꿈들을 `%`(LaTeX 주석)로 흡수해 공백을 제거하는 것이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 정확한 마크업(`\sphinxcode{\sphinxupquote{`)과 before/after `.tex` 스니펫까지 그대로 보여준다. `grep '\\sphinxupquote'` → `visit_literal`로 한 방에 수렴.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나 *올바른 식*을 추론해야 한다. LaTeX에서 줄 끝 `%`가 그 뒤 줄바꿈+선두 공백을 흡수한다는 불변식을 알아야 "공백이 어디서 새는지"를 정확히 두 군데(시작·끝)로 특정하고, 끝쪽 strip 길이를 `-14`→`-15`로 한 글자 늘려야 함을 도출할 수 있다. 무작정 후보를 던지는 G&V가 아니라 문자열 구조를 따져 푸는 문제다.
- **K-Domain**: Sphinx LaTeX writer + Pygments LatexFormatter 출력 포맷(`\begin{Verbatim}` 래퍼, 뒤따르는 `\n`)에 대한 내부 지식이 병목. 일반 파이썬 추론(K-Gen)만으론 `%`/CR 트릭과 매직넘버 `-15`를 정확히 못 맞춘다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하지만 핵심 난점이 "정확한 LaTeX 흡수 규칙 + 오프셋"을 의미적으로 합성하는 데 있어 S2 dominant.

## 난이도 티어
- **T3 (중간)**. 구조적 피처: 1파일·1함수·3-hunk·실질 변경 3줄, has-repro(이슈에 before/after `.tex` 명시)로 localize는 사실상 공짜.
- T1/T2로 안 내리는 이유: 픽스가 "가드 추가/기본값 변경" 같은 기계적 S1이 아니다. (a) 시작 `{` 뒤에 `%` 추가, (b) 끝 `}}` 앞에 `'%' + CR` 추가, (c) strip 슬라이스 `[:-14]`→`[:-15]` — 세 변경이 **함께** 일관돼야 하고, `-15`는 "이제 `\n\end{Verbatim}`을 같이 잘라야 한다"는 추론의 산물이다. 매직넘버를 한 글자 틀리면 깨진 출력. 이 미세 제약추론이 T3로 민다.
- T4 이상 아님: cross-file 없음, P2P는 넓지만(77개) 모두 같은 LaTeX 빌더 테스트라 동일 헬퍼를 공유 — regression "trap"이 표면적일 뿐, 변경이 강조코드 인라인 경로에만 닿아 위험 낮음.
- 공식 라벨 `<15 min fix`와 일치. 숙련 개발자에겐 짧지만, 오라클 없는 에이전트엔 `-15` 매직넘버가 함정.

## 골드패치 분석
- **파일·함수**: `sphinx/writers/latex.py` → `LaTeXTranslator.visit_literal`.
- **근본원인**: Pygments `highlight_block` 출력은 `\begin{Verbatim}[commandchars=...]\n<코드>\n\end{Verbatim}\n` 형태다. 기존 코드는 `\begin{Verbatim}[...]`를 `\sphinxcode{\sphinxupquote{`로 치환했는데, 치환 후에도 **여는 줄 끝의 `\n`**과 **`\end{Verbatim}` 앞의 `\n`**이 남아 LaTeX가 이를 공백으로 렌더 → 인라인 코드 좌우 공백.
- **수정요지** (3 hunk):
  1. 치환 타깃을 `\sphinxcode{\sphinxupquote{` → `\sphinxcode{\sphinxupquote{%`로: 여는 중괄호 뒤 `%`가 직후 `\n`과 다음 줄 선두 공백을 주석 흡수.
  2. `hlcode.rstrip()[:-14]`(`\end{Verbatim}` 14자 제거) → `[:-15]`: rstrip 후 끝이 `...pass\n\end{Verbatim}`인데 이제 `\n`까지 포함해 15자를 잘라 trailing CR 제거.
  3. 꼬리 append `'}}'` → `'%' + CR + '}}'`: 코드 본문 끝에 `%`를 붙여 닫는 `}}` 앞 줄바꿈이 공백으로 새는 걸 차단.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/test_build_latex.py::test_latex_code_role` 1개. test_patch는 기대 문자열을 `\sphinxcode{\sphinxupquote{` → `\sphinxcode{\sphinxupquote{%` 그리고 본문 끝 `'\n}}'` → `'%\n}}'`로 갱신해, `%`가 정확히 시작·끝 두 군데에 들어갔는지 단언한다. 이는 골드패치의 hunk 1·3을 직접 핀포인트로 증명한다.
- **픽스 증명**: 어서션이 `{%` 와 `%\n}}` 둘 다를 요구하므로 한쪽만 고친 부분픽스는 통과 못 함. strip 오프셋(`-15`)이 틀리면 `common_content` 뒤 `%\n}}` 구조가 안 맞아 실패 → 매직넘버까지 간접 검증.
- **overfit**: FAIL_TO_PASS가 1개로 얇지만, 단언이 실제 `\PYG{...}` 강조 토큰 전체 + 좌우 `%` 위치를 정확히 명세해 special-case 통과가 어렵다. overfit-risk 낮음(플래그 미부여).
- **regression**: PASS_TO_PASS 77개(전부 `test_build_latex.py`)가 강조 없는 일반 literal/code-block(`\begin{sphinxVerbatim}` 경로)을 검증. 골드패치는 `'code' in node['classes'] and lang`인 강조 인라인 경로에만 닿으므로 이들 경로는 불변 → regression-trap이 명목상 넓지만 실위험 낮음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `.tex` 스니펫 `\sphinxcode{\sphinxupquote{` 리터럴을 코드베이스에서 검색 → `sphinx/writers/latex.py`의 `visit_literal`에 동일 문자열 치환이 있음을 즉시 발견. #10251 관련임을 보고 강조 분기(`'code' in classes and lang`)로 좁힌다.
2. **픽스와 일반화**: 공백의 진짜 원인은 LaTeX에서 "줄 끝 줄바꿈 = 공백"이라는 규칙. 따라서 시작은 `{%`로 직후 CR을 주석 처리, 끝은 본문 뒤 `%`(=`'%' + CR + '}}'`)로 닫는 CR을 주석 처리한다. `%`는 LaTeX 표준 주석이라 모든 강조 코드 입력에 일반적으로 작동(특정 코드 문자열에 의존 안 함) → overfit 아님. 동시에 trailer strip을 `-14`→`-15`로 늘려 새로 흡수 대상이 된 trailing `\n`을 함께 제거.
3. **regression 안전**: 변경은 강조 인라인 경로 한정. `in_title`/`kbd`/비강조 literal early-return과 `\begin{sphinxVerbatim}` code-block 경로는 미접촉이어야 한다. 77개 P2P가 후자들을 커버하므로 그 출력 바이트가 그대로여야 통과.
4. **함정 회피**: (a) 매직넘버 — 시작만 `%`로 고치고 `[:-14]`를 그대로 두면 trailing `\n`이 남아 끝 공백이 안 사라진다; "한쪽만 고침"이 가장 흔한 실수. before/after를 글자 단위로 대조해 `-15`와 끝 `%`까지 맞춰야 한다. (b) `%`를 코드 본문 안 잘못된 위치에 넣어 강조 토큰을 깨뜨리지 말 것 — 반드시 여는 `{` 직후와 본문 끝/닫는 `}}` 직전에만. (c) `\sphinxupquote` 대신 비강조 literal 분기를 고치는 오localize 주의.
