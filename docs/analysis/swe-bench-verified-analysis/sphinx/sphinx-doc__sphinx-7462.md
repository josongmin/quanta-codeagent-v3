---
instance_id: sphinx-doc__sphinx-7462
repo: sphinx-doc/sphinx
base_commit: b3e26a6c851133b82b50f4b68b53692076574d13
version: "3.1"
difficulty: "<15 min fix"
created_at: 2020-04-12T04:10:05Z
fail_to_pass: 2
pass_to_pass: 49
gold_files: [sphinx/domains/python.py, sphinx/pycode/ast.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap, cross-file-dep]
---

## 문제 요약
`Tuple[()]`(빈 튜플 타입 어노테이션, mypy 관례)을 처리할 때 sphinx가 `IndexError: pop from empty list`로 빌드 실패한다. `sphinx/domains/python.py`의 `unparse()`가 `ast.Tuple` 분기에서 원소를 순회하며 구분자 `', '`를 append하고 마지막에 무조건 `result.pop()`을 호출하는데, `node.elts`가 비면 result가 비어 있어 pop이 터진다. 빈 튜플 케이스를 별도 처리해 `()`로 렌더링해야 한다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈에 네이티브 스택트레이스(`python.py`, line 112, `result.pop()`)가 박혀 있고 hints까지 정확한 라인(L117-L122)을 지목. grep 한 방으로 끝. 다만 동일 결함이 `sphinx/pycode/ast.py`의 `unparse()`에도 병존(cross-file-dep) — 스택트레이스는 한 곳만 가리킨다.
- **S1 (Direct-Map)**: 정형 결함클래스(빈 컬렉션에 대한 무가드 `pop()`/off-by-one). 픽스는 기계적: `if node.elts:` 가드 추가 + else로 빈 튜플 리터럴 산출. 이슈 hints가 사실상 패치를 그대로 적어줌.
- **K-Gen (Knowledge)**: AST/리스트 조작 일반 파이썬 추론으로 충분. sphinx 내부 도메인지식 불필요(`desc_sig_punctuation`는 주변 코드에서 자명).
- **primary = T-DirectMap**: 위치가 자명하고(L0) 픽스가 가드/리터럴 추가의 기계적 변환(S1). T-LocTrivial이 아닌 이유는 픽스가 "한 줄"이 아니라 두 사이트에 빈-튜플 리터럴(`(`, `)`)을 명시적으로 생성하는 약간의 의도 표현을 요구하기 때문.

## 난이도 티어
**T2 (쉬움)**. 공식 라벨 `<15 min fix`와 일치(T1~T2 prior). 구조적 피처:
- 파일 2개 / 헌크 2개 / 순증 ~13줄 — 소규모.
- localize 직접성 최상(스택트레이스 + 라인지정 hints) → has-repro.
- 도메인지식 없음(K-Gen).
- **T1로 내리지 않는 이유**: (1) 단일파일이 아니라 동일 버그가 두 `unparse()`에 병존하는 cross-file-dep — `domains/python.py`만 고치면 `pycode/ast.py`의 FAIL_TO_PASS가 남는다. (2) regression-trap: PASS_TO_PASS 50개(특히 `test_unparse` 다수 케이스 + 기존 비어있지 않은 튜플 `(1, 2, 3)`)를 깨지 않아야 하므로 가드는 기존 경로를 byte-identical로 보존해야 한다.

## 골드패치 분석
- **`sphinx/domains/python.py::unparse`** (reST 노드 생성기): `ast.Tuple` 분기를 `if node.elts:`로 감싸 기존 순회+`result.pop()` 로직을 보존하고, `else`에서 `result = [desc_sig_punctuation('', '('), desc_sig_punctuation('', ')')]`로 빈 튜플을 `()` 두 punctuation 노드로 렌더.
- **`sphinx/pycode/ast.py::unparse`** (문자열 unparse): `ast.Tuple` 분기에서 `", ".join(...)`를 `if node.elts:`로 가드하고 빈 경우 `"()"` 문자열 반환.
- **근본원인**: 양쪽 모두 "비어있지 않은 튜플"을 암묵 전제. python.py는 무가드 `pop()`이 빈 list에서 터지고, ast.py는 IndexError는 없지만 빈 튜플을 빈 문자열로 잘못 렌더(silent wrong output). 동일 결함클래스의 두 표현.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_domain_py.py::test_parse_annotation` — `_parse_annotation("Tuple[()]")`가 `pending_xref Tuple` / `[` / `(` / `)` / `]` 노드 시퀀스를 내는지 단언. 픽스 전엔 `pop from empty list`로 예외, 후엔 else 분기가 정확히 `(`,`)` 노드를 산출.
  - `test_pycode_ast.py::test_unparse[()-()]` — `unparse(ast.parse("()"))`가 `"()"`인지. 픽스 전엔 빈 문자열, 후엔 `"()"`.
- **픽스 증명**: 두 테스트가 두 사이트를 각각 직접 커버 → 한 파일만 고치면 다른 FAIL_TO_PASS가 남아 overfit 차단.
- **overfit/regression 관점**: FAIL_TO_PASS가 2개로 얇지만, `if node.elts:` 가드는 비어있지 않은 모든 입력에서 기존 경로를 그대로 타므로 special-case 통과가 곧 올바른 일반화. PASS_TO_PASS `test_unparse[Tuple[int,`, `(1,` 등 기존 튜플 케이스가 회귀 가드.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `sphinx/domains/python.py` `unparse` → `result.pop()`을 직접 지목. 즉시 `ast.Tuple` 분기 도달. **핵심은 여기서 멈추지 않는 것** — `grep -rn "isinstance(node, ast.Tuple)"`로 동일 패턴이 `sphinx/pycode/ast.py::unparse`에도 있음을 확인.
2. **픽스**: `pop()`은 "원소 N개 → 구분자 N-1개" 전제의 산물. N=0이면 무효이므로 `if node.elts:`로 가드하고 빈 케이스는 빈 튜플 리터럴(`()`)을 명시 산출. ast.py도 동일 가드로 빈 문자열 대신 `"()"`. 이는 빈-입력 엣지케이스만 분기하고 나머지는 불변이라 overfit이 아닌 정확한 일반화.
3. **regression 안전**: 비어있지 않은 튜플은 `if node.elts:` true 경로로 기존 코드를 그대로 실행해야 한다. PASS_TO_PASS 50개(`(1, 2, 3)`, `Tuple[int, int]`, 함수 시그니처 다수)가 보존 증인. else 분기를 추가할 뿐 true 분기 로직을 건드리지 말 것.
4. **함정 회피**: (a) **단일사이트 픽스** — 스택트레이스만 따라 `domains/python.py`만 고치면 `pycode/ast.py` FAIL_TO_PASS가 남아 미해결(cross-file-dep 최대 함정). (b) `pop()` 자리에 `if result: result.pop()` 식 미봉으로 IndexError만 막으면 빈 튜플이 `()`가 아닌 빈 출력이 되어 `test_parse_annotation`의 `(`,`)` 노드 단언 실패. 출력 스펙(`()`)까지 맞춰야 함.
