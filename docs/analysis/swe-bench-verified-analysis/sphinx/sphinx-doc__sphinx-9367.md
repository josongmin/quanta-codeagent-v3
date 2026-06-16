---
instance_id: sphinx-doc__sphinx-9367
repo: sphinx-doc/sphinx
base_commit: 6918e69600810a4664e53653d6ff0290c3c4a788
version: "4.1"
difficulty: "<15 min fix"
created_at: 2021-06-20T17:49:40Z
fail_to_pass: 1
pass_to_pass: 25
gold_files: [sphinx/pycode/ast.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
Sphinx의 AST 언파서(`sphinx/pycode/ast.py`)가 1-원소 튜플 `(1,)`을 `(1)`로 렌더링한다 — 후행 쉼표가 빠져 의미가 튜플이 아니라 괄호 친 스칼라로 변한다. 이슈는 #7964/#8265의 후속으로, 빈 튜플 `()`은 이미 고쳐졌으나 단일-원소 특수 케이스가 누락되었음을 지목한다. 이슈 본문이 재현 테스트케이스 `("(1,)", "(1,)")`와 정확한 소스 위치(라인 링크)까지 직접 적어준다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈가 파일·테스트라인·심볼을 직접 지목. `visit_Tuple` 단일 함수. grep `visit_Tuple` 한 방. 탐색 비용 0.
- **S1 +S2 (Repair Strategy)**: 결함 클래스가 "경계/특수케이스 누락"으로 정형. 픽스는 `elts` 길이 1 분기를 추가하는 기계적 패턴(S1). 단 *어떤 출력 문자열이 올바른가*(`(1,)`의 후행 쉼표)는 파이썬 튜플 리터럴 문법으로 추론해야 하므로 약한 S2가 보조로 붙는다.
- **K-Domain**: 일반 파이썬 추론(튜플 1개 원소는 trailing comma 필수)이라 대체로 K-Gen에 가깝지만, Sphinx AST→source unparse 계약(`visit_*` 방문자 패턴, 다른 visit과 출력형식 일관성) 안에서 고쳐야 하므로 K-Domain으로 둔다.
- **primary type = T-DirectMap**: 위치가 자명(L0)하고 픽스가 길이 분기 추가라는 기계적 매핑(S1)이라 dominant는 DirectMap. T-LocTrivial이 아닌 이유는 "올바른 출력"이 자명한 상수가 아니라 문법 규칙(trailing comma)에서 나오는 미세 추론이 있기 때문.
- **APR 관점**: 이슈가 사실상 픽스를 명세(기대 출력/위치 제공)하므로 template/Direct-Map 전략이 정확히 맞는다. generate-&-validate로 헤맬 공간이 없다.

## 난이도 티어
**T1 (존나쉬움)**. 구조적 피처:
- 파일수 1, 헌크 1, 실질 변경 ~4줄(분기 1개 추가). ICLR 컷의 "1파일·<5줄 ≈ 48% solve" 최상단.
- localize 직접성 최대(L0) — 이슈가 심볼+라인+테스트를 박아줌.
- `has-repro`: 이슈가 재현 테스트를 그대로 제공(가장 강한 easiness 신호).
- P2P trap 거의 없음: 25개 P2P는 모두 같은 `test_unparse`/`test_unparse_py38` 파라미터화로 인접하지만, 빈 튜플·다중 튜플 분기를 유지하면 깨질 일이 없다.
공식 라벨 `<15 min fix`와 완전히 일치. 재조정 불필요.

## 골드패치 분석
- **파일·함수**: `sphinx/pycode/ast.py`의 `_UnparseVisitor.visit_Tuple`.
- **근본원인**: 기존 코드가 `if node.elts: "(" + ", ".join(...) + ")"`로 2-way 분기만 했다. 원소가 1개일 때도 이 branch로 가서 `", ".join`이 쉼표를 만들지 못해(원소 1개라 구분자 없음) `(1)`이 나온다 — 파이썬 문법상 튜플이 아닌 grouping 괄호.
- **수정요지**: 분기를 3-way로 재구성. `len(node.elts) == 0 → "()"`, `len == 1 → "(%s,)" % self.visit(node.elts[0])`(후행 쉼표 명시 삽입), `else → ", ".join` 다중 원소 경로. 즉 단일-원소 특수 케이스를 명시적으로 분리해 trailing comma를 강제.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_unparse[(1,)-(1,)]` — `tests/test_pycode_ast.py`의 파라미터 테이블에 `("(1,)", "(1,)")`를 추가. `ast.parse` → unparse 왕복이 입력과 동일한 `(1,)`을 내야 통과.
- **픽스 증명**: 패치 전엔 단일-원소가 `if node.elts` 경로로 빠져 `(1)`을 내므로 정확히 이 테스트가 RED. 패치 후 `len == 1` 분기가 `(1,)`을 만들어 GREEN.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만 special-case화가 *바로 의도된 일반화*다(파이썬 1-tuple 문법 규칙 자체). 추가 입력공간(`(a,)`, `(f(),)` 등)도 같은 분기를 타므로 overfit-risk 낮음 → 플래그 안 붙임.
- **regression 관점**: 25개 P2P가 빈 튜플 `()`·다중 튜플 `(1, 2, 3)`·`Tuple[int, ...]` 등을 커버. 3-way 분기는 `len==0`/`else` 경로를 기존과 동일하게 보존하므로 regression-trap 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `tests/test_pycode_ast.py#L57`과 "rendered as (1)"을 명시 → 언파서 책임지점인 `sphinx/pycode/ast.py`에서 `visit_Tuple` grep. 단 한 함수로 수렴.
2. **픽스와 일반화 근거**: 기존 2-way 분기가 `", ".join`에 1-원소를 위임해 쉼표 소실이 일어난 게 근본원인. `len == 1` 분기를 명시 추가하고 포맷에 trailing comma를 박는다. 이는 special-case 하드코딩이 아니라 파이썬 튜플 리터럴 문법(`(x,)`)을 그대로 구현하는 것이라 모든 1-원소 입력에 일반.
3. **regression 안전**: `len==0 → "()"`와 다중-원소 `", ".join` 경로를 *글자 그대로* 유지해야 한다. P2P의 `()`·`(1, 2, 3)`·`Tuple[int, str]` 등이 이 두 경로에 의존. 분기 재배치 시 else 경로의 join 표현을 바꾸지 말 것.
4. **함정 회피**: (a) 기존 `if node.elts:` 안에서 길이 검사 없이 `+ ","` 같은 후행 쉼표를 무조건 붙이면 다중-원소가 `(1, 2, 3,)`로 깨진다 — 반드시 길이 1에만 한정. (b) `", ".join` 대신 `str(node.elts[0])` 같이 재방문(`self.visit`)을 건너뛰면 중첩 표현이 틀린다 — `self.visit(node.elts[0])`로 재귀 방문 유지. (c) 빈 튜플 분기를 truthiness(`if node.elts`)로 남겨두면 0/1/다수 셋을 명확히 못 가르니 `len()` 비교로 3-way 정규화하는 것이 안전.
