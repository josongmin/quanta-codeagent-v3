---
instance_id: sphinx-doc__sphinx-8593
repo: sphinx-doc/sphinx
base_commit: 07983a5a8704ad91ae855218ecbda1c8598200ca
version: "3.5"
difficulty: "15 min - 1 hour"
created_at: 2020-12-27T02:41:20Z
fail_to_pass: 2
pass_to_pass: 1
gold_files: [sphinx/ext/autodoc/__init__.py, sphinx/ext/autodoc/importer.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

## 문제 요약
autodoc에서 모듈 레벨 변수에 붙인 `:meta public:` 주석이 무시된다. 예컨대 `_foo = None  #: :meta public:`는 언더스코어로 시작해 기본적으로 private 취급되는데, `:meta public:`을 달아도 `:members:` 문서에 노출되지 않는다. 함수/메서드에는 같은 `:meta public:`/`:meta private:`가 정상 동작하므로, 변수(데이터) 멤버 경로에서만 메타데이터 필터가 끊겨 있는 버그다.

## 유형 (정형화)
- **L (Localization) = L2.** 이슈는 증상("변수에 안 먹힘")만 주고 심볼을 지목하지 않는다. `:meta public:` 처리(`filter_members`의 `extract_metadata`/`isprivate` 분기)는 `__init__.py:723` 근처에 있으나, 진짜 원인은 거기가 아니라 멤버 수집 단계의 `ModuleDocumenter.get_module_members → importer.get_module_members`가 **docstring을 버리는 데이터플로우**에 있다. 수집→필터 cross-module 추적이 필요해 단순 grep으로 안 끝난다.
- **S (Repair Strategy) = S6 (+S2).** 한 줄 가드가 아니라 멤버 수집 책임을 `importer`의 자유함수에서 `ModuleDocumenter` 메서드로 옮기고, 반환 자료형을 `(name, value)` 튜플 → `ObjectMember(... docstring=...)`로 바꾸는 **작은 구조 변경(collect-with-docstring)**이다. 어떤 docstring(주석 attr_docs)을 어느 키로 붙일지는 S2적 추론을 요한다.
- **K (Knowledge) = K-Domain.** sphinx autodoc 내부(`attr_docs`, `ObjectMember`, `INSTANCEATTR`, comment-attribute 수집, deprecation alias 관례)를 알아야 한다. 일반 파이썬 추론만으론 "왜 변수만 docstring이 비는지" 못 짚는다.
- **primary = T-DomainBound.** 병목이 autodoc 멤버 모델 도메인지식이고, 픽스는 그 지식 위에서의 소규모 리팩터다. L2지만 진짜 어려움은 "어디"보다 "autodoc이 변수 docstring을 어떻게 다루는가"에 있어 T-DiffuseLoc보다 T-DomainBound가 우세.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨 "15분~1시간"과 정합. 구조적 피처:
- 파일 2개(`__init__.py`, `importer.py`), gold ~50줄 헌크 + deprecation 배선 → 1파일·<5줄 컷을 넘는다.
- localize 직접성 낮음(L2): 증상→수집 단계까지 데이터플로우를 거꾸로 따라가야 함.
- repro는 최소 예제 형태로 존재하나 네이티브 스택트레이스가 아님(빌드 산출물 누락형) → easiness 신호 약함.
- regression-trap: `:members:`/`private-members:`/`__all__`/annotation-only 멤버 경로가 모두 같은 함수를 지나므로 인접 동작 보존 부담이 큼(P2P가 정확히 그걸 지킨다). 도메인지식 + 소규모 refactor + 넓은 회귀면 → T4가 적정. T5는 멀티사이트 조율/overfit 고위험이 핵심일 때인데 여기선 단일 책임 이전이라 과대.

## 골드패치 분석
- **건드린 파일·함수:**
  - `sphinx/ext/autodoc/__init__.py` — 신규 `ModuleDocumenter.get_module_members()` 추가, `ModuleDocumenter.get_object_members()` 재작성. import에서 자유함수 `get_module_members` 제거.
  - `sphinx/ext/autodoc/importer.py` — 기존 자유함수 `get_module_members(module)`에 `RemovedInSphinx50Warning` deprecation 추가(+그 경고 import 배선).
- **근본원인:** 필터 단계 `filter_members`는 `ObjectMember.docstring`에서 `:meta public:`/`:meta private:`를 `extract_metadata`로 읽는다. 그러나 모듈 멤버 수집은 `importer.get_module_members`가 docstring 없는 `(name, value)` 튜플만 돌려줬다. 따라서 변수에 단 `#: :meta public:` 주석(소스 분석기 `attr_docs`에 잡힘)이 멤버 객체에 실리지 못해 메타데이터가 소실 → 언더스코어 변수는 끝까지 private로 남았다.
- **수정요지:** 새 `get_module_members`가 `self.analyzer.attr_docs`를 읽어 각 멤버를 `ObjectMember(name, value, docstring="\n".join(...))`로 만든다(annotation-only 멤버는 `INSTANCEATTR`로). `get_object_members`는 이 `Dict[str, ObjectMember]`를 받아 `__all__` 스킵을 `member.skipped`로 표시하고, 지정 멤버 조회를 `safe_getattr` 재시도 대신 dict lookup으로 단순화. 즉 docstring을 수집 시점부터 멤버에 동반시켜 하류 필터가 메타데이터를 볼 수 있게 한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):**
  - `test_private_field` — fixture에 `_PUBLIC_CONSTANT = None  #: :meta public:` 추가. 픽스 전엔 언더스코어 변수라 누락, 후엔 `.. py:data:: _PUBLIC_CONSTANT`가 출력에 등장해야 통과.
  - `test_private_members` — `private-members: "_PUBLIC_CONSTANT,_public_function"`로 변수도 명시 노출되는지 확인.
- **픽스 증명:** 두 테스트는 변수의 `:meta public:`/명시 private-members가 실제 산출 RST에 반영되는지를 expect 리스트 정확매칭으로 검사한다. docstring이 `ObjectMember`에 실려야만 `filter_members`의 `'public' in metadata` 분기가 `isprivate=False`로 가서 노출되므로, 수집-경로 수정이 곧 통과 조건.
- **PASS_TO_PASS (1):** `test_private_field_and_private_members`는 `PRIVATE_CONSTANT(:meta private:)`와 `_PUBLIC_CONSTANT(:meta public:)`가 `private-members: None`(전체)에서 둘 다 나오는 기존 동작을 고정 → 수집 자료형을 바꾸면서 private/public/annotation/`__all__` 경로를 깨면 안 됨을 보장.
- **overfit·regression 관점:** FAIL_TO_PASS가 2개로 얇지만 변수 메타데이터 한 축에 집중. special-case(예: 이름 하드코딩)로 통과시키면 P2P의 혼합 시나리오에서 깨진다. overfit-risk는 중간, regression-trap이 더 큰 위험.

## 모범답안 (오라클 기반)
1. **localize:** 증상은 "함수엔 되는데 변수엔 안 됨". `:meta public:` 처리 지점(`extract_metadata`, `__init__.py`의 `isprivate` 분기)을 먼저 찾고, 거기로 들어오는 멤버가 docstring을 갖는지 역추적. 함수 멤버는 `getdoc`/`ObjectMember.docstring`으로 doc을 갖지만, 모듈 변수 멤버는 `importer.get_module_members`가 `(name, value)`만 반환함을 확인 → 수집 단계가 진범.
2. **픽스(올바른 일반화):** "변수만 누락"의 본질은 docstring 유실이므로, 단일 변수에 가드를 박는 대신 수집기를 `attr_docs` 기반 docstring을 실은 `ObjectMember`로 통일한다. `ModuleDocumenter.get_module_members` 도입은 클래스 멤버 경로(이미 ObjectMember 사용)와 모델을 정렬시키는 일반화라 public/private/annotation/`__all__` 전부에 동작 → special-case 아님.
3. **regression 안전:** `__all__` 스킵(`skipped=True`), annotation-only 멤버(`INSTANCEATTR`), `:members:` 명시 조회, private 기본 숨김이 모두 한 함수를 통과하므로 자료형 전환 시 이 4경로의 출력 동치를 유지해야 한다. P2P `test_private_field_and_private_members`가 이 혼합을 지킨다.
4. **함정 회피:** (a) 필터(`__init__.py:723`)만 보고 거기서 변수 분기를 넣으면 docstring이 애초에 없어 무효 — 수집 단계를 안 고치면 못 푼다. (b) `importer.get_module_members`를 in-place로 바꾸면 공개 API라 하위호환이 깨짐 → 골드는 자유함수를 **deprecate(RemovedInSphinx50Warning)**하고 Documenter 메서드로 이전하는 K-API 관례를 지킨다. 이 deprecation 배선을 빼면 라이브러리 계약 위반.
