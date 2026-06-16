---
instance_id: sphinx-doc__sphinx-8265
repo: sphinx-doc/sphinx
base_commit: b428cd2404675475a5c3dc2a2b0790ba57676202
version: "3.3"
difficulty: "15 min - 1 hour"
created_at: 2020-10-03T03:06:00Z
fail_to_pass: 1
pass_to_pass: 22
gold_files: [sphinx/pycode/ast.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
autodoc로 렌더된 메서드 시그니처에서 튜플 기본 인자가 깨진다. `def add_lines(self, lines, color=(1, 1, 1), ...)`가 HTML에서 `add_lines(lines, color=1, 1, 1, ...)`처럼 괄호가 사라져 표시된다. 즉 기본값 `(1, 1, 1)`을 unparse할 때 감싸는 소괄호가 누락되어 인자 경계가 무너진다. 기대 출력은 `color=(1, 1, 1)`.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈는 "기본 인자 렌더링 깨짐"이라는 증상만 주지만, autodoc 시그니처 unparse 경로는 `sphinx/pycode/ast.py`의 AST `_UnparseVisitor`로 좁게 수렴한다. `visit_Tuple` 한 군데가 직접적 용의자. 약간의 탐색.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점(`visit_Tuple`)은 거의 자명하나, "튜플엔 항상 괄호를 붙인다"는 순진한 픽스가 **subscript slice**(`Tuple[int, int]`)를 `Tuple[(int, int)]`로 망가뜨린다. 올바른 불변식("일반 튜플은 괄호, subscript 내부 튜플은 무괄호")을 추론해 두 visitor를 조율 수정해야 한다. 단순 템플릿 가드가 아니라 엣지케이스를 따져 푸는 문제.
- **K (Knowledge) = K-Domain**: Python `ast` 모듈의 노드 구조(`ast.Tuple`/`ast.Subscript`/`ast.Index`/`ast.Starred`)와 3.8 전후의 slice 표현 차이(`ast.Index` 래핑)를 알아야 한다. Sphinx 내부 unparse 도메인.
- **Primary = T-ConstraintReason**: 위치는 명확하나 픽스의 핵심이 "괄호를 어디에 붙이고 어디서 빼야 정상 동작과 회귀를 동시에 만족하나"라는 조건 합성에 있다. APR 관점에서 SemFix류의 의미적 제약 추론.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개, 함수 2개(`visit_Tuple` 1줄 변경 + `visit_Subscript` 분기 추가), 총 ~14줄. patch scope는 작다.
- localize는 L1로 직접적이지 않지만 키워드("default arg", "signature")로 unparse visitor에 수렴 가능.
- **repro 약함**: 이슈가 Dockerfile/스크린샷은 주지만 실패 단위테스트는 아님 → 에이전트가 직접 최소 재현을 만들어야 함.
- **P2P trap이 핵심 난점**: `Tuple[int, int]` 같은 subscript 케이스(`test_unparse[Tuple[int,`)가 PASS_TO_PASS에 있어, 순진한 픽스는 즉시 회귀를 낸다. 이 trap이 T2가 아니라 T3로 미는 요인.
공식 라벨 "15분-1시간"과 일치. naive 픽스가 곧장 회귀를 내는 점만 빼면 작은 변경이라 T4까지 갈 필요는 없다.

## 골드패치 분석
- **파일**: `sphinx/pycode/ast.py`
- **함수**: `_UnparseVisitor.visit_Tuple`, `_UnparseVisitor.visit_Subscript`
- **근본원인**: `visit_Tuple`이 비어있지 않은 튜플을 `", ".join(...)`로만 렌더 → 감싸는 괄호가 없어 `(1,1,1)`이 `1, 1, 1`이 됨. 시그니처 기본값 위치에서 인자 구분 쉼표와 섞여 깨진다.
- **수정요지**:
  1. `visit_Tuple`: 비어있지 않으면 `"(" + ... + ")"`로 괄호를 명시(빈 튜플은 그대로 `"()"`).
  2. `visit_Subscript`: 위 변경이 subscript slice(`X[a, b]`)를 `X[(a, b)]`로 망가뜨리는 회귀를 막기 위해, slice가 **simple tuple**(=`ast.Tuple`이고 elts 비어있지 않으며 `ast.Starred` 없음)이면 elts를 직접 무괄호로 펼친다. 내부 헬퍼 `is_simple_tuple`로 판정하고, 3.8 미만의 `ast.Index` 래핑(`node.slice.value`)도 함께 처리.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `tests/test_pycode_ast.py::test_unparse[(1, 2, 3)]` — 기대값이 `"1, 2, 3"`에서 `"(1, 2, 3)"`로 갱신됨. `visit_Tuple`의 괄호 추가가 이 단언을 통과시킨다.
- **픽스 증명**: 동일 파라미터화 테이블의 `test_unparse[Tuple[int, int]]`(P2P)가 여전히 `Tuple[int, int]`(무괄호)로 통과해야 하는데, 이는 `visit_Subscript`의 `is_simple_tuple` 분기가 보장한다. 즉 두 변경이 짝으로 fix를 완성한다.
- **overfit**: FAIL_TO_PASS는 1개로 얇지만, PASS_TO_PASS 23개가 unparse 전 노드유형(Subscript/Index/List/Set/Dict/lambda 등)을 넓게 덮어 special-case 통과를 차단한다. `regression-trap`이 실질 가드 역할.
- **regression**: subscript 튜플 slice, 빈 튜플(`()`), py38 케이스(`test_unparse_py38`)가 모두 P2P로 고정되어 괄호 정책 변경의 부작용을 잡는다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "default arg가 `(1,1,1)`→`1, 1, 1`로 렌더"라는 증상에서, autodoc 시그니처가 소스 표현이 아니라 AST를 unparse한다는 점을 인지 → `sphinx/pycode/ast.py`의 `_UnparseVisitor.visit_Tuple`이 괄호를 안 붙인다는 것을 grep으로 확인.
2. **픽스/일반화**: `visit_Tuple`에서 비어있지 않은 튜플에 괄호를 추가. 이건 "튜플의 표준 repr은 괄호 포함"이라는 일반 규칙이라 overfit이 아니라 올바른 일반화다. 단, 무조건 괄호는 subscript 문맥을 깨므로 `visit_Subscript`에서 simple-tuple slice를 무괄호로 펼쳐 "괄호는 값 표현에만, subscript 인덱스 튜플에는 안 붙인다"는 문법적 불변식을 세운다.
3. **regression 안전**: `Tuple[int, int]`(typing subscript), 빈 튜플 `()`, 3.8 이전 `ast.Index` 래핑을 안 깨야 한다. `is_simple_tuple`의 elts 비어있음/`Starred` 제외 조건과 `ast.Index` 분기가 이 P2P들을 보존한다.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정은 `visit_Tuple`만 고치고 끝내는 것 — 그러면 `Tuple[int, int]`가 `Tuple[(int, int)]`로 회귀한다. 또 하나는 `ast.Starred`(예: `(*a, b)`)를 간과해 starred 언패킹을 잘못 합치는 것. 픽스 전 subscript/typing/py38 케이스로 최소 재현을 만들어 두 visitor를 함께 검증하면 회피된다.
