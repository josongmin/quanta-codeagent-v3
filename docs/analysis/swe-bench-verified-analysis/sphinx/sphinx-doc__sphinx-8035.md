---
instance_id: sphinx-doc__sphinx-8035
repo: sphinx-doc/sphinx
base_commit: 5e6da19f0e44a0ae83944fb6ce18f18f781e1a6e
version: "3.2"
difficulty: "15 min - 1 hour"
created_at: 2020-08-01T16:28:05Z
fail_to_pass: 1
pass_to_pass: 2
gold_files: [sphinx/ext/autodoc/__init__.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain
flags: [overfit-risk, underspecified, cross-file-dep]
---

## 문제 요약
autodoc의 `:private-members:` 옵션은 현재 boolean이라 "모든 private 멤버 문서화" 또는 "안 함" 둘뿐이다. 사용자는 `:members:`처럼 특정 private 멤버 이름만 골라 문서화하고 싶다(피처 요청). 즉 옵션 파서 타입을 bool에서 인자-수용형으로 바꾸고, 멤버 필터링 로직이 "이름 목록"을 해석하도록 확장해야 한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 파일을 직접 지목하진 않지만 `:private-members:` 키워드 → `sphinx/ext/autodoc/__init__.py`의 옵션 스펙(`option_spec`)과 `filter_members` 필터 분기로 좁게 수렴한다. 단일 파일. grep `private_members` 한 방은 아니고 옵션-파서/필터 양쪽을 봐야 함.
- **S5 Spec-Inference (+S6 Design-Refactor)**: 버그 수정이 아니라 피처라 "올바른 동작"이 코드에 없다. 기존 `:members:`/`:special-members:`가 ALL/리스트/None 3-상태를 어떻게 다루는지(관례)에서 스펙을 역추론해야 한다. 게다가 `merge_special_members_option`을 deprecate하고 일반화된 `merge_members_option`을 도입하는 작은 구조 변경을 동반(S6).
- **K-Domain**: `members_option` 파서, `ALL` 센티넬, `is_filtered_inherited_member`, `RemovedInSphinx50Warning` 등 autodoc 내부 계약 지식이 병목. 일반 파이썬 추론으론 부족.
- primary = **T-SpecInference**: 진짜 난점은 "어디"가 아니라 "이 옵션이 ALL/지정리스트/미설정에서 각각 어떻게 행동해야 하는가"라는 스펙을 기존 `:members:` 관례에 정합하게 재구성하는 것.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개·함수 영향 ~4지점(옵션 dict 2곳, `filter_members` 2분기, 신규 함수 1개)이라 scope는 중간.
- localize는 L1로 어렵지 않으나, S5 스펙추론 + S6 소규모 리팩터(deprecate + 일반화 함수)가 결합되어 T3을 넘는다.
- **P2P trap**: `test_private_field`, `test_private_field_and_private_members` 2개가 기존 ALL/`:meta private:` 동작을 그대로 유지해야 함 — 3-상태 분기를 잘못 짜면 회귀.
- overfit 위험(아래)으로 T5 쪽 압력이 있으나 멀티파일/깊은 데이터플로우가 아니라 T4에 고정.

공식 라벨 "15 min - 1 hour"와 정합. 다만 시간라벨은 ALL/None/list 3-상태 정합성과 inherited-member 상호작용이라는 추론 비용을 과소평가한다.

## 골드패치 분석
건드린 파일: `sphinx/ext/autodoc/__init__.py` 단일.
- **옵션 파서 타입 변경**: `ModuleDocumenter.option_spec`과 `ClassDocumenter.option_spec`에서 `'private-members': bool_option` → `members_option`. 이제 `:private-members: a, b`가 리스트로, 인자 없으면 `ALL`로 파싱됨.
- **신규 `merge_members_option(options)`**: `:private-members:`/`:special-members:`로 지정된 이름들을 `:members:` 리스트에 병합(단 `members is ALL`이면 skip). 기존 `merge_special_members_option`은 `RemovedInSphinx50Warning`으로 deprecate하고 두 Documenter의 `__init__`이 신규 함수를 호출하도록 교체.
- **`filter_members` 분기 재작성**: private 멤버 keep 판정을 `bool`이 아니라 3-상태로:
  - `private_members is None` → `keep = False`
  - `private_members is ALL` → `keep = True`
  - else → `keep = membername in self.options.private_members`
  attr_docs 경로와 일반 private 경로 둘 다 동일 패턴으로, 일반 경로는 `is_filtered_inherited_member`와 `has_doc or undoc_members` 게이트를 보존.
- **근본원인**: `private-members`가 bool 센티넬이라 "선택적 화이트리스트" 표현력이 원천적으로 없음. 타입을 `:members:`와 동형(`members_option`+ALL/list/None)으로 끌어올려 해결.

## 검증 (test_patch)
FAIL_TO_PASS = `test_private_members` 1개. `members: None`(→`members_option(None)`→`ALL`) + `private-members: "_public_function"`로 지정하면 `target.private`의 `_public_function`만 문서화되고 `:meta public:`가 출력됨을 단언. 인과를 정확히 따지면:
  - (a) `members_option` 파서가 `private-members`를 `['_public_function']` 리스트로 만든다.
  - (b) `merge_members_option`은 **이 테스트에서 병합을 수행하지 않는다**. `members is ALL`이므로 첫 줄 `if options.get('members') is ALL: return`에서 즉시 early-return(merging not needed). 따라서 `_public_function`이 `:members:`에 병합되어 통과하는 게 아니다.
  - (c) `_public_function`은 docstring에 `:meta public:`가 있어 `isprivate = False`로 판정되므로(base `__init__.py` L618-620) private 분기에 들어가지 않고 일반 `else` 분기(`members is ALL` → `keep = has_doc or undoc_members`)로 통과한다. `membername in private_members`로 "특정 이름을 통과"시키는 게 아니다.
  - 픽스의 진짜 핵심 인과는 **미지정 private 멤버 제외**다: `private_function`은 `:meta private:`로 `isprivate = True`(L615-617)이며, 골드패치 일반 private 분기 `keep = membername in self.options.private_members`에서 `'private_function' not in ['_public_function']` → `keep = False`로 **DROP**된다. 패치 전(`bool_option`→`True`)에는 `keep = True and has_doc`로 `private_function`까지 keep되어 기대출력(`_public_function`만 존재)과 어긋나 테스트가 실패했다.
- **overfit 관점**: FAIL_TO_PASS 1개뿐이라 ALL 케이스·None 케이스·여러 이름·inherited 상호작용은 직접 검증 안 됨 → `overfit-risk`. special-case(예: 항상 keep) 구현으로도 이 단일 테스트는 통과 가능.
- **regression 관점**: PASS_TO_PASS의 `test_private_field`(ALL=`:meta private:`), `test_private_field_and_private_members`가 ALL/None 경로를 잡아준다. 3-상태 분기에서 ALL→True, None→False를 보존해야 깨지지 않음.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈의 `:private-members:` 키워드로 `sphinx/ext/autodoc/__init__.py`를 열고, `:special-members:`가 이미 인자-수용형인 점을 단서로 잡는다. `option_spec`의 `private-members': bool_option`과 `filter_members`의 `self.options.private_members` 사용처(attr_docs 분기 + 일반 private 분기)를 후보로 확정.
2. **픽스와 일반화**: 파서를 `bool_option`→`members_option`으로 바꿔 `:special-members:`와 동형으로 만들고, 필터를 `None/ALL/list` 3-상태로 재작성. `:members:` 병합은 `merge_special_members_option`을 베끼지 말고 private+special을 함께 처리하는 `merge_members_option`으로 일반화(구 함수는 deprecate). 이게 overfit 아닌 이유: 기존 `:members:` 관례에 정합한 동형 설계라 ALL/지정/미설정 전 입력공간을 균일하게 커버한다.
3. **regression 안전**: ALL→keep, None→drop을 명시 분기로 보존해 `test_private_field`(ALL 경로)와 `test_private_field_and_private_members`가 유지되게 한다. `is_filtered_inherited_member`와 `has_doc or undoc_members` 게이트를 일반 private 경로에서 떨어뜨리지 않는 것이 핵심.
4. **함정 회피**: (a) `filter_members`만 고치고 `option_spec` 타입을 안 바꾸면 인자가 파싱조차 안 됨 — 두 곳 동시 수정 필수. (b) `merge_members_option`에서 `members is ALL`일 때 병합을 skip하지 않으면 ALL이 망가짐. (c) None과 빈 리스트를 혼동하면 "지정 안 함"이 "전부 통과"로 뒤집힘 — `is None` 명시 체크 필요. (d) 옵션 스펙을 ModuleDocumenter 한쪽만 바꾸면 ClassDocumenter에서 회귀. 단일 테스트만 보고 멈추지 말고 3-상태를 의식적으로 구현해야 함.
