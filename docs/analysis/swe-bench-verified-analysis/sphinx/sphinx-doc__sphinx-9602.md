---
instance_id: sphinx-doc__sphinx-9602
repo: sphinx-doc/sphinx
base_commit: 6c38f68dae221e8cfc70c137974b8b88bd3baaab
version: "4.2"
difficulty: "15 min - 1 hour"
created_at: "2021-09-01T17:26:58Z"
fail_to_pass: 1
pass_to_pass: 45
gold_files: [sphinx/domains/python.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

## 문제 요약
`-n -W`(nitpicky) 빌드에서 `Literal[True]` 같은 타입 어노테이션의 값이 `py:class`로 취급되어, `True`/`False`/`0`/`'abc'` 같은 리터럴 값이 "missing class" 경고를 내고 빌드를 깨뜨린다. 어노테이션 파서가 subscript 슬라이스 안의 값을 다른 타입명과 똑같이 cross-reference로 변환하기 때문이다. 기대 동작은 `Literal[...]` 내부의 값들은 그대로 텍스트(리터럴)로 렌더링하고 xref를 만들지 않는 것이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `Literal` 어노테이션 처리를 직접 지목하므로 `domains/python.py`의 `_parse_annotation`/내부 `unparse`로 좁게 수렴한다. 단, 정확한 결함 라인은 grep 한 방이 아니라 "Text → type_to_xref 변환" 흐름을 읽어야 보인다.
- **S2 (Constraint-Reasoning) +S6**: 고칠 위치는 명확하나, "Subscript의 value가 Literal일 때만 슬라이스 값을 xref에서 제외"라는 조건을 추론으로 합성해야 한다. 단순 가드 추가가 아니라 `nodes.literal` 래핑이라는 작은 마커 도입(S6)으로 두 단계(unparse / xref 변환)를 조율한다.
- **K-Domain**: docutils/sphinx 노드 트리(`nodes.Text`, `nodes.literal`, `addnodes.desc_sig_punctuation`)와 `type_to_xref`의 의미를 알아야 한다. 프레임워크 내부 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 알지만 "어느 노드를 xref 대상에서 빼고 어떻게 다시 텍스트로 복원할지"를 의미적으로 설계하는 게 핵심. 기계적 템플릿(S1)으로는 안 풀린다.

## 난이도 티어 — **T4**
- 파일 1개, 골드 패치 ~13줄(3 헌크)로 규모는 작다.
- 그러나 localize가 자명하지 않고(L1), 픽스가 두 지점(① `ast.Constant`의 `repr` 처리, ② Subscript에서 Literal 검출 후 `nodes.literal` 래핑, ③ xref 루프에서 literal 노드 언랩)을 **조율**해야 해서 S2+S6 성격.
- P2P 45개가 같은 파일(`test_domain_py.py`)의 어노테이션/시그니처 렌더링을 광범위하게 검증 → **regression-trap**. `repr` 도입이 숫자/문자열 리터럴 표현을 바꿔 `test_pyfunction_with_number_literals` 등을 깨기 쉽다.
- 공식 라벨 "15분-1시간"과 일치. has-repro지만 재현이 외부 프로젝트라 직접 스택트레이스는 없음 → T3보다 위, 멀티파일/overfit 고위험은 아니라 T5 아래. **T4** 타당.

## 골드패치 분석
- **파일/함수**: `sphinx/domains/python.py` 내 `_parse_annotation`의 중첩 함수 `unparse` + 바깥 xref 변환 루프.
- **근본원인**: `unparse`가 `ast.Subscript` 슬라이스를 `nodes.Text`로 만들고, 바깥 루프가 모든 `nodes.Text`를 `type_to_xref(...)`로 무차별 변환한다. `Literal[True]`의 `True`도 클래스 참조로 둔갑 → nitpick 경고. 또한 `ast.Constant` 값이 `nodes.Text(node.value)`로 들어가 비문자열 값(bool/int)이 `repr` 없이 처리되는 표현 문제도 동반.
- **수정요지**:
  1. `ast.Constant` 분기: `nodes.Text(node.value)` → `nodes.Text(repr(node.value))` — 값을 소스 표기(`True`, `0`, `'abc'`)로 정확히 렌더.
  2. `ast.Subscript` 분기: `result[0]`이 `'Literal'`/`'typing.Literal'`이면 슬라이스 내부 `nodes.Text`들을 `nodes.literal('', '', subnode)`로 래핑(xref 대상에서 빼는 마커).
  3. xref 루프: `nodes.literal`이면 xref 대신 `result[i] = node[0]`로 언랩해 원래 텍스트만 남김.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_parse_annotation_Literal` 1개. `_parse_annotation("Literal[True, False]", env)`가 `True`/`False`를 `pending_xref`가 아닌 **순수 텍스트**로 내고, `typing.Literal[0, 1, 'abc']`도 `0`/`1`/`'abc'`를 텍스트로 내는지 `assert_node`로 확인. `Literal`/`typing.Literal` 자체는 여전히 `pending_xref`여야 함.
- **픽스 증명**: 래핑→언랩 경로 덕에 슬라이스 값에는 xref가 안 붙고(경고 제거), `repr` 덕에 `'abc'`의 따옴표와 `0`/`1`의 정확한 표기가 기대 트리와 일치.
- **overfit/regression**: FAIL_TO_PASS는 얇지만(1개), 픽스가 `Literal`/`typing.Literal` 둘 다 + bool/int/str 케이스를 일반적으로 다뤄 special-case 냄새는 약함. 다만 `repr` 변경이 일반 어노테이션의 숫자/문자열 리터럴 렌더에 영향 → P2P의 `test_pyfunction_with_number_literals`가 회귀 가드 역할.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "Literal 값이 py:class로 취급" + "nitpick 경고" 신호 → 어노테이션을 노드로 바꾸는 곳을 찾는다. `domains/python.py`의 `_parse_annotation` 끝 루프 `if isinstance(node, nodes.Text) ...: type_to_xref(...)`가 바로 모든 텍스트를 참조화하는 범인. Subscript 처리(`unparse`)와 짝지어 읽는다.
2. **픽스/일반화**: Subscript의 base가 `Literal`/`typing.Literal`일 때 슬라이스 값을 xref에서 제외해야 한다. "literal 노드로 래핑 후 루프에서 언랩"은 노드 종류로 분기하는 깔끔한 마커 패턴 — 특정 값(`True`)을 하드코딩하지 않으므로 임의 리터럴 전반에 일반화된다. `repr`은 bool/int 값의 소스 표기를 보존하는 옳은 일반화.
3. **regression 안전**: P2P 45개(시그니처/어노테이션/xref 렌더 전반)를 안 깨야 한다. 특히 일반 어노테이션의 텍스트는 여전히 xref가 되어야 하므로, 래핑은 **Literal 컨텍스트로만** 한정해야 한다(`result[0] in ('Literal','typing.Literal')` 게이트). `repr` 도입 시 숫자 리터럴 표기 회귀를 `test_pyfunction_with_number_literals`로 확인.
4. **함정 회피**: (a) 모든 subscript 슬라이스를 xref에서 빼버리면 `List[int]`의 `int` 참조가 사라져 회귀 — Literal에만 한정해야 함. (b) `repr` 없이 처리하면 `'abc'`의 따옴표/타입 표기가 어긋남. (c) `Literal` 검출을 `node.value` AST에서 하려다 `typing.Literal`(Attribute) 표기를 놓치기 쉬움 — 골드처럼 이미 unparse된 `result[0]` 문자열로 검사하면 두 표기 모두 잡힌다.
