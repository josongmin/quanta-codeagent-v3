---
instance_id: sympy__sympy-24661
repo: sympy/sympy
base_commit: a36caf5c74fe654cedc488e8a8a05fad388f8406
version: "1.12"
difficulty: "15 min - 1 hour"
created_at: "2023-02-05T19:15:22Z"
fail_to_pass: 1
pass_to_pass: 27
gold_files: [sympy/parsing/sympy_parser.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`parse_expr('1 < 2', evaluate=False)` 가 `evaluate=False` 를 무시하고 `True` 로 평가되어 버린다. 기대 결과는 미평가 relational 객체 `Lt(1, 2, evaluate=False)` (즉 `1 < 2`) 이다. `sympify` 가 문자열을 받으면 내부적으로 `parse_expr` 를 호출하므로 근본 수정 지점은 `parse_expr` 다. 원인은 `evaluate=False` AST 변환기가 산술/논리 연산은 미평가로 감싸지만 부등식·등식 같은 비교(relational)는 전혀 다루지 않기 때문이다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈와 hints가 파일·라인·클래스를 직접 지목한다 — `sympy/parsing/sympy_parser.py` L1102 `EvaluateFalseTransformer`. grep 한 방으로 끝. 점수 L0.
- **S2 + S6 (Repair Strategy)**: 고칠 지점은 자명하지만, 단순히 기존 `operators` dict에 항목을 추가하는 것만으로는 안 된다(비교는 `ast.BinOp` 가 아니라 `ast.Compare` 노드라서 `visit_BinOp` 가 안 잡는다). 새 visitor 메서드 `visit_Compare` 를 도입하고 Python AST의 비교 연산자 클래스를 sympy relational 클래스명으로 매핑하는 **올바른 변환식을 추론 합성**해야 한다(S2). 그 합성이 구조상 새 dispatch 경로 추가라서 보조로 S6.
- **K-Domain**: SymPy의 `Lt/Le/Gt/Ge/Ne/Eq` relational API와 `evaluate=False` 키워드 의미, 그리고 CPython `ast.Compare` 노드 구조(`node.ops[0]`, `node.left`, `node.comparators[0]`) 양쪽 지식이 병목. 일반 파이썬 추론만으론 부족.
- **primary = T-DomainBound**: 위치는 trivial하나 실제 난점은 "ast.Compare → sympy relational" 매핑이라는 도메인 배선 지식이다. hints에서 한 기여자가 `ast.Equality`/`ast.StrictLessThan` 로 적었다가 `AttributeError`(그런 ast 속성 없음)를 낸 것이 바로 이 도메인 함정의 증거.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개, 함수 1개(메서드 신규) 추가, +23줄 단일 헌크 → scope는 작다(T2~T3 쪽).
- localize 직접성: L0, has-repro(이슈에 재현 1줄) → 쉬움 쪽으로 민다.
- 그러나 단순 dict-엔트리 추가(S1)로 풀리지 않고, **비교 노드는 별도 visitor가 필요**하다는 점과 ast 속성명 함정(`ast.Eq` vs `ast.Equality`)이 실수율을 높여 T2가 아닌 **T3**로 올린다.
- regression-trap: PASS_TO_PASS 27개가 같은 파일의 파서 동작 전반(`test_recursive_evaluate_false_10560`, `test_function_evaluate_false`, `test_convert_equals_signs` 등)을 커버 → relational 처리를 잘못 넣으면 기존 `evaluate=False` 경로를 깨기 쉽다.
- 공식 라벨 "15분-1시간"과 일치(T3). 작업량은 작지만 도메인 정확도 요구가 비자명.

## 골드패치 분석
- **건드린 파일/심볼**: `sympy/parsing/sympy_parser.py` 의 `class EvaluateFalseTransformer(ast.NodeTransformer)`.
- **근본 원인**: 이 transformer는 `evaluate=False` 파싱을 위해 산술/비트 연산(`ast.Add/Mult/Pow/Sub/Div/BitOr/BitAnd/BitXor`)을 `visit_BinOp` 에서 `Add(..., evaluate=False)` 식으로 감싼다. 하지만 부등식·등식은 CPython AST에서 `ast.Compare` 노드로 표현되어 `visit_BinOp` 가 절대 방문하지 않으므로, 변환이 전혀 일어나지 않고 그대로 컴파일·평가되어 `bool` 이 나온다.
- **수정 요지**: 클래스 속성 `relational_operators = {ast.NotEq:'Ne', ast.Lt:'Lt', ast.LtE:'Le', ast.Gt:'Gt', ast.GtE:'Ge', ast.Eq:'Eq'}` 와 신규 메서드 `visit_Compare(self, node)` 추가. `node.ops[0].__class__` 가 매핑에 있으면 `left = self.visit(node.left)`, `right = self.visit(node.comparators[0])` 로 재귀 변환 후 `Lt(left, right, evaluate=False)` 형태의 `ast.Call` 노드를 생성해 반환한다. 매핑에 없으면 `node` 를 원본 그대로 반환(안전 fallback).

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_issue_24288`: `"1 < 2"→Lt`, `"1 <= 2"→Le`, `"1 > 2"→Gt`, `"1 >= 2"→Ge`, `"1 != 2"→Ne`, `"1 == 2"→Eq` 6쌍을 모두 `parse_expr(text, evaluate=False) == <Rel>(1,2,evaluate=False)` 로 단언. 6개 연산자 전체를 덮어 단일 케이스 overfit을 차단한다.
- **픽스 증명**: `visit_Compare` 가 6개 ast 비교 클래스를 정확히 그 6개 relational로 매핑하므로 테스트의 6쌍과 일대일 대응 → 통과.
- **overfit 관점**: 6개 연산자를 전수 검증하므로 "1<2만 통과시키는 special-case" 류 가짜 패치는 떨어진다. 다만 `left/right` 재귀 변환이 실제로 작동하는지(예: `1 + 1 < 2*x`)를 검증하는 케이스는 없어 미세 underspec 여지는 있으나, 골드가 `self.visit(...)` 로 재귀를 보존하므로 일반화는 올바르다.
- **regression 관점**: `visit_Compare` 는 신규 메서드라 기존 `visit_BinOp`/`flatten` 경로를 건드리지 않는다. 매핑 밖 노드는 원본 반환이라 다른 Compare 사용처를 깨지 않는다. PASS_TO_PASS 27개 파서 테스트가 안전망.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈/hints가 직접 `sympy/parsing/sympy_parser.py` L1102 `EvaluateFalseTransformer` 를 지목 → grep `EvaluateFalseTransformer` 한 방. `operators` dict와 `visit_BinOp` 를 읽으면 "산술은 감싸는데 비교는 미처리"라는 갭이 즉시 보인다.
2. **픽스 & 일반화 근거**: 핵심 통찰은 **비교 연산은 `ast.BinOp` 가 아니라 `ast.Compare`** 라는 점. 따라서 `operators` dict에 `ast.Lt` 를 끼워넣는 것(hints의 첫 시도)은 작동하지 않는다. 별도 `visit_Compare` 를 만들어 `node.ops[0].__class__` 기준으로 6개 relational에 매핑하고, `node.left`/`node.comparators[0]` 를 재귀 `self.visit` 해 중첩 표현식도 미평가를 전파하는 것이 올바른 일반화다.
3. **regression 안전**: 신규 visitor만 추가하고 기존 dispatch는 불변 → `test_recursive_evaluate_false_10560`, `test_function_evaluate_false`, `test_convert_equals_signs` 등 기존 `evaluate=False`/등호 변환 경로가 영향받지 않아야 한다. 매핑에 없는 비교(chained compare 등)는 원본 반환으로 보수적 처리.
4. **함정 회피**: (a) 가장 큰 함정 — `ast.Equality`/`ast.StrictLessThan` 같은 **존재하지 않는 ast 속성명**(hints에서 실제 `AttributeError` 발생). 올바른 이름은 `ast.Eq/ast.NotEq/ast.Lt/ast.LtE/ast.Gt/ast.GtE`. (b) chained comparison(`1 < 2 < 3`)은 `node.ops`/`node.comparators` 가 다중이라 `[0]` 만 보면 부분 처리되지만, 골드도 단일 비교만 다루므로 스코프를 거기 맞추는 것이 안전(과확장 금지). (c) `dict`에 끼워넣어 `visit_BinOp` 로 풀려는 접근은 노드 타입 불일치로 무조건 실패 — visitor 분리가 정답.
