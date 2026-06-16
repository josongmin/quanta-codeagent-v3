---
instance_id: pylint-dev__pylint-4604
repo: pylint-dev/pylint
base_commit: 1e55ae64624d28c5fe8b63ad7979880ee2e6ef3f
version: "2.9"
difficulty: "15 min - 1 hour"
created_at: 2021-06-22T10:44:14Z
fail_to_pass: 21
pass_to_pass: 0
gold_files: [pylint/checkers/variables.py, pylint/constants.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, cross-file-dep]
---

## 문제 요약

타입 코멘트(`# type: foo.Bar`)에서 점(attribute) 접근으로 모듈을 사용하면, pylint가 그 모듈 import를 사용되지 않은 것으로 오판해 `unused-import`(W0611) 거짓 양성을 낸다. 재현 코드에서 `import abc` 후 `X = ...  # type: abc.ABC`로 쓰면 `abc`가 미사용으로 보고된다. 이슈는 #3112(이전에 단순 이름 타입 코멘트 처리)의 후속으로, 이번엔 attribute 형태가 누락된 케이스다.

## 유형 (정형화)

- **L = L1 (Traceable)**: 이슈가 `unused-import` 체커를 직접 지목하지 않지만, 메시지 ID W0611 + "type comment"라는 키워드로 `pylint/checkers/variables.py`의 타입 어노테이션 수집 경로(`_store_type_annotation_node`)로 좁게 수렴한다. #3112 선례가 있어 후속 핫스팟이 자명하다.
- **S = S2 (Constraint-Reasoning)**: 고칠 지점은 명확하나, 올바른 분기를 추론으로 합성해야 한다. 기존 코드는 `astroid.Name`과 `astroid.Subscript`만 처리한다. attribute 노드(`foo.Bar`)에서 실제 사용되는 import 이름은 가장 바깥의 `.expr`을 재귀적으로 풀어 도달하는 루트 `Name`(`foo`)이라는 AST 불변식을 따져야 한다. 단순 상수/가드 추가(S1)가 아니라 노드 구조에 맞는 재귀 식을 만들어야 한다.
- **K = K-Domain (Domain-bound)**: astroid AST 노드 타입(`Attribute`/`Name`/`Subscript`)과 pylint의 타입 어노테이션 이름 수집 메커니즘(`_type_annotation_names`)을 알아야 한다. 일반 파이썬 추론만으로는 부족하다.
- **primary = T-ConstraintReason**: 위치는 좁게 특정되지만(L1), 본질은 누락된 AST 노드 클래스에 대한 올바른 재귀 처리식을 추론·합성하는 데 있다 → S2 dominant.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 실수정 파일 1개(`variables.py`), 핵심 헌크 4줄. `constants.py`는 테스트 스킵용 보조 변경이라 결함 로직과 무관.
- localize는 has-repro(명확한 재현 코드 + W0611 메시지 + #3112 선례)로 비교적 직접적이지만, 픽스가 astroid AST 도메인 지식 + 재귀 추론을 요구해 T2(자명한 픽스)보다 위.
- PASS_TO_PASS=0이라 인접 동작 회귀 trap은 명시적으로 좁다(regression-trap 플래그 미부여). 단 FAIL_TO_PASS 21개 중 신규 테스트는 1개뿐이고 나머지 20개는 같은 테스트 모듈의 기존 케이스 — 픽스가 기존 동작을 깨면 안 된다는 약한 안전망 역할.
- 공식 라벨 "15 min - 1 hour"와 일치. astroid 노드 처리에 익숙한 개발자라면 빠르나, 도메인 지식이 없으면 픽스 합성에 시간이 든다 → T3 적정.

## 골드패치 분석

- **파일·함수**: `pylint/checkers/variables.py`의 `VariablesChecker._store_type_annotation_node`. (보조: `pylint/constants.py`에 `IS_PYPY = platform.python_implementation() == "PyPy"` 추가.)
- **근본원인**: `_store_type_annotation_node`는 타입 어노테이션 노드에서 참조된 import 이름을 `self._type_annotation_names`에 모은다. `astroid.Name`(예: `ABC`)과 `astroid.Subscript`(예: `Bar[Boo]`)는 처리하지만, `astroid.Attribute`(예: `foo.Bar`) 케이스가 없다. 그래서 attribute 형태 타입 코멘트에선 루트 모듈 이름(`foo`)이 "사용됨"으로 등록되지 않아, 나중에 `unused-import`가 거짓 양성으로 발생한다.
- **수정요지**: `Name` 처리 직후 `astroid.Attribute` 분기를 추가해, `type_annotation.expr`로 재귀 호출하여 점 체인을 끝까지(`foo.Bar.Baz` → `foo`) 풀어 루트 이름을 수집하고 `return`한다. 이로써 attribute 타입 코멘트가 사용한 import가 사용된 것으로 정확히 인식된다. `constants.py`의 `IS_PYPY`는 PyPy가 타입 코멘트를 파싱하지 않으므로 신규 테스트를 `@unittest.skipIf`로 건너뛰기 위한 가드일 뿐, 결함 자체와 무관하다(이것이 cross-file-dep의 실체).

## 검증 (test_patch)

- **FAIL_TO_PASS**: 신규 `test_attribute_in_type_comment`가 핵심. `import foo`, `from foo import Bar, Boo` 후 `a = ... # type: foo.Bar`, `b = ... # type: foo.Bar[Boo]`, `c = ... # type: Bar.Boo` 세 형태를 한 모듈에 넣고 `assertNoMessages()`로 어떤 경고도 없어야 함을 단언한다. 픽스 전엔 attribute 케이스에서 `foo` import 미사용 경고가 떠 실패, 픽스 후 통과.
- **픽스 증명**: `foo.Bar`(순수 attribute), `foo.Bar[Boo]`(Subscript 안의 attribute), `Bar.Boo`(import된 이름의 attribute) 세 변형이 모두 재귀 `.expr` 언랩으로 루트 `Name`에 도달해 수집됨을 동시에 검증한다. 특히 `foo.Bar[Boo]`는 Subscript 분기와 Attribute 분기가 함께 동작해야 통과하므로 단일 케이스 overfit을 어느 정도 막는다.
- **overfit 관점**: FAIL_TO_PASS에 신규는 1개지만 그 안에 3개 변형이 들어 있고, 재귀 분기는 임의 깊이 점 체인으로 자연히 일반화된다. special-case 하드코딩으로는 세 변형을 동시에 통과시키기 어려워 overfit-risk는 낮다(플래그 미부여).
- **regression 관점**: PASS_TO_PASS=0이고 나머지 20개 FAIL_TO_PASS는 같은 모듈의 기존 테스트라 회귀 trap이 좁다. 추가 분기는 기존 `Name`/`Subscript` 경로를 건드리지 않고 그 사이에만 끼워 넣어 부작용이 없다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 W0611 + "type comment" + #3112 후속이라는 신호 → `unused-import`를 내는 `pylint/checkers/variables.py`로 진입. 타입 코멘트가 import 사용으로 집계되는 경로를 grep하면 `_store_type_annotation_node`와 `_type_annotation_names`에 도달. 기존 `Name`/`Subscript` 분기를 읽고 attribute 케이스가 빠졌음을 확인.
2. **픽스와 일반화**: `astroid.Attribute` 분기를 추가하고 `_store_type_annotation_node(type_annotation.expr)`로 재귀해 점 체인 루트의 `Name`을 수집. 이는 `foo.Bar`, `a.b.c.Type` 등 임의 깊이 attribute를 자연히 처리하므로 올바른 일반화다 — 특정 입력에 맞춘 하드코딩이 아니라 AST 구조 불변식(attribute의 base는 `.expr`)을 따른 것.
3. **regression 안전**: 새 분기를 `Name` 처리와 `Subscript` 처리 사이에 삽입해 기존 두 경로의 동작을 보존. `Subscript` 분기는 그대로 두어 `foo.Bar[Boo]`처럼 둘이 합성된 케이스도 깨지지 않음. PASS_TO_PASS가 비어 있어도 같은 모듈의 기존 20개 테스트가 회귀 가드 역할.
4. **함정 회피**: (a) `astroid.Attribute`의 잎(`.attrname`, 예 `Bar`)을 import 이름으로 오인하지 말 것 — 실제 import는 base(`.expr`)의 루트(`foo`)다. (b) attribute를 `Subscript`로 착각해 `not isinstance(..., Subscript)` 가드 앞에 두지 않으면 attribute가 그대로 early-return으로 떨어져 수집 누락이 지속된다 — 반드시 Subscript 체크 *이전*에 처리해야 한다. (c) PyPy 환경에선 타입 코멘트가 파싱되지 않아 테스트가 거짓 실패하므로 `IS_PYPY` skip 가드를 잊지 말 것(오라클 없는 에이전트는 결함 로직만 보고 이 보조 변경을 놓치기 쉽다).
