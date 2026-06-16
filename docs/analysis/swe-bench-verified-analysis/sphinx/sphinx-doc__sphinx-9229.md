---
instance_id: sphinx-doc__sphinx-9229
repo: sphinx-doc/sphinx
base_commit: 876fa81e0a038cda466925b85ccf6c5452e0f685
version: "4.1"
difficulty: 1-4 hours
created_at: 2021-05-15T07:21:49Z
fail_to_pass: 1
pass_to_pass: 13
gold_files: [sphinx/ext/autodoc/__init__.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

## 문제 요약

타입 별칭(type alias)에 next-line `"""` 또는 `#:` 형태의 변수 doccomment를 달아도, autodoc이 docstring을 무시하고 `alias of ...` 기본 텍스트만 렌더한다. 동일 파일의 여러 별칭 중 일부만 docstring이 보이는 비일관 동작으로 보고됐다. 기대 동작은 별칭에 doccomment가 있으면 그 내용을 출력하는 것이다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 `autodoc` + `alias of` 텍스트를 직접 지목한다. `_('alias of %s')` 문자열 grep → `sphinx/ext/autodoc/__init__.py`의 `ClassDocumenter` 단일 진입점으로 수렴. 다만 어느 메서드(`get_doc` vs `add_content`)에 손대야 하는지는 약간의 흐름 추적이 필요.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)**: 고칠 지점(`doc_as_attr` 분기)은 명확하나, "별칭이면 None" 이라는 무조건 단락을 "doccomment가 있으면 그것을 쓰고, 없을 때만 alias-only"라는 조건부 불변식으로 재합성해야 한다. 동시에 doccomment를 길어오는 신규 메서드 `get_variable_comment`를 도입(소규모 구조 추가)하므로 S6 보조.
- **K-Domain**: autodoc 내부의 `ModuleAnalyzer.for_module(...).attr_docs` (소스에서 파싱한 변수 주석 저장소)와 `objpath` 키 규약(`('', '.'.join(objpath))`)을 알아야 한다. 일반 파이썬 추론으로는 도달 불가 — sphinx pycode 도메인 지식이 병목.
- **Primary = T-DomainBound**: localize는 쉽지만 픽스가 `attr_docs`라는 프레임워크 내부 저장소를 정확히 조회하는 도메인 지식에 달려있다. 그래서 repair strategy도 "코드 재배열(S3)"이 아니라 도메인 불변식 추론(S2)이다.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개, gold 2개 헌크 + 신규 메서드 1개(약 +15줄). scope 자체는 작음 → T5는 과함.
- localize 직접성은 L1로 양호(`alias of` 앵커). 그러나 T2/T3가 아닌 이유는 **픽스가 K-Domain**이라는 점: `attr_docs` 저장소, `objpath` 키 포맷, `PycodeError` 예외 처리, `ModuleAnalyzer.analyze()` 호출 순서까지 맞춰야 픽스가 동작한다.
- P2P 13개가 모두 `test_ext_autodoc_autoclass.py`의 인접 동작(class doc-from, slots, properties, 기존 `test_class_alias`)이라 regression-trap이 실재 — 별칭 일반 경로의 `alias of` 출력을 깨면 안 됨.
- 공식 라벨 "1-4 hours"와 부합. 시간라벨은 도메인 저장소 탐색 비용을 반영하지만, localize 난이도는 낮으므로 T4가 적정(공식 prior 수용).

## 골드패치 분석

**파일/함수**: `sphinx/ext/autodoc/__init__.py`의 `ClassDocumenter.get_doc`, 신규 `ClassDocumenter.get_variable_comment`, `ClassDocumenter.add_content`.

**근본원인**: `get_doc`이 `if self.doc_as_attr: return None`으로 **무조건 단락**한다. 별칭으로 판정된 클래스는 docstring 수집 자체를 건너뛰어, 소스에 달린 변수 doccomment가 영원히 버려진다. 또한 `add_content`도 `doc_as_attr`이면 무조건 `alias of %s`를 더 넣어 본문을 덮는다.

**수정요지**:
1. `get_doc`: `doc_as_attr`일 때 `get_variable_comment()`를 조회해서, 주석이 있으면 `[]`(빈 docstring 리스트), 없으면 기존대로 `None` 반환. (주의: 이 FAIL_TO_PASS 경로에서는 본문이 부모 `add_content`의 `find_attr_docs()` 분기로 채워지고 `no_docstring=True`가 세팅돼 `get_doc()` 호출 자체가 스킵되므로, 이 `[]`/`None` 분기는 본문 출력과 무관한 방어적/일관성 변경이다.)
2. 신규 `get_variable_comment`: `key=('', '.'.join(self.objpath))`로 `ModuleAnalyzer.for_module(self.get_real_modname()).analyze()` 후 `analyzer.attr_docs.get(key, [])` 조회. `PycodeError`면 `None` (소스 파싱 실패 시 안전 폴백).
3. `add_content`: `if self.doc_as_attr and not self.get_variable_comment():` 로 가드 추가 — doccomment가 있으면 `alias of` 텍스트를 주입하지 않아 실제 주석이 본문이 됨.

## 검증 (test_patch)

**FAIL_TO_PASS** `test_class_alias_having_doccomment`: 픽스처 `classes.py`에 `#: docstring` + `OtherAlias = Bar`를 추가하고, `do_autodoc(app, 'class', 'target.classes.OtherAlias')`가 `py:attribute:: OtherAlias` 디렉티브 + 본문 `docstring`을 내보내는지 단언한다. 즉 별칭이지만 doccomment가 있으면 `alias of`가 아니라 주석 내용이 출력됨을 증명.

**픽스 증명**: doccomment가 있으면 `get_variable_comment`가 비어있지 않아 `ClassDocumenter.add_content`의 `if self.doc_as_attr and not self.get_variable_comment():` 가드가 거짓이 되어 `alias of` 주입을 막는다. 본문 `docstring` 자체는 부모 `Documenter.add_content`가 `find_attr_docs()`로 `key=('', 'OtherAlias')`를 조회해 직접 `add_line`하면서 채운다(이때 `no_docstring=True`로 세팅돼 뒤따르는 `if not no_docstring: docstrings = self.get_doc()` 블록은 스킵 — `get_doc`의 `[]`/`None` 반환은 이 경로에서 소비되지 않음). 따라서 이 테스트의 진짜 linchpin은 `add_content` 가드(alias-of 줄 제거)이고, `get_doc` 변경은 관찰 가능한 효과가 없는 방어적 변경에 가깝다.

**overfit/regression**: FAIL_TO_PASS는 1개로 얇지만, `[]` vs `None` 분기와 add_content 가드가 동일한 `get_variable_comment` 진리값에 묶여 special-case 누수가 적다. doccomment 없는 별칭은 `get_variable_comment`가 `[]`(falsy)라 양쪽 분기 모두 기존 동작 유지 → 기존 `test_class_alias`(P2P) 보존. `PycodeError` 폴백이 소스 없는 별칭(C확장 등)에서의 회귀를 막는다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 `alias of ...` 출력 + "type alias docstring 무시" → `sphinx/ext/autodoc` 내 `'alias of %s'` 문자열 검색 → `ClassDocumenter`. 거기서 `doc_as_attr` 분기를 가진 `get_doc`(docstring 수집)과 `add_content`(본문 주입) 두 곳이 별칭 동작을 지배함을 확인.
2. **픽스와 일반화**: 핵심은 "별칭=docstring 무시"가 너무 강한 가정이라는 것. doccomment 존재 여부로 게이팅해야 한다. `ModuleAnalyzer.attr_docs`는 sphinx가 이미 모든 변수 주석을 파싱해 둔 정본 저장소이므로, 그것을 `objpath` 키로 조회하는 게 올바른 일반화 — 특정 변수명/특정 주석 스타일에 하드코딩하지 않음. 본문 출력을 만드는 진짜 열쇠는 부모 `add_content`의 `find_attr_docs()` 분기이며, `ClassDocumenter` 픽스의 linchpin은 `add_content`의 `not self.get_variable_comment()` 가드(alias-of 줄을 본문 뒤에 붙이지 않도록 막음)다. `get_doc`의 `[]` vs `None` 구분은 이 테스트에서 소비되지 않는 일관성 변경에 가깝다.
3. **regression 안전**: P2P 13개가 같은 파일의 autoclass 동작 전반(class-doc-from/slots/properties/기존 alias). doccomment 없는 별칭은 `get_variable_comment`가 falsy라 두 분기 모두 옛 경로로 떨어져 `test_class_alias`가 그대로 통과. 이 falsy 보존이 회귀 방지의 핵심.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `add_content` 가드를 빠뜨려 `alias of` 줄이 본문 `docstring` 뒤에 그대로 남는 픽스(이 경우 본문 자체는 부모 `add_content`의 `find_attr_docs()`로 채워지므로 비지 않지만, 테스트가 기대하지 않는 `alias of` 줄이 추가돼 FAIL), (b) `attr_docs` 키 포맷(`('', dotted)`)을 틀려 항상 빈 조회, (c) `PycodeError` 미처리로 소스 없는 별칭 크래시를 내기 쉽다. 이 FAIL_TO_PASS의 진짜 linchpin은 `add_content`의 `not self.get_variable_comment()` 가드이며, `get_doc`의 `[]`/`None` 변경은 이 경로에서 관찰 효과가 없는 방어적 변경이다(인과를 뒤집어 `get_doc`를 열쇠로 보면 안 됨).
