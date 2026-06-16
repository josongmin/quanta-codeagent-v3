---
instance_id: sphinx-doc__sphinx-9673
repo: sphinx-doc/sphinx
base_commit: 5fb51fb1467dc5eea7505402c3c5d9b378d3b441
version: "4.3"
difficulty: "15 min - 1 hour"
created_at: 2021-09-25T15:53:46Z
fail_to_pass: 1
pass_to_pass: 24
gold_files: [sphinx/ext/autodoc/typehints.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`autodoc_typehints = "description"` + `autodoc_typehints_description_target = "documented"` 설정 하에서 Napoleon(Google style)으로 생성한 함수 문서에 반환 타입(`rtype`)이 누락된다. 근본은 autodoc 측 버그로, info-field-list가 `:return:`이 아니라 `:returns:` 필드를 쓰면 반환 설명을 인식하지 못한다. Napoleon이 내부적으로 `returns` 필드를 생성하기 때문에 이 경로에서 버그가 드러난다. hints_text가 `:return:`(정상)과 `:returns:`(버그) 두 함수로 정확히 격리해 준다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 직접 심볼을 지목하진 않지만, hints_text가 "info-field-list `returns` 필드", "`autodoc_typehints_description_target`"를 명시해 `sphinx/ext/autodoc/typehints.py`의 `augment_descriptions_with_types`로 좁은 수렴이 가능하다. grep `'return'`로 분기 위치까지 도달. L0는 아님(napoleon→autodoc 한 단계 추적 필요).
- **S2 (Constraint-Reasoning)**: 고칠 지점은 명확하나, 올바른 픽스는 "`return`/`returns`는 동일 의미의 별칭"이라는 불변식을 추론해 분기 조건을 정확히 합성하는 것. 후보를 무더기로 시도하는 G&V가 아니라, alias 집합 `('return', 'returns')`을 두 군데(필드 파싱 + annotation 스킵)에서 일관되게 맞춰야 함.
- **K-Domain**: docutils info-field-list 문법과 RST 필드 별칭(`:return:` vs `:returns:`), Napoleon이 생성하는 필드 형태를 알아야 정확히 짚는다. 일반 파이썬 추론(K-Gen)만으론 별칭 동치성을 모른다.
- **primary = T-ConstraintReason**: 위치는 트레이스 가능하고(L1), 핵심 난점은 "어떤 조건식이 의미상 올바른가"의 추론(S2)이다. 기계적 가드/상수 변경(S1)이 아니라 도메인 불변식 기반 조건 확장이라 DirectMap이 아님.

## 난이도 티어
**T3 (중간).** 구조 피처: 1파일, 2헌크, 실질 변경 2줄. localize는 hints_text 덕에 거의 직접(L1). has-repro 강함(별칭 2함수 대조 코드 제공). 그러나 픽스가 자명한 가드가 아니라 "별칭 동치"라는 도메인 불변식 추론을 요구하고, **두 곳을 짝지어** 고쳐야(한 곳만 고치면 rtype은 나오되 type-of-return 스킵이 깨지거나 반대) 하는 일관성 제약이 T2 위로 민다. 공식 라벨 "15분~1시간"과 정합 — repro가 강해 하한이지만, P2P 24개(인접 typehints 동작 다수)가 regression-trap을 형성해 T1로 내려가진 않는다.

## 골드패치 분석
- **파일·함수**: `sphinx/ext/autodoc/typehints.py` 내 `augment_descriptions_with_types(node, annotations)`.
- **근본원인**: 이 함수는 (1) 기존 필드를 훑어 `has_description`/`has_type` 집합을 채우는 분기에서 `parts[0] == 'return'`만 반환 설명으로 인정하고, (2) annotation 루프에서 `name == 'return'`만 "이미 반환은 별도 처리"라며 스킵한다. Napoleon이 만든 `:returns:` 필드는 `parts[0] == 'returns'`라 (1)에서 `has_description.add('return')`이 일어나지 않아 반환이 "문서화됨"으로 집계되지 않고, 결과적으로 `documented` 타겟에서 rtype이 추가되지 않는다.
- **수정요지**: 두 분기를 별칭 멤버십으로 확장 — `parts[0] in ('return', 'returns')` 및 annotation 루프의 `if name in ('return', 'returns'): continue`. 즉 `returns`를 `return`의 동의어로 받아들여 반환 설명 인식과 반환-annotation 스킵을 모두 정상화한다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_autodoc_typehints_description_no_undoc` 하나. 테스트에 `target.typehints.decr`(`:returns: decremented number` 사용) 케이스를 추가하고, 빌드 출력에 `Returns:` 설명 + `Return type:\n   int`가 모두 나타나야 함을 단언한다. 픽스 전엔 `returns` 별칭이 미인식되어 `Return type` 블록이 누락 → 단언 실패. 픽스 후 (1) 분기가 `has_description.add('return')`을 실행 → `documented` 조건 충족 → rtype 출력.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 보이지만, 픽스는 special-case가 아니라 별칭 동치라는 일반화라 overfit-risk를 플래그하지 않음(`decr`만 통과시키는 하드코딩이 아님). 기존 `incr`/`:return:` 케이스도 같은 코드경로로 계속 통과.
- **regression 관점**: P2P 24개가 `test_autodoc_typehints_description*` 군을 포함해 `:return:` 정상 경로·`none`/`both`/`signature`/타입별칭 동작을 폭넓게 커버. `in (...)` 확장은 `return`을 여전히 매칭하므로 기존 동작 보존이 보장된다(regression-trap 통과).

## 모범답안 (오라클 기반)
1. **localize**: 이슈는 Napoleon을 비난하지만 hints_text가 "autodoc 버그, `:returns:`일 때만 발생"으로 재지목. `autodoc_typehints_description_target="documented"` 처리 주체를 따라가면 `sphinx/ext/autodoc/typehints.py`. `'return'` 문자열 grep → `augment_descriptions_with_types`에서 `parts[0] == 'return'`(필드 분류)과 `name == 'return'`(annotation 스킵) 두 등호 비교 발견.
2. **픽스/일반화**: RST info-field-list에서 `:return:`과 `:returns:`는 의미상 동일 별칭이다(docutils 관례). 따라서 두 등호를 별칭 멤버십 `in ('return', 'returns')`으로 바꾸는 것이 올바른 일반화 — `returns`만 특수 추가하는 것이 아니라 동치 집합으로 다루므로 향후 어느 경로(Napoleon이든 수작성이든)에서 와도 일관. 한 곳만 고치면 안 되는 이유: 필드 분류에서만 고치면 반환이 description으로 잡히지만 annotation 루프 스킵이 여전히 `'return'`만 보아 `returns`-키 annotation 처리가 어긋날 수 있어, 두 곳을 짝지어야 불변식이 닫힌다.
3. **regression 안전**: `:param`/`:type`/`:rtype`/`:return:` 정상 경로(P2P의 `test_autodoc_typehints_description`, `_both`, `_with_documented_init` 등)는 `return`이 여전히 매칭되어 byte-identical 동작 유지. 확장이 순수 superset이라 인접 24개 동작을 깨지 않음.
4. **함정 회피**: 오라클 없는 에이전트가 (a) 이슈 표면만 보고 `sphinx/ext/napoleon/`을 고치려다 잘못된 파일에 패치(napoleon은 정상, 버그는 autodoc), (b) 필드 분류 분기 한 곳만 고치고 annotation 스킵을 빠뜨려 부분 수정, (c) `returns`를 별칭이 아닌 신규 케이스로 분기 추가해 코드 중복·미묘한 불일치 유발. 회피법: hints_text의 `:return:` vs `:returns:` 대조를 신뢰해 autodoc로 직행하고, `'return'` 등호가 등장하는 **모든** 비교를 동시에 별칭 멤버십으로 통일.
