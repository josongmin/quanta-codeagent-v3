---
instance_id: sphinx-doc__sphinx-7440
repo: sphinx-doc/sphinx
base_commit: 9bb204dcabe6ba0fc422bf4a45ad0c79c680d90b
version: "3.0"
difficulty: "<15 min fix"
created_at: 2020-04-08T13:46:43Z
fail_to_pass: 1
pass_to_pass: 12
gold_files: [sphinx/domains/std.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
glossary 디렉티브에서 대소문자만 다른 두 용어(예: `MySQL`와 `mysql`)를 등록하면 "duplicate term description ... other instance in glossary" 경고가 발생하고, `warning-is-error` 설정에서는 빌드가 실패한다. 사용자 기대는 `MySQL != mysql` 즉 두 용어가 별개 객체로 취급되는 것이다. 실제로는 term 등록 시점에 강제로 소문자화하여 서로 다른 용어가 같은 키로 충돌한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 "glossary duplicate term"을 명시하고 경고 메시지("other instance in glossary")가 std 도메인의 중복검출 경로를 지목한다. `sphinx/domains/std.py`의 glossary/term 처리로 좁은 수렴이 가능하나, 충돌의 진짜 원인이 `note_object` 호출의 `.lower()`라는 점은 코드를 읽어야 드러나므로 L0(grep 한 방)는 아니다.
- **S2 (Constraint-Reasoning)**: 고칠 지점(term 등록)은 곧 찾지만, 올바른 픽스는 "소문자 정규화를 어디까지 제거해야 동작이 일관되는가"라는 불변식 추론이다. 등록 측(`make_glossary_term`)과 참조 측(`'term'` XRefRole의 `lowercase=True`)을 **함께** 일관되게 풀어야 정합하므로, 단순 한 줄 가드(S1) 이상이다.
- **K-Domain**: docutils 노드 트리, std 도메인의 `note_object`/`get_objects` 객체 모델, XRefRole의 `lowercase` 의미 등 Sphinx 내부 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 비교적 명확하나, 정답은 "term의 case는 보존되어야 한다"는 의도된 불변식을 재구성해 등록·참조 양쪽의 정규화를 짝맞춰 제거하는 의미 추론이다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일(`std.py`), 골드 2헌크·실질 2줄 변경, has-repro(외부 phpmyadmin 빌드 실패 재현)이라 표면적으로는 공식 라벨 "<15 min fix"와 일치한다. 그러나 T1/T2로 내리지 않는 이유는 (1) 픽스가 단순 가드 추가가 아니라 등록(`make_glossary_term`)과 참조(`XRefRole(lowercase=True)`) **두 군데의 case 정책을 동시에 일관화**해야 하는 짝 변경이고, (2) PASS_TO_PASS 12개 중 `test_glossary_sorted`/`test_glossary_alphanumeric`/`test_glossary_conflicted_labels` 등 정렬·라벨 충돌 동작이 case 변경에 민감해 regression-trap이 실재하기 때문이다. localize는 쉬우나 "어디까지 lower를 빼고 어디는 남기나"의 의미 추론이 T3로 민다.

## 골드패치 분석
- **파일/심볼**: `sphinx/domains/std.py` — 함수 `make_glossary_term`, 클래스 `StandardDomain.roles`의 `'term'` 항목.
- **근본원인**: term 객체가 std 도메인에 `std.note_object('term', termtext.lower(), node_id, ...)`로 **소문자 키**로 등록된다. `MySQL`과 `mysql`이 둘 다 `mysql` 키로 정규화되어 같은 객체로 간주 → 중복 경고. 즉 case-insensitive 등록이 의도와 어긋난 결함.
- **수정요지**: (1) `make_glossary_term`에서 `termtext.lower()` → `termtext`로 바꿔 **원래 표기 그대로** 등록. (2) `'term': XRefRole(lowercase=True, ...)` 에서 `lowercase=True`를 제거해, term 참조(`:term:`) 시 타깃을 소문자로 깎지 않도록 등록 측과 참조 측의 case 정책을 일치시킴. 두 변경이 짝을 이뤄야 등록된 case-보존 키를 참조가 그대로 찾는다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/test_domain_std.py::test_glossary` 하나. 테스트가 glossary 입력의 `term2`를 `TERM2`로 바꾸고, 기대 doctree의 term 텍스트(`"TERM2"`), 인덱스 엔트리(`("single", "TERM2", "term-TERM2", ...)`), 그리고 `get_objects()` 결과 튜플(`("TERM2", "TERM2", "term", "index", "term-TERM2", -1)`)이 **대문자를 보존**할 것을 단언한다.
- **픽스 증명**: `.lower()` 제거로 `note_object`/index 키가 원문 case를 유지 → `term-TERM2` node_id와 객체 튜플이 정확히 매칭. `lowercase=True` 제거가 없으면 `:term:` 역참조가 깨지므로 둘이 함께 통과를 보장.
- **overfit/regression 관점**: FAIL_TO_PASS가 1개로 얇지만(overfit 표면), 테스트가 doctree·index·objects 세 층을 동시에 단언해 special-case 통과가 어렵다. regression 면에서는 `test_glossary_warning`(실제 동일-case 중복은 여전히 경고해야 함)과 `test_glossary_conflicted_labels`가 안전망 역할 — case 보존이 동일-case 중복 검출까지 무력화하지 않음을 P2P가 잡는다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "duplicate term ... other instance in glossary" 경고 문구로 grep → std 도메인의 중복검출은 `note_object`가 게이트. glossary term 등록 콜사이트인 `make_glossary_term`로 좁히면 `std.note_object('term', termtext.lower(), ...)`의 `.lower()`가 두 case를 한 키로 뭉개는 주범임이 드러난다.
2. **픽스/일반화**: `.lower()`를 제거해 term을 원문 표기로 등록. 이게 overfit 아닌 이유는 "용어 표시명은 사용자가 쓴 case 그대로 보존되어야 한다"는 의도된 스펙을 복원하는 것이고, `MySQL`/`mysql` 같은 임의 case쌍 전체에 일반화되기 때문(특정 테스트 문자열 하드코딩 아님). 단, 등록만 고치면 `:term:` 참조가 `lowercase=True`로 타깃을 깎아 dangling이 되므로 `'term'` XRefRole의 `lowercase=True`도 함께 제거해야 등록·참조 case 정책이 정합한다.
3. **regression 안전**: `test_glossary_warning`(동일-case 진짜 중복은 계속 경고)과 `test_glossary_sorted`/`_alphanumeric`(정렬·표시 순서)이 깨지지 않아야 한다. case 보존은 **다른** case를 분리할 뿐 같은 case 충돌 검출은 그대로 두므로 안전. `'ref'` 역할의 `lowercase=True`는 건드리지 않는다(라벨 참조는 여전히 case-insensitive가 의도).
4. **함정 회피**: 오라클 없는 에이전트는 (a) `make_glossary_term`의 `.lower()`만 빼고 XRefRole `lowercase=True`를 남겨 `:term:` 참조가 깨지는 절반-수정에 빠지기 쉽다 — 등록과 참조를 짝으로 봐야 한다. (b) 반대로 std 도메인 전역에서 case-insensitivity를 다 제거하려다 `'ref'`/`'numref'` 등 의도적으로 lowercase여야 하는 역할까지 건드려 인접 P2P를 깨는 과교정 위험. 수정 범위를 `'term'` 역할과 그 등록 경로로 국한하는 것이 정답.
