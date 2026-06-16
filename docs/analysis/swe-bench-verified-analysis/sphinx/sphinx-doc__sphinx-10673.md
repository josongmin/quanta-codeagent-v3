---
instance_id: sphinx-doc__sphinx-10673
repo: sphinx-doc/sphinx
base_commit: f35d2a6cc726f97d0e859ca7a0e1729f7da8a6c8
version: "5.2"
difficulty: "15 min - 1 hour"
created_at: 2022-07-16T19:29:29Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [sphinx/directives/other.py, sphinx/environment/adapters/toctree.py, sphinx/environment/collectors/toctree.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, underspecified]
---

## 문제 요약
사용자가 `genindex`, `modindex`, `search`를 `.. toctree::`에 넣으면 "toctree contains reference to nonexisting document" 경고가 난다. 이 세 페이지는 실제 `.rst` 소스 파일이 아니라 Sphinx가 빌드 시 생성하는 가상(generated) 문서라서 `env.found_docs`에 없기 때문이다. 기능 요청은 이 세 generated 문서를 toctree에 등록 가능하게 하고 경고 없이 링크되도록 만드는 것이다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 3개 파일(`directives/other.py`, `adapters/toctree.py`, `collectors/toctree.py`)에 걸쳐 **조율된 채로** 함께 바뀌어야 한다. toctree 파이프라인의 파싱·해석·번호부여 3단계 각각이 generated docname을 동일하게 인지해야 한다 — 한 군데만 고치면 경고만 사라지거나 링크가 안 걸리는 반쪽 픽스가 된다.
- **S = S6 (+S5)**: 한 줄 가드가 아니라 "generated_docnames라는 새 화이트리스트 집합을 도입하고 각 단계의 멤버십 검사 식을 그 집합과 합쳐 재배치"하는 소규모 구조 변경이다. 무엇이 "정당한 toctree 엔트리"인지의 스펙을 `std` 도메인의 `initial_data['labels']`에서 재구성(S5)해야 했다.
- **K = K-Domain**: `genindex`/`modindex`/`search`가 `std` 도메인의 `initial_data['labels']`에 (docname, _, sectionname) 튜플로 등록된다는 Sphinx 내부 지식이 병목이다(std.py 클래스 레벨의 정적 3원소 리터럴 — 동적 레지스트리가 아니라 도메인 인스턴스 초기 템플릿). 일반 파이썬 추론으로는 도출 불가.
- **primary = T-DomainBound**: 진짜 난점은 "어디"보다 "어떤 Sphinx 내부 레지스트리가 이 가상 문서들의 SSOT인가"를 아는 것. 도메인 지식이 dominant. APR 관점에서 단일 조건 합성(S2)이 아니라 도메인 객체(std labels)를 끌어와 여러 site에 일관 주입하는 S6라서 generate-&-validate로 우연히 맞추기 어렵다.

## 난이도 티어
**T5 (어려움)**. 구조적 피처:
- 파일수 3 / 함수 5곳(`parse_content`, `resolve`+`_entries_from_toctree`, `assign_figure_numbers`+`_walk_doctree`) — ICLR 2024 컷에서 ≥3파일은 solve <10% 구간.
- localize 직접성 낮음(L3): 이슈는 경고 메시지만 줄 뿐, "labels 레지스트리"라는 fix-site를 전혀 지목하지 않는다(underspecified). `found_docs` 한 군데 고치고 끝낼 유혹이 강하나 그러면 번호부여(`_walk_doctree`)·해석(`_entries_from_toctree`)이 누락된다.
- regression-trap: P2P 9개가 전부 toctree 핵심 동작(glob/maxdepth/includehidden/collapse). generated_docnames를 glob 대상에 잘못 포함시키면 기존 glob 테스트가 깨진다.
- 도메인: K-Domain이 dominant.
공식 라벨은 "15분-1시간"이나, 이는 Sphinx 내부를 아는 코어 개발자의 구현시간 prior다. localize 어려움(L3)과 cross-file 조율은 시간라벨에 안 잡히므로 에이전트 난이도는 T5로 상향한다.

## 골드패치 분석
- **`sphinx/directives/other.py::TocTree.parse_content`**: `generated_docnames = frozenset(self.env.domains['std'].initial_data['labels'].keys())`를 도입. glob 후보 집합 `all_docnames`에 `| generated_docnames`로 합치되, glob 매칭 루프에서는 `if docname in generated_docnames: continue`로 **glob에는 포함하지 않음**(명시 엔트리에만 허용). 마지막으로 비존재 경고 분기 `docname not in self.env.found_docs`를 `not in self.env.found_docs | generated_docnames`로 완화 → 경고 소멸.
- **`sphinx/environment/adapters/toctree.py::TocTreeAdapter.resolve` / `_entries_from_toctree`**: `generated_docnames`를 labels 복사로 들고, 엔트리 해석에서 `elif ref in generated_docnames:` 분기 추가 — (docname, _, sectionname) 언패킹해 `nodes.reference(refuri=docname)`로 실제 인덱스 페이지 링크 노드를 만든다.
- **`sphinx/environment/collectors/toctree.py::TocTreeCollector.assign_figure_numbers` / `_walk_doctree`**: `nonlocal generated_docnames`로 끌어와 figure-number 부여 시 `if subdocname in generated_docnames: continue` — 가상 문서엔 번호 매김을 건너뜀(url/'self'와 동급 처리).
- **근본원인**: toctree 파이프라인 전 단계가 "유효 docname = `found_docs` 멤버"라는 단일 전제를 공유했는데, generated 페이지는 그 집합 밖에 존재. 수정요지는 `found_docs ∪ labels`를 새 유효성 기준으로 일관 적용하되, glob/번호부여 같은 파일기반 처리에서는 의도적으로 제외.

## 검증 (test_patch)
- 신규 testroot `test-toctree-index`(`index.rst`에 `genindex/modindex/search` 캡션 toctree + `foo.rst`에 `py:module`/`py:function`으로 modindex 트리거).
- **FAIL_TO_PASS** `test_toctree_index`: `app.build()` 후 `app.env.tocs['index']` 구조를 `assert_node`로 검증 — 두 번째 toctree 노드가 `caption="Indices"`, `entries=[(None,'genindex'),(None,'modindex'),(None,'search')]`로 보존되는지 확인. 픽스 전엔 경고+엔트리 누락으로 이 구조가 안 나옴.
- **픽스 증명**: 세 docname이 `generated_docnames` 화이트리스트를 타고 경고 분기를 통과(other.py)하고 엔트리로 등록되어 toc 구조에 살아남음을 직접 관찰.
- **overfit 관점**: FAIL_TO_PASS 1개뿐이고 `glob=False` 명시 엔트리만 검증 — glob 경로(`continue` 가드)·`_entries_from_toctree` 링크렌더·figure-number 제외는 직접 단언 안 됨. special-case로 other.py만 고쳐도 이 테스트는 통과할 수 있어 overfit 표면은 있으나, regression P2P가 그 보상을 일부 막는다.
- **regression 관점**: P2P 9개(`test_glob` 포함)가 generated_docnames의 glob 오염을 잡아준다 — `| generated_docnames`만 하고 glob `continue`를 빠뜨리면 glob 결과에 가상 문서가 섞여 `test_glob`이 RED.

## 모범답안 (오라클 기반)
1. **localize 경로**: 경고 문자열 "toctree contains reference to nonexisting document"를 grep → `sphinx/directives/other.py`의 `docname not in self.env.found_docs` 분기 단일 적중. 여기서 멈추지 말고 "왜 genindex는 found_docs에 없나"를 물어 → genindex/modindex/search가 빌더가 생성하는 special page이고 `std` 도메인 `initial_data['labels']`에 등록됨을 확인. 그 다음 같은 docname 가정을 공유하는 하류 단계(resolve의 엔트리 렌더, collector의 figure-number)를 역추적해 L3 fix-site 3개를 모두 식별.
2. **픽스와 일반화**: other.py에 리터럴 `{'genindex','modindex','search'}`를 박는 대신 `std` 도메인의 `initial_data['labels']` 키집합을 SSOT로 재사용한다. 단, `initial_data['labels']`는 std.py 클래스 레벨에 하드코딩된 정확히 3원소 정적 리터럴(genindex/modindex/search)이지 사용자 라벨로 런타임 확장되는 레지스트리가 아니다 — 따라서 '새 generated label 자동 포함' 같은 확장성 프레이밍은 부정확. 이득은 동일한 3원소 정의를 한 곳에서 재사용해 매직 리스트 중복을 없앤다는 점(SSOT)이지 동적 확장성은 아니다. 유효성 검사는 `found_docs | generated_docnames`로 확장하되, **glob과 figure-number는 의도적으로 제외**(가상 문서는 파일이 아니므로). resolve에선 (docname,_,sectionname) 언패킹으로 실제 reference 노드 생성해 링크가 실동작.
3. **regression 안전**: P2P의 `test_glob`/`test_get_toctree_for_*`를 안 깨려면 generated_docnames를 glob 후보엔 넣되 glob 매칭 결과에선 빼고, maxdepth/includehidden/collapse 경로는 명시 엔트리 처리만 건드려야 한다. labels는 `.copy()`/`frozenset`으로 읽어 원본 도메인 상태 비변형.
4. **함정 회피**: (a) other.py 경고 분기만 고치고 끝내기 → 경고는 사라져도 resolve에서 링크 노드가 안 생겨 toc 구조 미완성(FAIL_TO_PASS의 entries 단언 실패 가능). (b) `genindex` 등을 리터럴 set으로 하드코딩 → 도메인 확장성 상실(약한 일반화). (c) glob `continue` 가드 누락 → `test_glob` regression. (d) `_walk_doctree`의 `nonlocal generated_docnames`는 실은 불필요/방어적이다 — 골드패치에서 이 함수는 `generated_docnames`를 오직 *읽기*만 하고(`if subdocname in generated_docnames: continue`) 대입(`=`)이 없다. Python은 enclosing-scope 변수를 `nonlocal` 없이도 자유롭게 읽으므로, 이 선언을 빠뜨려도 '클로저 스코프 에러'는 나지 않는다(대입이 추가될 때만 필요). 즉 실재하지 않는 함정. 핵심은 "generated docname을 toctree 파이프라인 전체에 동일 기준으로 인식시키되 파일성 처리에서만 빼는" 일관 규칙을 잡는 것.
