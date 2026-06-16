---
instance_id: pylint-dev__pylint-4551
repo: pylint-dev/pylint
base_commit: 99589b08de8c5a2c6cc61e13a37420a868c80599
version: "2.9"
difficulty: 1-4 hours
created_at: 2021-06-07T15:14:31Z
fail_to_pass: 10
pass_to_pass: 0
gold_files: [pylint/pyreverse/diagrams.py, pylint/pyreverse/inspector.py, pylint/pyreverse/utils.py, pylint/pyreverse/writer.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified, cross-file-dep]
---

## 문제 요약
pyreverse(UML 생성기)가 PEP 484 타입힌트를 읽지 못한다. `def __init__(self, a: str = None)`처럼 디폴트가 `None`인 경우 특히 무용한데, 추론(`node.infer()`)이 `None`만 잡아 어노테이션 정보가 UML 다이어그램에서 누락된다. 이슈는 "feature request"로, `a : str`(또는 `Optional[str]`) 형태의 어노테이션을 다이어그램에 표시해달라는 요구다. 즉 기존 추론 기반 타입 표기를 어노테이션 우선 표기로 확장하는 작업이다.

## 유형 (정형화)
- **L (Localization) = L3.** 직접 포인터가 거의 없는 feature request. 픽스는 `pyreverse` 패키지 4개 파일(`utils.py`, `inspector.py`, `diagrams.py`, `writer.py`)에 걸쳐 **조율되어** 바뀐다. 어노테이션 추출(utils) → 타입수집 연결(inspector) → 노드클래스 허용(diagrams) → 렌더링(writer)의 데이터플로우 전 구간을 함께 손대야 한다. 단일 grep으로 수렴 불가.
- **S (Repair Strategy) = S6 (+S5).** 한 줄 가드가 아니라 **구조 변경**이 본질이다. 신규 함수 3개(`get_annotation_label`, `get_annotation`, `infer_node`)를 도입하고, 기존 추론 사이트(`visit_assignname`/`handle_assignattr_type`)를 새 헬퍼로 갈아끼우며, 렌더 루프를 인자별 어노테이션 join으로 재작성한다. 의도된 동작(특히 `None` 디폴트 → `Optional[T]`)은 이슈 본문/PEP 484 관례에서 **스펙을 재구성**해야 해서 S5 보조.
- **K (Knowledge) = K-Domain.** astroid AST 도메인 지식이 병목이다. `AnnAssign`/`AssignAttr`/`AssignName`/`Subscript`/`Name` 노드 구분, `init_method.args.annotations` 정렬, `node.parent.parent`로 `__init__` 도달, `as_string()` 등은 astroid 내부지식 없이는 못 쓴다.
- **primary = T-DesignRefactor.** L3 멀티사이트지만 "어디인지 찾기"보다 **조율된 작은 구조 도입**(헬퍼 함수 + 데이터플로우 재배선)이 진짜 난점이라 T-DiffuseLoc보다 T-DesignRefactor가 dominant. APR 관점: 정형 결함이 아니라 신규 기능 합성이므로 템플릿(S1)·제약추론(S2) 모두 부적합하고, 구조 재배치(S6)가 정확한 라벨이다.

## 난이도 티어
**T5 (어려움).** 구조적 피처: (1) **4파일** 동시 수정 — 루브릭 컷에서 ≥3파일은 solve <10% 구간. (2) 신규 함수 도입 + 기존 try/except 추론 블록 2곳 교체 + 렌더 루프 재작성으로 **멀티헌크**. (3) localize 직접성이 매우 낮음(feature request, 스택트레이스 없음). (4) `None` 디폴트 → `Optional` 승격은 PEP 484 관례 추론이 필요. 공식 difficulty 라벨은 `1-4 hours`(T4~T5 경계)인데, 개발자 구현시간 기준이라 cross-file 조율과 astroid 도메인 부담이 시간라벨에 덜 잡힌다. **PASS_TO_PASS=0**이라 regression-trap은 명시적 P2P로는 약하나, FAIL_TO_PASS에 포함된 골든-닷파일 회귀(`test_dot_files`)가 사실상 전체 렌더 출력 회귀를 막아 trap 역할을 한다 → 하향 못 하고 T5 유지.

## 골드패치 분석
- **`utils.py` (신규):** `get_annotation_label(ann)` — `Subscript`면 `as_string()`, `Name`이면 `.name`으로 라벨화. `get_annotation(node)` — `AnnAssign`은 `node.parent.annotation`, `AssignAttr`은 `init_method.args.annotations`를 `init_method.locals`와 zip해 파라미터명으로 조회. 디폴트가 `None`이고 라벨이 `Optional`로 시작 안 하면 `Optional[{label}]`로 승격. `infer_node(node)` — 어노테이션이 있으면 `{ann}`, 없으면 `set(node.infer())`, `InferenceError`면 `set()`.
- **`inspector.py`:** `visit_assignname`/`handle_assignattr_type`의 `try: set(node.infer()) except InferenceError: pass` 패턴을 `utils.infer_node(node)`로 치환. 예외삼킴이 신규 헬퍼 내부로 흡수됨.
- **`diagrams.py` `class_names`:** `isinstance(node, astroid.ClassDef)` → `isinstance(node, (astroid.ClassDef, astroid.Name, astroid.Subscript))`로 확장. 어노테이션 노드(Name/Subscript)가 타입수집에서 탈락하던 걸 허용.
- **`writer.py` `get_values`:** 메서드 라벨 생성 시 `func.returns`로 리턴타입(`: T`), 인자별 `func.args.annotations[1:]`를 zip해 `arg: ann` 형태로 join, `f"{func.name}({args}){return_type}"`로 시그니처를 어노테이션 포함 렌더.
- **근본원인:** 추론(`infer`)만으로 타입을 잡아 어노테이션을 무시했고, 특히 `None` 디폴트가 추론을 `NoneType`으로 오염시켜 정보가 사라졌다. 어노테이션을 1차 소스로 삼는 경로가 부재했던 것.

## 검증 (test_patch)
- **FAIL_TO_PASS 10개.** 신규: `test_get_annotation_annassign`(4 파라미터 — `a: str = None`→`Optional[str]` 등 `None`→Optional 승격 직접검증), `test_get_annotation_assignattr`(6 파라미터 — `__init__` AssignAttr 경로), `test_infer_node_1`(InferenceError + 어노테이션 없음 → `set()`), `test_infer_node_2`(추론 성공 → `set(node.infer())`). 기존: `test_dot_files`(골든 닷파일 회귀)와 `test_get_visibility`가 import 변경(`get_annotation, infer_node` 추가)으로 함께 재수집되어 FAIL_TO_PASS에 들어옴.
- **픽스 증명:** `test_infer_node_1/2`가 `get_annotation`을 mock None으로 고정하고 `infer`를 각각 InferenceError/정상으로 패치해 분기 두 갈래를 독립 검증 — `infer_node`의 fallback·예외처리가 정확히 명세된다. annassign/assignattr 테스트가 `Optional` 승격 로직을 케이스별로 고정.
- **overfit·regression:** `None`→`Optional` 승격이 4+6 파라미터화로 다양 입력을 덮어 special-case 통과 어려움. 다만 mock 기반 `infer_node` 테스트는 실제 astroid 동작 대신 `set("x")` 같은 합성값을 써서 의미적 결합은 약함(`overfit-risk`까지는 아님). 골든 닷파일이 전체 렌더 출력 동치를 강제해 regression을 잡는다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈 신호 "pyreverse가 타입힌트를 안 읽음 / None 디폴트 문제" → `pyreverse` 패키지 진입. 타입이 *어디서 수집*되는가(`inspector.py`의 `node.infer()` 두 사이트)와 *어디서 렌더*되는가(`writer.py` `get_values`의 시그니처 문자열)를 데이터플로우로 잇는다. 추론이 `None`을 잡는 지점이 병목임을 확인하고, 어노테이션을 1차 소스로 삼을 신규 경로가 필요함을 도출.
2. **픽스와 일반화:** `infer_node` 헬퍼로 "어노테이션 우선, 없으면 추론, 실패면 빈집합"을 한 곳에 캡슐화 — 두 추론 사이트가 동일 정책을 공유해 일관성 확보(올바른 일반화). `get_annotation`이 `AnnAssign`·`AssignAttr` 양경로를 모두 처리하고 `None` 디폴트를 PEP 484 관례대로 `Optional[T]`로 승격. `diagrams.class_names`가 Name/Subscript를 허용해야 어노테이션 노드가 타입수집을 통과 — 이 한 줄이 빠지면 렌더는 되도 수집이 누락된다.
3. **regression 안전:** `test_dot_files` 골든 닷파일이 비-어노테이션 코드의 출력 동치를 강제하므로, 어노테이션이 없는 인자는 기존 `arg.name`과 동일하게 렌더돼야 한다(`ann`이 falsy면 `f"{arg.name}"`). `infer_node`의 빈집합 fallback이 기존 try/except 삼킴과 동작 동치여야 인접 타입수집이 안 깨진다.
4. **함정 회피:** (a) writer만 고치고 inspector/diagrams를 빼면 타입수집 단계에서 어노테이션 노드가 탈락해 렌더에 데이터가 안 온다(cross-file 조율 필수 — 단일파일 픽스로 착각하기 쉬움). (b) `args.annotations` 인덱싱에서 `self`(첫 인자) 오프셋을 놓치면 인자-어노테이션 정렬이 어긋난다 — writer는 `annotations[1:]`, get_annotation은 `locals`와 zip으로 처리. (c) `None` 디폴트를 단순 추론에 맡기면 `Optional` 승격을 못 해 이슈 핵심을 놓친다 — 디폴트값 검사를 명시해야 한다.
